import * as Schema from "effect/Schema";

import { AutomationWorkspace } from "./automation.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  WebhookDeliveryId,
  WebhookId,
} from "./baseSchemas.ts";
import { ModelSelection, ProviderInteractionMode, RuntimeMode } from "./orchestration.ts";

export const WEBHOOK_WS_METHODS = {
  getSnapshot: "webhook.getSnapshot",
  subscribe: "webhook.subscribe",
  getDetail: "webhook.getDetail",
  getDeliveriesPage: "webhook.getDeliveriesPage",
  create: "webhook.create",
  update: "webhook.update",
  pause: "webhook.pause",
  resume: "webhook.resume",
  rotateSecret: "webhook.rotateSecret",
  delete: "webhook.delete",
} as const;

export const WebhookWorkspace = AutomationWorkspace;
export type WebhookWorkspace = typeof WebhookWorkspace.Type;

export const WebhookDeliveryStatus = Schema.Literals([
  "launching",
  "running",
  "waiting",
  "completed",
  "interrupted",
  "failed",
]);
export type WebhookDeliveryStatus = typeof WebhookDeliveryStatus.Type;

export const WebhookDeliverySummary = Schema.Struct({
  id: WebhookDeliveryId,
  webhookId: WebhookId,
  threadId: Schema.NullOr(ThreadId),
  status: WebhookDeliveryStatus,
  receivedAt: IsoDateTime,
  definitionRevision: PositiveInt,
  payloadBytes: NonNegativeInt,
  detail: Schema.NullOr(Schema.String),
});
export type WebhookDeliverySummary = typeof WebhookDeliverySummary.Type;

const WebhookDefinitionFields = {
  id: WebhookId,
  projectId: ProjectId,
  name: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspace: WebhookWorkspace,
  endpointPath: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  revision: PositiveInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
} as const;

export const WebhookSummary = Schema.Struct({
  ...WebhookDefinitionFields,
  lastDelivery: Schema.NullOr(WebhookDeliverySummary),
});
export type WebhookSummary = typeof WebhookSummary.Type;

export const WebhookDetail = Schema.Struct({
  ...WebhookDefinitionFields,
  promptPrefix: Schema.String,
});
export type WebhookDetail = typeof WebhookDetail.Type;

export const WebhookSnapshot = Schema.Struct({
  revision: NonNegativeInt,
  webhooks: Schema.Array(WebhookSummary),
});
export type WebhookSnapshot = typeof WebhookSnapshot.Type;

export const WebhookStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    snapshot: WebhookSnapshot,
  }),
  Schema.Struct({
    type: Schema.Literal("webhook-upserted"),
    revision: NonNegativeInt,
    webhook: WebhookSummary,
  }),
  Schema.Struct({
    type: Schema.Literal("webhook-removed"),
    revision: NonNegativeInt,
    webhookId: WebhookId,
  }),
  Schema.Struct({
    type: Schema.Literal("delivery-upserted"),
    revision: NonNegativeInt,
    delivery: WebhookDeliverySummary,
  }),
]);
export type WebhookStreamEvent = typeof WebhookStreamEvent.Type;

const WebhookWriteFields = {
  projectId: ProjectId,
  name: TrimmedNonEmptyString,
  promptPrefix: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspace: WebhookWorkspace,
  enabled: Schema.Boolean,
} as const;

export const WebhookCreateInput = Schema.Struct(WebhookWriteFields);
export type WebhookCreateInput = typeof WebhookCreateInput.Type;
export const WebhookUpdateInput = Schema.Struct({
  id: WebhookId,
  expectedRevision: PositiveInt,
  ...WebhookWriteFields,
});
export type WebhookUpdateInput = typeof WebhookUpdateInput.Type;

export const WebhookIdInput = Schema.Struct({ id: WebhookId });
export type WebhookIdInput = typeof WebhookIdInput.Type;
export const WebhookRevisionInput = Schema.Struct({
  id: WebhookId,
  expectedRevision: PositiveInt,
});
export type WebhookRevisionInput = typeof WebhookRevisionInput.Type;

export const WebhookDeliveriesPageInput = Schema.Struct({
  webhookId: WebhookId,
  before: Schema.optional(IsoDateTime),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
});
export type WebhookDeliveriesPageInput = typeof WebhookDeliveriesPageInput.Type;
export const WebhookDeliveriesPage = Schema.Struct({
  deliveries: Schema.Array(WebhookDeliverySummary),
  nextCursor: Schema.NullOr(IsoDateTime),
});
export type WebhookDeliveriesPage = typeof WebhookDeliveriesPage.Type;

export class WebhookRpcError extends Schema.TaggedErrorClass<WebhookRpcError>()("WebhookRpcError", {
  code: Schema.Literals([
    "not-found",
    "conflict",
    "invalid-configuration",
    "storage-error",
    "launch-error",
  ]),
  message: Schema.String,
}) {}
