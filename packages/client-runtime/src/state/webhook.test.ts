import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WebhookDeliveryId,
  WebhookId,
  type WebhookSnapshot,
  type WebhookSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyWebhookStreamEvent } from "./webhook.ts";

function webhook(id: string): WebhookSummary {
  return {
    id: WebhookId.make(id),
    projectId: ProjectId.make("project-1"),
    name: id,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    workspace: { kind: "project-checkout", expectedBranch: null },
    endpointPath: `/api/webhooks/${id}/secret`,
    enabled: true,
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastDelivery: null,
  };
}

describe("Webhook stream reducer", () => {
  it("upserts definitions, delivery state, and removals", () => {
    const initial: WebhookSnapshot = { revision: 0, webhooks: [] };
    const definition = webhook("webhook-1");
    const upserted = applyWebhookStreamEvent(initial, {
      type: "webhook-upserted",
      revision: 1,
      webhook: definition,
    });
    const withDelivery = applyWebhookStreamEvent(upserted, {
      type: "delivery-upserted",
      revision: 2,
      delivery: {
        id: WebhookDeliveryId.make("delivery-1"),
        webhookId: definition.id,
        threadId: ThreadId.make("thread-1"),
        status: "running",
        receivedAt: "2026-01-02T09:00:00.000Z",
        definitionRevision: 1,
        payloadBytes: 123,
        detail: null,
      },
    });

    expect(withDelivery.webhooks[0]?.lastDelivery?.status).toBe("running");
    expect(
      applyWebhookStreamEvent(withDelivery, {
        type: "webhook-removed",
        revision: 3,
        webhookId: definition.id,
      }),
    ).toEqual({ revision: 3, webhooks: [] });
  });

  it("does not replace the latest delivery with an older event", () => {
    const definition = {
      ...webhook("webhook-1"),
      lastDelivery: {
        id: WebhookDeliveryId.make("delivery-new"),
        webhookId: WebhookId.make("webhook-1"),
        threadId: ThreadId.make("thread-new"),
        status: "completed" as const,
        receivedAt: "2026-01-03T09:00:00.000Z",
        definitionRevision: 1,
        payloadBytes: 123,
        detail: null,
      },
    };
    const result = applyWebhookStreamEvent(
      { revision: 4, webhooks: [definition] },
      {
        type: "delivery-upserted",
        revision: 5,
        delivery: {
          id: WebhookDeliveryId.make("delivery-old"),
          webhookId: definition.id,
          threadId: ThreadId.make("thread-old"),
          status: "running",
          receivedAt: "2026-01-02T09:00:00.000Z",
          definitionRevision: 1,
          payloadBytes: 100,
          detail: null,
        },
      },
    );

    expect(result.webhooks[0]?.lastDelivery?.id).toBe("delivery-new");
  });
});
