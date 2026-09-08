import {
  WEBHOOK_WS_METHODS,
  type WebhookSnapshot,
  type WebhookStreamEvent,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export const EMPTY_WEBHOOK_SNAPSHOT: WebhookSnapshot = { revision: 0, webhooks: [] };

export function applyWebhookStreamEvent(
  current: WebhookSnapshot,
  event: WebhookStreamEvent,
): WebhookSnapshot {
  switch (event.type) {
    case "snapshot":
      return event.snapshot;
    case "webhook-upserted":
      return {
        revision: event.revision,
        webhooks: [
          ...current.webhooks.filter((webhook) => webhook.id !== event.webhook.id),
          event.webhook,
        ].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      };
    case "webhook-removed":
      return {
        revision: event.revision,
        webhooks: current.webhooks.filter((webhook) => webhook.id !== event.webhookId),
      };
    case "delivery-upserted":
      return {
        revision: event.revision,
        webhooks: current.webhooks.map((webhook) =>
          webhook.id !== event.delivery.webhookId ||
          (webhook.lastDelivery !== null &&
            webhook.lastDelivery.receivedAt > event.delivery.receivedAt)
            ? webhook
            : { ...webhook, lastDelivery: event.delivery },
        ),
      };
  }
}

export function createWebhookEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    snapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:webhook:snapshot",
      tag: WEBHOOK_WS_METHODS.getSnapshot,
    }),
    changes: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:webhook:changes",
      tag: WEBHOOK_WS_METHODS.subscribe,
      transform: (stream) =>
        stream.pipe(Stream.scan(EMPTY_WEBHOOK_SNAPSHOT, applyWebhookStreamEvent)),
    }),
    detail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:webhook:detail",
      tag: WEBHOOK_WS_METHODS.getDetail,
    }),
    deliveries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:webhook:deliveries",
      tag: WEBHOOK_WS_METHODS.getDeliveriesPage,
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:webhook:create",
      tag: WEBHOOK_WS_METHODS.create,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:webhook:update",
      tag: WEBHOOK_WS_METHODS.update,
    }),
    pause: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:webhook:pause",
      tag: WEBHOOK_WS_METHODS.pause,
    }),
    resume: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:webhook:resume",
      tag: WEBHOOK_WS_METHODS.resume,
    }),
    rotateSecret: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:webhook:rotate-secret",
      tag: WEBHOOK_WS_METHODS.rotateSecret,
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:webhook:delete",
      tag: WEBHOOK_WS_METHODS.delete,
    }),
  };
}
