import * as Schema from "effect/Schema";
import {
  AutomationId,
  AutomationRunId,
  WebhookId,
  WebhookDeliveryId,
  IsoDateTime,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const AutomationThreadOrigin = Schema.Struct({
  type: Schema.Literal("automation"),
  automationId: AutomationId,
  automationRunId: AutomationRunId,
  automationName: TrimmedNonEmptyString,
  trigger: Schema.Literals(["scheduled", "catch-up", "manual"]),
  scheduledFor: IsoDateTime,
  timeZone: TrimmedNonEmptyString,
});
export type AutomationThreadOrigin = typeof AutomationThreadOrigin.Type;

export const WebhookThreadOrigin = Schema.Struct({
  type: Schema.Literal("webhook"),
  webhookId: WebhookId,
  webhookDeliveryId: WebhookDeliveryId,
  webhookName: TrimmedNonEmptyString,
  receivedAt: IsoDateTime,
});
export type WebhookThreadOrigin = typeof WebhookThreadOrigin.Type;

export const ThreadOrigin = Schema.Union([AutomationThreadOrigin, WebhookThreadOrigin]);
export type ThreadOrigin = typeof ThreadOrigin.Type;
