// @effect-diagnostics globalDate:off globalDateInEffect:off preferSchemaOverJson:off -- Croner and SQL JSON columns use native boundary representations.
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  AutomationDetail,
  AutomationId,
  type AutomationId as AutomationIdType,
  type AutomationCreateInput,
  type AutomationRevisionInput,
  AutomationRpcError,
  AutomationRunId,
  type AutomationRunId as AutomationRunIdType,
  type AutomationRunsPage,
  type AutomationRunsPageInput,
  type AutomationRunStatus,
  type AutomationRunSummary,
  type AutomationRunTrigger,
  type AutomationSnapshot,
  type AutomationStreamEvent,
  type AutomationSummary,
  type AutomationUpdateInput,
  ChatAttachment,
  ModelSelection,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  type ThreadId as ThreadIdType,
  AutomationWorkspace,
} from "@t3tools/contracts";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import { nextAutomationRunAt, parseAutomationSchedule, previewAutomationSchedule } from "./cron.ts";
import { subscribeBeforeSnapshotWithoutMutex } from "../utils/subscribeBeforeSnapshot.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const AutomationDbRow = Schema.Struct({
  id: AutomationId,
  projectId: Schema.String,
  name: Schema.String,
  messageText: Schema.String,
  attachments: Schema.fromJsonString(Schema.Array(ChatAttachment)),
  modelSelection: Schema.fromJsonString(ModelSelection),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspace: Schema.fromJsonString(AutomationWorkspace),
  cronExpression: Schema.String,
  timeZone: Schema.String,
  enabled: Schema.Number,
  pauseReason: Schema.NullOr(Schema.Literals(["user", "configuration-error"])),
  pauseDetail: Schema.NullOr(Schema.String),
  nextRunAt: Schema.NullOr(Schema.String),
  revision: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  deletedAt: Schema.NullOr(Schema.String),
});
type AutomationDbRow = typeof AutomationDbRow.Type;
const decodeAutomationDbRow = Schema.decodeUnknownEffect(AutomationDbRow);

const AutomationRunDbRow = Schema.Struct({
  id: AutomationRunId,
  automationId: AutomationId,
  threadId: Schema.NullOr(ThreadId),
  trigger: Schema.Literals(["scheduled", "catch-up", "manual"]),
  storedStatus: Schema.Literals(["launching", "running", "failed", "skipped"]),
  scheduledFor: Schema.String,
  triggeredAt: Schema.String,
  coalescedThrough: Schema.NullOr(Schema.String),
  missedOccurrences: Schema.Number,
  missedOccurrencesExact: Schema.Number,
  definitionRevision: Schema.Number,
  detail: Schema.NullOr(Schema.String),
  sessionStatus: Schema.NullOr(Schema.String),
  turnState: Schema.NullOr(Schema.String),
  pendingApprovalCount: Schema.NullOr(Schema.Number),
  pendingUserInputCount: Schema.NullOr(Schema.Number),
  threadDeletedAt: Schema.NullOr(Schema.String),
});
type AutomationRunDbRow = typeof AutomationRunDbRow.Type;
const decodeAutomationRunDbRow = Schema.decodeUnknownEffect(AutomationRunDbRow);
const decodeChatAttachment = Schema.decodeUnknownEffect(ChatAttachment);
const isAutomationRpcError = Schema.is(AutomationRpcError);

function storageError(message: string): AutomationRpcError {
  return new AutomationRpcError({ code: "storage-error", message });
}

function decodeError(message: string) {
  return (cause: unknown) =>
    new AutomationRpcError({
      code: "storage-error",
      message: cause instanceof Error ? `${message}: ${cause.message}` : message,
    });
}

function toDetail(row: AutomationDbRow): AutomationDetail {
  return {
    id: row.id,
    projectId: row.projectId as AutomationDetail["projectId"],
    name: row.name,
    message: { text: row.messageText, attachments: row.attachments },
    modelSelection: row.modelSelection,
    runtimeMode: row.runtimeMode,
    interactionMode: row.interactionMode,
    workspace: row.workspace,
    schedule: { cronExpression: row.cronExpression, timeZone: row.timeZone },
    enabled: row.enabled !== 0,
    pauseReason: row.pauseReason,
    pauseDetail: row.pauseDetail,
    nextRunAt: row.nextRunAt,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function deriveRunStatus(row: AutomationRunDbRow): AutomationRunStatus {
  if (row.storedStatus === "failed" || row.storedStatus === "skipped") {
    return row.storedStatus;
  }
  if (row.threadId === null) {
    return "launching";
  }
  if ((row.pendingApprovalCount ?? 0) > 0 || (row.pendingUserInputCount ?? 0) > 0) {
    return "waiting";
  }
  if (row.sessionStatus === "starting" || row.sessionStatus === "running") {
    return "running";
  }
  if (row.turnState === "error" || row.sessionStatus === "error") {
    return "failed";
  }
  if (row.turnState === "interrupted" || row.sessionStatus === "interrupted") {
    return "interrupted";
  }
  if (
    row.turnState === "completed" ||
    row.sessionStatus === "idle" ||
    row.sessionStatus === "ready" ||
    row.sessionStatus === "stopped" ||
    row.threadDeletedAt !== null
  ) {
    return "completed";
  }
  return "running";
}

function toRunSummary(row: AutomationRunDbRow): AutomationRunSummary {
  return {
    id: row.id,
    automationId: row.automationId,
    threadId: row.threadId,
    trigger: row.trigger,
    status: deriveRunStatus(row),
    scheduledFor: row.scheduledFor,
    triggeredAt: row.triggeredAt,
    coalescedThrough: row.coalescedThrough,
    missedOccurrences: {
      value: Math.max(1, row.missedOccurrences),
      exact: row.missedOccurrencesExact !== 0,
    },
    definitionRevision: Math.max(1, row.definitionRevision),
    detail: row.detail,
  };
}

export interface ClaimAutomationRunInput {
  readonly automationId: AutomationIdType;
  readonly trigger: AutomationRunTrigger;
  readonly scheduledFor: string;
  readonly triggeredAt: string;
  readonly coalescedThrough: string | null;
  readonly missedOccurrences: { readonly value: number; readonly exact: boolean };
  readonly nextRunAt?: string;
  readonly occurrenceKey: string;
}

export interface ClaimedAutomationRun {
  readonly run: AutomationRunSummary;
  readonly automation: AutomationDetail;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const changes = yield* PubSub.unbounded<AutomationStreamEvent>();

  const randomId = Effect.fn("AutomationService.randomId")(function* <A>(
    make: (value: string) => A,
  ) {
    return make(yield* crypto.randomUUIDv4);
  });

  const getGlobalRevision = Effect.fn("AutomationService.getGlobalRevision")(function* () {
    const rows = yield* sql<{ readonly revision: number }>`
          SELECT revision FROM automation_state WHERE singleton = 1
        `;
    return rows[0]?.revision ?? 0;
  });

  const bumpGlobalRevision = Effect.fn("AutomationService.bumpGlobalRevision")(function* () {
    const rows = yield* sql<{ readonly revision: number }>`
          UPDATE automation_state
          SET revision = revision + 1
          WHERE singleton = 1
          RETURNING revision
        `;
    return rows[0]?.revision ?? 0;
  });

  const interruptedLaunches = yield* sql<{ readonly id: string }>`
        UPDATE automation_runs
        SET status = 'failed',
            detail = COALESCE(detail, 'The environment stopped while this run was starting.')
        WHERE status = 'launching' AND thread_id IS NULL
        RETURNING run_id AS id
      `;
  if (interruptedLaunches.length > 0) {
    yield* bumpGlobalRevision();
  }

  const selectAutomationRows = (where: "all" | "one", id?: AutomationIdType) =>
    sql<{
      readonly id: string;
      readonly projectId: string;
      readonly name: string;
      readonly messageText: string;
      readonly attachments: string;
      readonly modelSelection: string;
      readonly runtimeMode: string;
      readonly interactionMode: string;
      readonly workspace: string;
      readonly cronExpression: string;
      readonly timeZone: string;
      readonly enabled: number;
      readonly pauseReason: string | null;
      readonly pauseDetail: string | null;
      readonly nextRunAt: string | null;
      readonly revision: number;
      readonly createdAt: string;
      readonly updatedAt: string;
      readonly deletedAt: string | null;
    }>`
          SELECT
            automation_id AS "id",
            project_id AS "projectId",
            name,
            message_text AS "messageText",
            attachments_json AS "attachments",
            model_selection_json AS "modelSelection",
            runtime_mode AS "runtimeMode",
            interaction_mode AS "interactionMode",
            workspace_json AS "workspace",
            cron_expression AS "cronExpression",
            time_zone AS "timeZone",
            enabled,
            pause_reason AS "pauseReason",
            pause_detail AS "pauseDetail",
            next_run_at AS "nextRunAt",
            revision,
            created_at AS "createdAt",
            updated_at AS "updatedAt",
            deleted_at AS "deletedAt"
          FROM automations
          WHERE deleted_at IS NULL
            AND (${where === "all" ? null : (id ?? null)} IS NULL OR automation_id = ${
              where === "all" ? null : (id ?? null)
            })
          ORDER BY created_at ASC, automation_id ASC
        `;

  const decodeAutomationRows = Effect.fn("AutomationService.decodeAutomationRows")(function* (
    rows: ReadonlyArray<unknown>,
  ) {
    return yield* Effect.forEach(rows, (row) =>
      decodeAutomationDbRow(row).pipe(Effect.mapError(decodeError("Invalid Automation row"))),
    );
  });

  const getAutomation = Effect.fn("AutomationService.getAutomation")(function* (
    id: AutomationIdType,
  ) {
    const rows = yield* selectAutomationRows("one", id).pipe(
      Effect.mapError(() => storageError("Failed to load Automation.")),
    );
    const decoded = yield* decodeAutomationRows(rows);
    const row = decoded[0];
    if (!row) {
      return yield* new AutomationRpcError({
        code: "not-found",
        message: "Automation not found.",
      });
    }
    return toDetail(row);
  });

  const selectRunRows = (input: {
    readonly automationId: AutomationIdType;
    readonly runId?: AutomationRunIdType;
    readonly occurrenceKey?: string;
    readonly before?: string;
    readonly limit: number;
    readonly onlyActive?: boolean;
  }) =>
    sql<{
      readonly id: string;
      readonly automationId: string;
      readonly threadId: string | null;
      readonly trigger: string;
      readonly storedStatus: string;
      readonly scheduledFor: string;
      readonly triggeredAt: string;
      readonly coalescedThrough: string | null;
      readonly missedOccurrences: number;
      readonly missedOccurrencesExact: number;
      readonly definitionRevision: number;
      readonly detail: string | null;
      readonly sessionStatus: string | null;
      readonly turnState: string | null;
      readonly pendingApprovalCount: number | null;
      readonly pendingUserInputCount: number | null;
      readonly threadDeletedAt: string | null;
    }>`
          SELECT
            runs.run_id AS "id",
            runs.automation_id AS "automationId",
            runs.thread_id AS "threadId",
            runs.trigger,
            runs.status AS "storedStatus",
            runs.scheduled_for AS "scheduledFor",
            runs.triggered_at AS "triggeredAt",
            runs.coalesced_through AS "coalescedThrough",
            runs.missed_occurrences AS "missedOccurrences",
            runs.missed_occurrences_exact AS "missedOccurrencesExact",
            runs.definition_revision AS "definitionRevision",
            COALESCE(runs.detail, sessions.last_error) AS detail,
            sessions.status AS "sessionStatus",
            turns.state AS "turnState",
            threads.pending_approval_count AS "pendingApprovalCount",
            threads.pending_user_input_count AS "pendingUserInputCount",
            threads.deleted_at AS "threadDeletedAt"
          FROM automation_runs AS runs
          LEFT JOIN projection_threads AS threads ON threads.thread_id = runs.thread_id
          LEFT JOIN projection_thread_sessions AS sessions ON sessions.thread_id = runs.thread_id
          LEFT JOIN projection_turns AS turns
            ON turns.thread_id = runs.thread_id
           AND turns.turn_id = threads.latest_turn_id
          WHERE runs.automation_id = ${input.automationId}
            AND (${input.runId ?? null} IS NULL OR runs.run_id = ${input.runId ?? null})
            AND (${input.occurrenceKey ?? null} IS NULL OR runs.occurrence_key = ${input.occurrenceKey ?? null})
            AND (${input.before ?? null} IS NULL OR runs.triggered_at < ${input.before ?? null})
            AND (
              ${input.onlyActive === true ? 1 : 0} = 0
              OR (
                runs.status IN ('launching', 'running')
                AND (
                  runs.thread_id IS NULL
                  OR COALESCE(threads.pending_approval_count, 0) > 0
                  OR COALESCE(threads.pending_user_input_count, 0) > 0
                  OR sessions.status IN ('starting', 'running')
                  OR (
                    COALESCE(turns.state, '') NOT IN ('error', 'interrupted', 'completed')
                    AND COALESCE(sessions.status, '') NOT IN ('error', 'interrupted', 'idle', 'ready', 'stopped')
                    AND threads.deleted_at IS NULL
                  )
                )
              )
            )
          ORDER BY runs.triggered_at DESC, runs.run_id DESC
          LIMIT ${input.limit}
        `;

  const decodeRunRows = Effect.fn("AutomationService.decodeRunRows")(function* (
    rows: ReadonlyArray<unknown>,
  ) {
    return yield* Effect.forEach(rows, (row) =>
      decodeAutomationRunDbRow(row).pipe(
        Effect.mapError(decodeError("Invalid Automation run row")),
        Effect.map(toRunSummary),
      ),
    );
  });

  const getRunsPage = Effect.fn("AutomationService.getRunsPage")(function* (
    input: AutomationRunsPageInput,
  ): Effect.fn.Return<AutomationRunsPage, AutomationRpcError> {
    yield* getAutomation(input.automationId);
    const limit = input.limit ?? 25;
    const rows = yield* selectRunRows({
      automationId: input.automationId,
      ...(input.before === undefined ? {} : { before: input.before }),
      limit: limit + 1,
    }).pipe(Effect.mapError(() => storageError("Failed to load Automation runs.")));
    const runs = yield* decodeRunRows(rows);
    return {
      runs: runs.slice(0, limit),
      nextCursor: runs.length > limit ? (runs[limit - 1]?.triggeredAt ?? null) : null,
    };
  });

  const toSummary = Effect.fn("AutomationService.toSummary")(function* (
    detail: AutomationDetail,
  ): Effect.fn.Return<AutomationSummary, AutomationRpcError> {
    const runs = yield* getRunsPage({ automationId: detail.id, limit: 1 });
    const last = runs.runs[0] ?? null;
    const { message: _message, ...definition } = detail;
    return {
      ...definition,
      lastRun:
        last === null
          ? null
          : {
              runId: last.id,
              status: last.status,
              triggeredAt: last.triggeredAt,
              threadId: last.threadId,
              detail: last.detail,
            },
    };
  });

  const getSnapshot = Effect.fn("AutomationService.getSnapshot")(function* (): Effect.fn.Return<
    AutomationSnapshot,
    AutomationRpcError
  > {
    const [rows, revision] = yield* Effect.all([
      selectAutomationRows("all").pipe(
        Effect.mapError(() => storageError("Failed to load Automations.")),
      ),
      getGlobalRevision().pipe(
        Effect.mapError(() => storageError("Failed to load Automation revision.")),
      ),
    ]);
    const decoded = yield* decodeAutomationRows(rows);
    const automations = yield* Effect.forEach(decoded, (row) => toSummary(toDetail(row)));
    return { revision, automations };
  });

  const projectExists = Effect.fn("AutomationService.projectExists")(function* (projectId: string) {
    const rows = yield* sql<{ readonly found: number }>`
            SELECT 1 AS found
            FROM projection_projects
            WHERE project_id = ${projectId} AND deleted_at IS NULL
            LIMIT 1
          `.pipe(Effect.mapError(() => storageError("Failed to validate Automation project.")));
    return rows.length > 0;
  });

  const validateWrite = Effect.fn("AutomationService.validateWrite")(function* (
    input: AutomationCreateInput | AutomationUpdateInput,
  ) {
    yield* Effect.try({
      try: () => parseAutomationSchedule(input.schedule),
      catch: (cause) =>
        isAutomationRpcError(cause)
          ? cause
          : new AutomationRpcError({
              code: "invalid-schedule",
              message: "Invalid Automation schedule.",
            }),
    });
    if (!(yield* projectExists(input.projectId))) {
      return yield* new AutomationRpcError({
        code: "invalid-configuration",
        message: "The selected project no longer exists in this environment.",
      });
    }
  });

  const persistAttachments = Effect.fn("AutomationService.persistAttachments")(function* (
    automationId: AutomationIdType,
    writes: AutomationCreateInput["message"]["attachments"],
    existing: ReadonlyArray<ChatAttachment>,
  ) {
    const existingById = new Map(existing.map((attachment) => [attachment.id, attachment]));
    return yield* Effect.forEach(
      writes,
      (write) =>
        Effect.gen(function* () {
          if (write.kind === "retained") {
            const attachment = existingById.get(write.attachmentId);
            if (!attachment) {
              return yield* new AutomationRpcError({
                code: "invalid-configuration",
                message: `Saved attachment '${write.attachmentId}' was not found.`,
              });
            }
            return attachment;
          }

          const upload = write.attachment;
          const parsed = parseBase64DataUrl(upload.dataUrl);
          if (
            !parsed ||
            (upload.type === "image" && !parsed.mimeType.toLowerCase().startsWith("image/"))
          ) {
            return yield* new AutomationRpcError({
              code: "invalid-configuration",
              message: `Invalid ${upload.type} attachment '${upload.name}'.`,
            });
          }
          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
            return yield* new AutomationRpcError({
              code: "invalid-configuration",
              message: `Attachment '${upload.name}' is empty or too large.`,
            });
          }
          const attachmentId = createAttachmentId(`automation-${automationId}`);
          if (!attachmentId) {
            return yield* storageError("Failed to create an Automation attachment id.");
          }
          const attachment = yield* decodeChatAttachment({
            type: upload.type,
            id: attachmentId,
            name: upload.name,
            mimeType: parsed.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
          }).pipe(Effect.mapError(decodeError("Invalid Automation attachment metadata")));
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
            return yield* storageError(`Failed to resolve attachment '${upload.name}'.`);
          }
          yield* fileSystem
            .makeDirectory(path.dirname(attachmentPath), { recursive: true })
            .pipe(
              Effect.mapError(() => storageError("Failed to create the attachment directory.")),
            );
          yield* fileSystem
            .writeFile(attachmentPath, bytes)
            .pipe(
              Effect.mapError(() => storageError(`Failed to save attachment '${upload.name}'.`)),
            );
          return attachment;
        }),
      { concurrency: 1 },
    );
  });

  const publishAutomation = Effect.fn("AutomationService.publishAutomation")(function* (
    detail: AutomationDetail,
    revision: number,
  ) {
    const summary = yield* toSummary(detail);
    yield* PubSub.publish(changes, {
      type: "automation-upserted",
      revision,
      automation: summary,
    });
  });

  const create = Effect.fn("AutomationService.create")(function* (
    input: AutomationCreateInput,
  ): Effect.fn.Return<AutomationDetail, AutomationRpcError> {
    yield* validateWrite(input);
    const id = yield* randomId(AutomationId.make).pipe(
      Effect.mapError(() => storageError("Failed to generate an Automation id.")),
    );
    const createdAt = yield* nowIso;
    const attachments = yield* persistAttachments(id, input.message.attachments, []);
    const schedule = parseAutomationSchedule(input.schedule);
    const nextRunAt = input.enabled
      ? nextAutomationRunAt(
          { cronExpression: schedule.expression, timeZone: schedule.timeZone },
          new Date(createdAt),
        )
      : null;
    const globalRevision = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
                INSERT INTO automations (
                  automation_id, project_id, name, message_text, attachments_json,
                  model_selection_json, runtime_mode, interaction_mode, workspace_json,
                  cron_expression, time_zone, enabled, pause_reason, pause_detail,
                  next_run_at, revision, created_at, updated_at, deleted_at
                ) VALUES (
                  ${id}, ${input.projectId}, ${input.name}, ${input.message.text},
                  ${JSON.stringify(attachments)}, ${JSON.stringify(input.modelSelection)},
                  ${input.runtimeMode}, ${input.interactionMode}, ${JSON.stringify(input.workspace)},
                  ${schedule.expression}, ${schedule.timeZone}, ${input.enabled ? 1 : 0},
                  ${input.enabled ? null : "user"}, NULL, ${nextRunAt}, 1,
                  ${createdAt}, ${createdAt}, NULL
                )
              `;
          return yield* bumpGlobalRevision();
        }),
      )
      .pipe(Effect.mapError(() => storageError("Failed to create Automation.")));
    const detail = yield* getAutomation(id);
    yield* publishAutomation(detail, globalRevision);
    return detail;
  });

  const update = Effect.fn("AutomationService.update")(function* (
    input: AutomationUpdateInput,
  ): Effect.fn.Return<AutomationDetail, AutomationRpcError> {
    yield* validateWrite(input);
    const current = yield* getAutomation(input.id);
    if (current.revision !== input.expectedRevision) {
      return yield* new AutomationRpcError({
        code: "conflict",
        message: "This Automation changed elsewhere. Reload it before saving.",
      });
    }
    const updatedAt = yield* nowIso;
    const attachments = yield* persistAttachments(
      input.id,
      input.message.attachments,
      current.message.attachments,
    );
    const schedule = parseAutomationSchedule(input.schedule);
    const nextRunAt = input.enabled
      ? nextAutomationRunAt(
          { cronExpression: schedule.expression, timeZone: schedule.timeZone },
          new Date(updatedAt),
        )
      : null;
    const rowsAndRevision = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly id: string }>`
                UPDATE automations
                SET project_id = ${input.projectId},
                    name = ${input.name},
                    message_text = ${input.message.text},
                    attachments_json = ${JSON.stringify(attachments)},
                    model_selection_json = ${JSON.stringify(input.modelSelection)},
                    runtime_mode = ${input.runtimeMode},
                    interaction_mode = ${input.interactionMode},
                    workspace_json = ${JSON.stringify(input.workspace)},
                    cron_expression = ${schedule.expression},
                    time_zone = ${schedule.timeZone},
                    enabled = ${input.enabled ? 1 : 0},
                    pause_reason = ${input.enabled ? null : "user"},
                    pause_detail = NULL,
                    next_run_at = ${nextRunAt},
                    revision = revision + 1,
                    updated_at = ${updatedAt}
                WHERE automation_id = ${input.id}
                  AND revision = ${input.expectedRevision}
                  AND deleted_at IS NULL
                RETURNING automation_id AS id
              `;
          const revision = rows.length > 0 ? yield* bumpGlobalRevision() : -1;
          return { rows, revision };
        }),
      )
      .pipe(Effect.mapError(() => storageError("Failed to update Automation.")));
    if (rowsAndRevision.rows.length === 0) {
      return yield* new AutomationRpcError({
        code: "conflict",
        message: "This Automation changed elsewhere. Reload it before saving.",
      });
    }
    const detail = yield* getAutomation(input.id);
    yield* publishAutomation(detail, rowsAndRevision.revision);
    return detail;
  });

  const setEnabled = Effect.fn("AutomationService.setEnabled")(function* (
    input: AutomationRevisionInput,
    enabled: boolean,
  ): Effect.fn.Return<AutomationDetail, AutomationRpcError> {
    const current = yield* getAutomation(input.id);
    if (current.revision !== input.expectedRevision) {
      return yield* new AutomationRpcError({
        code: "conflict",
        message: "This Automation changed elsewhere. Reload it before continuing.",
      });
    }
    const updatedAt = yield* nowIso;
    const nextRunAt = enabled ? nextAutomationRunAt(current.schedule, new Date(updatedAt)) : null;
    const result = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly id: string }>`
                UPDATE automations
                SET enabled = ${enabled ? 1 : 0},
                    pause_reason = ${enabled ? null : "user"},
                    pause_detail = NULL,
                    next_run_at = ${nextRunAt},
                    revision = revision + 1,
                    updated_at = ${updatedAt}
                WHERE automation_id = ${input.id}
                  AND revision = ${input.expectedRevision}
                  AND deleted_at IS NULL
                RETURNING automation_id AS id
              `;
          return {
            changed: rows.length > 0,
            revision: rows.length > 0 ? yield* bumpGlobalRevision() : -1,
          };
        }),
      )
      .pipe(Effect.mapError(() => storageError("Failed to change Automation state.")));
    if (!result.changed) {
      return yield* new AutomationRpcError({
        code: "conflict",
        message: "This Automation changed elsewhere. Reload it before continuing.",
      });
    }
    const detail = yield* getAutomation(input.id);
    yield* publishAutomation(detail, result.revision);
    return detail;
  });

  const pause = (input: AutomationRevisionInput) => setEnabled(input, false);
  const resume = (input: AutomationRevisionInput) => setEnabled(input, true);

  const remove = Effect.fn("AutomationService.delete")(function* (
    input: AutomationRevisionInput,
  ): Effect.fn.Return<{ readonly id: AutomationIdType }, AutomationRpcError> {
    const deletedAt = yield* nowIso;
    const result = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly id: string }>`
                UPDATE automations
                SET enabled = 0,
                    next_run_at = NULL,
                    deleted_at = ${deletedAt},
                    updated_at = ${deletedAt},
                    revision = revision + 1
                WHERE automation_id = ${input.id}
                  AND revision = ${input.expectedRevision}
                  AND deleted_at IS NULL
                RETURNING automation_id AS id
              `;
          return {
            changed: rows.length > 0,
            revision: rows.length > 0 ? yield* bumpGlobalRevision() : -1,
          };
        }),
      )
      .pipe(Effect.mapError(() => storageError("Failed to delete Automation.")));
    if (!result.changed) {
      return yield* new AutomationRpcError({
        code: "conflict",
        message: "This Automation changed elsewhere or no longer exists.",
      });
    }
    yield* PubSub.publish(changes, {
      type: "automation-removed",
      revision: result.revision,
      automationId: input.id,
    });
    return { id: input.id };
  });

  const hasActiveRun = Effect.fn("AutomationService.hasActiveRun")(function* (
    automationId: AutomationIdType,
  ) {
    const rows = yield* selectRunRows({ automationId, limit: 1, onlyActive: true }).pipe(
      Effect.mapError(() => storageError("Failed to inspect active Automation runs.")),
    );
    const runs = yield* decodeRunRows(rows);
    return runs.find(
      (run) => run.status === "launching" || run.status === "running" || run.status === "waiting",
    );
  });

  const claimRun = Effect.fn("AutomationService.claimRun")(function* (
    input: ClaimAutomationRunInput,
  ): Effect.fn.Return<ClaimedAutomationRun, AutomationRpcError> {
    const runId = yield* randomId(AutomationRunId.make).pipe(
      Effect.mapError(() => storageError("Failed to generate an Automation run id.")),
    );
    const result = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          // Acquire the Automation row's write lock before inspecting runs. This makes
          // the no-overlap decision atomic across concurrent scheduled and manual RPCs.
          yield* sql`
                UPDATE automations
                SET updated_at = updated_at
                WHERE automation_id = ${input.automationId} AND deleted_at IS NULL
              `;
          const automation = yield* getAutomation(input.automationId);
          if (input.trigger !== "manual" && !automation.enabled) {
            return yield* new AutomationRpcError({
              code: "conflict",
              message: "Automation is paused.",
            });
          }
          if (automation.pauseReason === "configuration-error") {
            return yield* new AutomationRpcError({
              code: "invalid-configuration",
              message: automation.pauseDetail ?? "Automation needs attention before it can run.",
            });
          }
          const active = yield* hasActiveRun(input.automationId);
          if (active && input.trigger === "manual") {
            return yield* new AutomationRpcError({
              code: "overlap",
              message: "This Automation already has an active run.",
            });
          }
          const storedStatus = active ? "skipped" : "launching";
          const detail = active ? "Skipped because an earlier run is still active." : null;
          const rows = yield* sql<{ readonly id: string }>`
                INSERT OR IGNORE INTO automation_runs (
                  run_id, automation_id, thread_id, trigger, status, scheduled_for,
                  triggered_at, coalesced_through, missed_occurrences,
                  missed_occurrences_exact, definition_revision, detail, occurrence_key
                ) VALUES (
                  ${runId}, ${input.automationId}, NULL, ${input.trigger}, ${storedStatus},
                  ${input.scheduledFor}, ${input.triggeredAt}, ${input.coalescedThrough},
                  ${input.missedOccurrences.value}, ${input.missedOccurrences.exact ? 1 : 0},
                  ${automation.revision}, ${detail}, ${input.occurrenceKey}
                )
                RETURNING run_id AS id
              `;
          if (rows.length === 0) return { automation, inserted: false, revision: -1 };
          if (input.trigger !== "manual") {
            yield* sql`
                  UPDATE automations
                  SET next_run_at = ${input.nextRunAt ?? automation.nextRunAt},
                      updated_at = ${input.triggeredAt}
                  WHERE automation_id = ${input.automationId}
                `;
          }
          return { automation, inserted: true, revision: yield* bumpGlobalRevision() };
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isAutomationRpcError(cause) ? cause : storageError("Failed to claim Automation run."),
        ),
      );
    if (!result.inserted) {
      const rows = yield* selectRunRows({
        automationId: input.automationId,
        occurrenceKey: input.occurrenceKey,
        limit: 1,
      }).pipe(Effect.mapError(() => storageError("Failed to load claimed Automation run.")));
      const run = (yield* decodeRunRows(rows))[0];
      if (run) return { run, automation: result.automation };
      return yield* new AutomationRpcError({
        code: "conflict",
        message: "This Automation occurrence was already claimed.",
      });
    }
    const rows = yield* selectRunRows({
      automationId: input.automationId,
      runId,
      limit: 1,
    }).pipe(Effect.mapError(() => storageError("Failed to load claimed Automation run.")));
    const run = (yield* decodeRunRows(rows))[0];
    if (!run) return yield* storageError("Claimed Automation run was not found.");
    yield* PubSub.publish(changes, {
      type: "run-upserted",
      revision: result.revision,
      run,
    });
    if (input.trigger !== "manual") {
      const nextDetail = yield* getAutomation(input.automationId);
      yield* publishAutomation(nextDetail, result.revision);
    }
    return { run, automation: result.automation };
  });

  const linkRun = Effect.fn("AutomationService.linkRun")(function* (input: {
    readonly automationId: AutomationIdType;
    readonly runId: AutomationRunIdType;
    readonly threadId: ThreadIdType;
  }) {
    const revision = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
                UPDATE automation_runs
                SET thread_id = ${input.threadId}, status = 'running'
                WHERE run_id = ${input.runId} AND automation_id = ${input.automationId}
              `;
          return yield* bumpGlobalRevision();
        }),
      )
      .pipe(Effect.mapError(() => storageError("Failed to link Automation run thread.")));
    const rows = yield* selectRunRows({
      automationId: input.automationId,
      runId: input.runId,
      limit: 1,
    }).pipe(Effect.mapError(() => storageError("Failed to load linked Automation run.")));
    const run = (yield* decodeRunRows(rows))[0];
    if (!run) return yield* storageError("Linked Automation run was not found.");
    yield* PubSub.publish(changes, { type: "run-upserted", revision, run });
    return run;
  });

  const failRun = Effect.fn("AutomationService.failRun")(function* (input: {
    readonly automationId: AutomationIdType;
    readonly runId: AutomationRunIdType;
    readonly detail: string;
    readonly configurationError?: boolean;
  }) {
    const at = yield* nowIso;
    const revision = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
                UPDATE automation_runs
                SET status = 'failed', detail = ${input.detail}
                WHERE run_id = ${input.runId} AND automation_id = ${input.automationId}
              `;
          if (input.configurationError === true) {
            yield* sql`
                  UPDATE automations
                  SET enabled = 0,
                      pause_reason = 'configuration-error',
                      pause_detail = ${input.detail},
                      next_run_at = NULL,
                      revision = revision + 1,
                      updated_at = ${at}
                  WHERE automation_id = ${input.automationId} AND deleted_at IS NULL
                `;
          }
          return yield* bumpGlobalRevision();
        }),
      )
      .pipe(Effect.mapError(() => storageError("Failed to record Automation failure.")));
    const rows = yield* selectRunRows({
      automationId: input.automationId,
      runId: input.runId,
      limit: 1,
    }).pipe(Effect.mapError(() => storageError("Failed to load failed Automation run.")));
    const run = (yield* decodeRunRows(rows))[0];
    if (!run) return yield* storageError("Failed Automation run was not found.");
    yield* PubSub.publish(changes, { type: "run-upserted", revision, run });
    if (input.configurationError === true) {
      yield* publishAutomation(yield* getAutomation(input.automationId), revision);
    }
    return run;
  });

  const materializeAttachments = Effect.fn("AutomationService.materializeAttachments")(function* (
    detail: AutomationDetail,
    threadId: ThreadIdType,
  ) {
    return yield* Effect.forEach(
      detail.message.attachments,
      (source) =>
        Effect.gen(function* () {
          const sourcePath = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment: source,
          });
          if (!sourcePath || !(yield* fileSystem.exists(sourcePath))) {
            return yield* new AutomationRpcError({
              code: "invalid-configuration",
              message: `Saved attachment '${source.name}' is missing.`,
            });
          }
          const id = createAttachmentId(threadId);
          if (!id) return yield* storageError("Failed to create run attachment id.");
          const target = { ...source, id };
          const targetPath = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment: target,
          });
          if (!targetPath) return yield* storageError("Failed to resolve run attachment.");
          const bytes = yield* fileSystem
            .readFile(sourcePath)
            .pipe(
              Effect.mapError(() =>
                storageError(`Failed to read saved attachment '${source.name}'.`),
              ),
            );
          yield* fileSystem
            .writeFile(targetPath, bytes)
            .pipe(
              Effect.mapError(() =>
                storageError(`Failed to copy saved attachment '${source.name}'.`),
              ),
            );
          return target;
        }),
      { concurrency: 1 },
    );
  });

  const listDue = Effect.fn("AutomationService.listDue")(function* (at: string) {
    const rows = yield* sql<{ readonly id: string }>`
          SELECT automation_id AS id
          FROM automations
          WHERE deleted_at IS NULL
            AND enabled = 1
            AND next_run_at IS NOT NULL
            AND next_run_at <= ${at}
          ORDER BY next_run_at ASC, automation_id ASC
        `.pipe(Effect.mapError(() => storageError("Failed to list due Automations.")));
    return yield* Effect.forEach(rows, (row) => getAutomation(AutomationId.make(row.id)));
  });

  const getNextDueAt = Effect.fn("AutomationService.getNextDueAt")(function* () {
    const rows = yield* sql<{ readonly nextRunAt: string | null }>`
          SELECT MIN(next_run_at) AS "nextRunAt"
          FROM automations
          WHERE deleted_at IS NULL AND enabled = 1 AND next_run_at IS NOT NULL
        `.pipe(Effect.mapError(() => storageError("Failed to load next Automation run time.")));
    return rows[0]?.nextRunAt ?? null;
  });

  const subscribe = Effect.fn("AutomationService.subscribe")(function* () {
    // Subscribe before reading the snapshot so a concurrent write is either reflected
    // in the snapshot or buffered as a following event, never lost between the two.
    const subscription = yield* subscribeBeforeSnapshotWithoutMutex(
      changes,
      getSnapshot().pipe(
        Effect.map((snapshot): AutomationStreamEvent => ({ type: "snapshot", snapshot })),
      ),
    );
    return Stream.concat(Stream.make(subscription.latest), subscription.changes);
  });

  return {
    previewSchedule: (input: { readonly cronExpression: string; readonly timeZone: string }) =>
      Effect.try({
        try: () => previewAutomationSchedule(input),
        catch: (cause) =>
          isAutomationRpcError(cause)
            ? cause
            : new AutomationRpcError({
                code: "invalid-schedule",
                message: "Invalid Automation schedule.",
              }),
      }),
    getSnapshot,
    subscribe,
    getDetail: (input: { readonly id: AutomationIdType }) => getAutomation(input.id),
    getRunsPage,
    create,
    update,
    pause,
    resume,
    delete: remove,
    claimRun,
    linkRun,
    failRun,
    materializeAttachments,
    listDue,
    getNextDueAt,
  };
});

export class AutomationService extends Context.Service<
  AutomationService,
  Effect.Success<typeof make>
>()("t3/automation/AutomationService") {}

export const AutomationServiceLive = Layer.effect(AutomationService, make);
