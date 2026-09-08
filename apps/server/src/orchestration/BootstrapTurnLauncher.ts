import {
  CommandId,
  EventId,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";

type BootstrapTurnStart = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

const isDispatchError = Schema.is(OrchestrationDispatchCommandError);
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function setupFailureDetail(error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError): string {
  switch (error._tag) {
    case "ProjectSetupScriptOperationError": {
      const cause = error.cause;
      if (
        typeof cause === "object" &&
        cause !== null &&
        "message" in cause &&
        typeof cause.message === "string"
      ) {
        return cause.message;
      }
      return String(cause);
    }
    case "ProjectSetupScriptProjectNotFoundError":
      return "Project was not found for setup script execution.";
  }
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;

  const toDispatchError = (cause: unknown, fallbackMessage: string) =>
    isDispatchError(cause)
      ? cause
      : new OrchestrationDispatchCommandError({
          message: cause instanceof Error ? cause.message : fallbackMessage,
          cause,
        });
  const randomUuid = crypto.randomUUIDv4.pipe(
    Effect.mapError((cause) =>
      toDispatchError(cause, "Failed to generate orchestration command identifier."),
    ),
  );
  const commandId = (tag: string) =>
    randomUuid.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const eventId = randomUuid.pipe(Effect.map(EventId.make));

  const appendSetupActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
    readonly summary: string;
    readonly createdAt: string;
    readonly payload: Record<string, unknown>;
    readonly tone: "info" | "error";
  }) =>
    Effect.all({ commandId: commandId("setup-script-activity"), activityId: eventId }).pipe(
      Effect.flatMap(({ commandId: nextCommandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: nextCommandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: input.tone,
            kind: input.kind,
            summary: input.summary,
            payload: input.payload,
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const dispatch = Effect.fn("BootstrapTurnLauncher.dispatch")(function* (
    command: BootstrapTurnStart,
  ) {
    const bootstrap = command.bootstrap;
    const { bootstrap: _bootstrap, ...turnStartCommand } = command;
    let createdThread = false;
    let targetProjectId = bootstrap?.createThread?.projectId;
    let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
    let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

    const cleanupCreatedThread = () =>
      createdThread
        ? commandId("bootstrap-thread-delete").pipe(
            Effect.flatMap((nextCommandId) =>
              orchestrationEngine.dispatch({
                type: "thread.delete",
                commandId: nextCommandId,
                threadId: command.threadId,
              }),
            ),
            Effect.ignoreCause({ log: true }),
          )
        : Effect.void;

    const recordSetupFailure = (input: {
      readonly error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError;
      readonly requestedAt: string;
      readonly worktreePath: string;
    }) => {
      const detail = setupFailureDetail(input.error);
      return appendSetupActivity({
        threadId: command.threadId,
        kind: "setup-script.failed",
        summary: "Setup script failed to start",
        createdAt: input.requestedAt,
        payload: { detail, worktreePath: input.worktreePath },
        tone: "error",
      }).pipe(
        Effect.ignoreCause({ log: false }),
        Effect.andThen(
          Effect.logWarning("bootstrap turn start failed to launch setup script", {
            threadId: command.threadId,
            worktreePath: input.worktreePath,
            detail,
          }),
        ),
      );
    };

    const recordSetupStarted = (input: {
      readonly requestedAt: string;
      readonly worktreePath: string;
      readonly scriptId: string;
      readonly scriptName: string;
      readonly terminalId: string;
    }) =>
      Effect.gen(function* () {
        const startedAt = yield* nowIso;
        const payload = {
          scriptId: input.scriptId,
          scriptName: input.scriptName,
          terminalId: input.terminalId,
          worktreePath: input.worktreePath,
        };
        yield* Effect.all([
          appendSetupActivity({
            threadId: command.threadId,
            kind: "setup-script.requested",
            summary: "Starting setup script",
            createdAt: input.requestedAt,
            payload,
            tone: "info",
          }),
          appendSetupActivity({
            threadId: command.threadId,
            kind: "setup-script.started",
            summary: "Setup script started",
            createdAt: startedAt,
            payload,
            tone: "info",
          }),
        ]).pipe(
          Effect.asVoid,
          Effect.catch((error) =>
            Effect.logWarning(
              "bootstrap turn start launched setup script but failed to record setup activity",
              {
                threadId: command.threadId,
                worktreePath: input.worktreePath,
                scriptId: input.scriptId,
                terminalId: input.terminalId,
                detail: error.message,
              },
            ),
          ),
        );
      });

    const runSetupProgram = Effect.gen(function* () {
      if (!bootstrap?.runSetupScript || !targetWorktreePath) return;
      const worktreePath = targetWorktreePath;
      const requestedAt = yield* nowIso;
      yield* projectSetupScriptRunner
        .runForThread({
          threadId: command.threadId,
          ...(targetProjectId ? { projectId: targetProjectId } : {}),
          ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
          worktreePath,
        })
        .pipe(
          Effect.matchEffect({
            onFailure: (error) => recordSetupFailure({ error, requestedAt, worktreePath }),
            onSuccess: (result) =>
              result.status === "started"
                ? recordSetupStarted({
                    requestedAt,
                    worktreePath,
                    scriptId: result.scriptId,
                    scriptName: result.scriptName,
                    terminalId: result.terminalId,
                  })
                : Effect.void,
          }),
        );
    });

    const program = Effect.gen(function* () {
      if (bootstrap?.createThread) {
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: yield* commandId("bootstrap-thread-create"),
          threadId: command.threadId,
          projectId: bootstrap.createThread.projectId,
          title: bootstrap.createThread.title,
          modelSelection: bootstrap.createThread.modelSelection,
          runtimeMode: bootstrap.createThread.runtimeMode,
          interactionMode: bootstrap.createThread.interactionMode,
          origin: bootstrap.createThread.origin ?? null,
          branch: bootstrap.createThread.branch,
          worktreePath: bootstrap.createThread.worktreePath,
          createdAt: bootstrap.createThread.createdAt,
        });
        createdThread = true;
      }

      if (bootstrap?.prepareWorktree) {
        let worktreeBaseRef = bootstrap.prepareWorktree.baseBranch;
        const startFromOrigin =
          bootstrap.prepareWorktree.startFromOrigin === true &&
          (yield* gitWorkflow.remoteExists({
            cwd: bootstrap.prepareWorktree.projectCwd,
            remoteName: "origin",
          }));
        if (startFromOrigin) {
          yield* gitWorkflow.fetchRemote({
            cwd: bootstrap.prepareWorktree.projectCwd,
            remoteName: "origin",
          });
          const resolved = yield* gitWorkflow.resolveRemoteTrackingCommit({
            cwd: bootstrap.prepareWorktree.projectCwd,
            refName: bootstrap.prepareWorktree.baseBranch,
            fallbackRemoteName: "origin",
          });
          worktreeBaseRef = resolved.commitSha;
        }
        const worktree = yield* gitWorkflow.createWorktree({
          cwd: bootstrap.prepareWorktree.projectCwd,
          refName: worktreeBaseRef,
          newRefName: bootstrap.prepareWorktree.branch,
          baseRefName: bootstrap.prepareWorktree.baseBranch,
          path: null,
        });
        targetWorktreePath = worktree.worktree.path;
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: yield* commandId("bootstrap-thread-meta-update"),
          threadId: command.threadId,
          branch: worktree.worktree.refName,
          worktreePath: targetWorktreePath,
        });
        yield* vcsStatusBroadcaster
          .refreshStatus(targetWorktreePath)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);
      }

      yield* runSetupProgram;
      return yield* orchestrationEngine.dispatch(turnStartCommand);
    });

    return yield* program.pipe(
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause);
        const dispatchError = toDispatchError(error, "Failed to bootstrap thread turn start.");
        if (Cause.hasInterruptsOnly(cause)) return Effect.fail(dispatchError);
        return cleanupCreatedThread().pipe(Effect.andThen(Effect.fail(dispatchError)));
      }),
    );
  });

  return { dispatch };
});

export class BootstrapTurnLauncher extends Context.Service<
  BootstrapTurnLauncher,
  Effect.Success<typeof make>
>()("t3/orchestration/BootstrapTurnLauncher") {}

export const layer = Layer.effect(BootstrapTurnLauncher, make);
