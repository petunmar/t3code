import * as Schema from "effect/Schema";

import {
  AutomationId,
  AutomationRunId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  ChatAttachment,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  UploadChatAttachment,
} from "./orchestration.ts";

export const AUTOMATION_WS_METHODS = {
  getSnapshot: "automation.getSnapshot",
  subscribe: "automation.subscribe",
  getDetail: "automation.getDetail",
  getRunsPage: "automation.getRunsPage",
  previewSchedule: "automation.previewSchedule",
  create: "automation.create",
  update: "automation.update",
  pause: "automation.pause",
  resume: "automation.resume",
  delete: "automation.delete",
  runNow: "automation.runNow",
} as const;

export const AutomationSchedule = Schema.Struct({
  cronExpression: TrimmedNonEmptyString,
  timeZone: TrimmedNonEmptyString,
});
export type AutomationSchedule = typeof AutomationSchedule.Type;

export const AutomationWorkspace = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project-checkout"),
    expectedBranch: Schema.NullOr(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("existing-worktree"),
    worktreePath: TrimmedNonEmptyString,
    expectedBranch: Schema.NullOr(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("new-worktree"),
    fromBranch: TrimmedNonEmptyString,
    startFromOrigin: Schema.Boolean,
  }),
]);
export type AutomationWorkspace = typeof AutomationWorkspace.Type;

export const AutomationAttachmentWrite = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("upload"),
    attachment: UploadChatAttachment,
  }),
  Schema.Struct({
    kind: Schema.Literal("retained"),
    attachmentId: TrimmedNonEmptyString,
  }),
]);
export type AutomationAttachmentWrite = typeof AutomationAttachmentWrite.Type;

export const AutomationMessageWrite = Schema.Struct({
  text: Schema.String,
  attachments: Schema.Array(AutomationAttachmentWrite),
});
export type AutomationMessageWrite = typeof AutomationMessageWrite.Type;

export const AutomationMessage = Schema.Struct({
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
});
export type AutomationMessage = typeof AutomationMessage.Type;

export const AutomationPauseReason = Schema.Literals(["user", "configuration-error"]);
export type AutomationPauseReason = typeof AutomationPauseReason.Type;

const AutomationDefinitionFields = {
  id: AutomationId,
  projectId: ProjectId,
  name: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspace: AutomationWorkspace,
  schedule: AutomationSchedule,
  enabled: Schema.Boolean,
  pauseReason: Schema.NullOr(AutomationPauseReason),
  pauseDetail: Schema.NullOr(Schema.String),
  nextRunAt: Schema.NullOr(IsoDateTime),
  revision: PositiveInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
} as const;

export const AutomationSummary = Schema.Struct({
  ...AutomationDefinitionFields,
  lastRun: Schema.NullOr(
    Schema.Struct({
      runId: AutomationRunId,
      status: Schema.Literals([
        "launching",
        "running",
        "waiting",
        "completed",
        "interrupted",
        "failed",
        "skipped",
      ]),
      triggeredAt: IsoDateTime,
      threadId: Schema.NullOr(ThreadId),
      detail: Schema.NullOr(Schema.String),
    }),
  ),
});
export type AutomationSummary = typeof AutomationSummary.Type;

export const AutomationDetail = Schema.Struct({
  ...AutomationDefinitionFields,
  message: AutomationMessage,
});
export type AutomationDetail = typeof AutomationDetail.Type;

export const AutomationRunTrigger = Schema.Literals(["scheduled", "catch-up", "manual"]);
export type AutomationRunTrigger = typeof AutomationRunTrigger.Type;
export const AutomationRunStatus = Schema.Literals([
  "launching",
  "running",
  "waiting",
  "completed",
  "interrupted",
  "failed",
  "skipped",
]);
export type AutomationRunStatus = typeof AutomationRunStatus.Type;

export const AutomationRunSummary = Schema.Struct({
  id: AutomationRunId,
  automationId: AutomationId,
  threadId: Schema.NullOr(ThreadId),
  trigger: AutomationRunTrigger,
  status: AutomationRunStatus,
  scheduledFor: IsoDateTime,
  triggeredAt: IsoDateTime,
  coalescedThrough: Schema.NullOr(IsoDateTime),
  missedOccurrences: Schema.Struct({
    value: PositiveInt,
    exact: Schema.Boolean,
  }),
  definitionRevision: PositiveInt,
  detail: Schema.NullOr(Schema.String),
});
export type AutomationRunSummary = typeof AutomationRunSummary.Type;

export const AutomationSnapshot = Schema.Struct({
  revision: NonNegativeInt,
  automations: Schema.Array(AutomationSummary),
});
export type AutomationSnapshot = typeof AutomationSnapshot.Type;

export const AutomationStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    snapshot: AutomationSnapshot,
  }),
  Schema.Struct({
    type: Schema.Literal("automation-upserted"),
    revision: NonNegativeInt,
    automation: AutomationSummary,
  }),
  Schema.Struct({
    type: Schema.Literal("automation-removed"),
    revision: NonNegativeInt,
    automationId: AutomationId,
  }),
  Schema.Struct({
    type: Schema.Literal("run-upserted"),
    revision: NonNegativeInt,
    run: AutomationRunSummary,
  }),
]);
export type AutomationStreamEvent = typeof AutomationStreamEvent.Type;

export const AutomationSchedulePreviewInput = AutomationSchedule;
export type AutomationSchedulePreviewInput = typeof AutomationSchedulePreviewInput.Type;
export const AutomationSchedulePreview = Schema.Struct({
  normalizedCronExpression: TrimmedNonEmptyString,
  nextRuns: Schema.Array(IsoDateTime),
});
export type AutomationSchedulePreview = typeof AutomationSchedulePreview.Type;

const AutomationWriteFields = {
  projectId: ProjectId,
  name: TrimmedNonEmptyString,
  message: AutomationMessageWrite,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspace: AutomationWorkspace,
  schedule: AutomationSchedule,
  enabled: Schema.Boolean,
} as const;

export const AutomationCreateInput = Schema.Struct(AutomationWriteFields);
export type AutomationCreateInput = typeof AutomationCreateInput.Type;
export const AutomationUpdateInput = Schema.Struct({
  id: AutomationId,
  expectedRevision: PositiveInt,
  ...AutomationWriteFields,
});
export type AutomationUpdateInput = typeof AutomationUpdateInput.Type;

export const AutomationIdInput = Schema.Struct({ id: AutomationId });
export type AutomationIdInput = typeof AutomationIdInput.Type;
export const AutomationRevisionInput = Schema.Struct({
  id: AutomationId,
  expectedRevision: PositiveInt,
});
export type AutomationRevisionInput = typeof AutomationRevisionInput.Type;

export const AutomationRunsPageInput = Schema.Struct({
  automationId: AutomationId,
  before: Schema.optional(IsoDateTime),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
});
export type AutomationRunsPageInput = typeof AutomationRunsPageInput.Type;
export const AutomationRunsPage = Schema.Struct({
  runs: Schema.Array(AutomationRunSummary),
  nextCursor: Schema.NullOr(IsoDateTime),
});
export type AutomationRunsPage = typeof AutomationRunsPage.Type;

export class AutomationRpcError extends Schema.TaggedErrorClass<AutomationRpcError>()(
  "AutomationRpcError",
  {
    code: Schema.Literals([
      "not-found",
      "conflict",
      "invalid-schedule",
      "invalid-configuration",
      "overlap",
      "storage-error",
      "launch-error",
    ]),
    message: Schema.String,
  },
) {}
