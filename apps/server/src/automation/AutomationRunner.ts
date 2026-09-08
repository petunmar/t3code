// @effect-diagnostics globalDate:off globalDateInEffect:off -- CRON and timezone formatting use native Date boundaries.
import {
  AutomationId,
  type AutomationId as AutomationIdType,
  AutomationRpcError,
  type AutomationRunSummary,
  type AutomationRunTrigger,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as BootstrapTurnLauncher from "../orchestration/BootstrapTurnLauncher.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as AutomationService from "./AutomationService.ts";

const isAutomationRpcError = Schema.is(AutomationRpcError);

export interface AutomationOccurrence {
  readonly automationId: AutomationIdType;
  readonly trigger: AutomationRunTrigger;
  readonly scheduledFor: string;
  readonly triggeredAt: string;
  readonly coalescedThrough: string | null;
  readonly missedOccurrences: { readonly value: number; readonly exact: boolean };
  readonly nextRunAt?: string;
  readonly occurrenceKey: string;
}

function formatRunTitle(name: string, at: string, timeZone: string): string {
  const stamp = new Intl.DateTimeFormat(undefined, {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(at));
  return `${name} · ${stamp}`;
}

function launchError(cause: unknown): AutomationRpcError {
  return isAutomationRpcError(cause)
    ? cause
    : new AutomationRpcError({
        code: "launch-error",
        message: cause instanceof Error ? cause.message : "Failed to launch Automation run.",
      });
}

const make = Effect.gen(function* () {
  const service = yield* AutomationService.AutomationService;
  const launcher = yield* BootstrapTurnLauncher.BootstrapTurnLauncher;
  const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const uuid = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      () =>
        new AutomationRpcError({
          code: "launch-error",
          message: "Failed to allocate Automation run identifiers.",
        }),
    ),
  );

  const runOccurrence = Effect.fn("AutomationRunner.runOccurrence")(function* (
    occurrence: AutomationOccurrence,
  ): Effect.fn.Return<AutomationRunSummary, AutomationRpcError> {
    const claimed = yield* service.claimRun(occurrence);
    if (claimed.run.status === "skipped") return claimed.run;

    const launch = Effect.gen(function* () {
      const threadId = ThreadId.make(yield* uuid);
      const messageId = MessageId.make(yield* uuid);
      const commandId = CommandId.make(`automation:${claimed.run.id}:${yield* uuid}`);
      const projectOption = yield* projection.getProjectShellById(
        ProjectId.make(claimed.automation.projectId),
      );
      if (Option.isNone(projectOption)) {
        return yield* new AutomationRpcError({
          code: "invalid-configuration",
          message: "The selected project no longer exists in this environment.",
        });
      }
      const project = projectOption.value;
      const attachments = yield* service.materializeAttachments(claimed.automation, threadId);
      const workspace = claimed.automation.workspace;
      const branch =
        workspace.kind === "new-worktree"
          ? buildTemporaryWorktreeBranchName(() => claimed.run.id)
          : workspace.expectedBranch;
      const worktreePath = workspace.kind === "existing-worktree" ? workspace.worktreePath : null;
      const prepareWorktree =
        workspace.kind === "new-worktree"
          ? {
              projectCwd: project.workspaceRoot,
              baseBranch: workspace.fromBranch,
              branch: buildTemporaryWorktreeBranchName(() => claimed.run.id),
              ...(workspace.startFromOrigin ? { startFromOrigin: true } : {}),
            }
          : undefined;
      const title = formatRunTitle(
        claimed.automation.name,
        occurrence.scheduledFor,
        claimed.automation.schedule.timeZone,
      );

      yield* launcher.dispatch({
        type: "thread.turn.start",
        commandId,
        threadId,
        message: {
          messageId,
          role: "user",
          text: claimed.automation.message.text,
          attachments,
        },
        modelSelection: claimed.automation.modelSelection,
        titleSeed: claimed.automation.name,
        runtimeMode: claimed.automation.runtimeMode,
        interactionMode: claimed.automation.interactionMode,
        bootstrap: {
          createThread: {
            projectId: claimed.automation.projectId,
            title,
            modelSelection: claimed.automation.modelSelection,
            runtimeMode: claimed.automation.runtimeMode,
            interactionMode: claimed.automation.interactionMode,
            origin: {
              type: "automation",
              automationId: claimed.automation.id,
              automationRunId: claimed.run.id,
              automationName: claimed.automation.name,
              trigger: occurrence.trigger,
              scheduledFor: occurrence.scheduledFor,
              timeZone: claimed.automation.schedule.timeZone,
            },
            branch,
            worktreePath,
            createdAt: occurrence.triggeredAt,
          },
          ...(prepareWorktree === undefined ? {} : { prepareWorktree, runSetupScript: true }),
        },
        createdAt: occurrence.triggeredAt,
      });

      return yield* service.linkRun({
        automationId: claimed.automation.id,
        runId: claimed.run.id,
        threadId,
      });
    });

    return yield* launch.pipe(
      Effect.mapError(launchError),
      Effect.catch((error) =>
        service
          .failRun({
            automationId: claimed.automation.id,
            runId: claimed.run.id,
            detail: error.message,
            ...(error.code === "invalid-configuration" ? { configurationError: true } : {}),
          })
          .pipe(Effect.andThen(Effect.fail(error))),
      ),
    );
  });

  const runNow = Effect.fn("AutomationRunner.runNow")(function* (input: {
    readonly id: AutomationIdType;
  }) {
    const triggeredAt = DateTime.formatIso(yield* DateTime.now);
    const occurrenceKey = `manual:${yield* uuid}`;
    return yield* runOccurrence({
      automationId: AutomationId.make(input.id),
      trigger: "manual",
      scheduledFor: triggeredAt,
      triggeredAt,
      coalescedThrough: null,
      missedOccurrences: { value: 1, exact: true },
      occurrenceKey,
    });
  });

  return { runOccurrence, runNow };
});

export class AutomationRunner extends Context.Service<
  AutomationRunner,
  Effect.Success<typeof make>
>()("t3/automation/AutomationRunner") {}

export const layer = Layer.effect(AutomationRunner, make);
