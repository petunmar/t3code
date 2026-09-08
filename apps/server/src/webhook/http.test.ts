import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WebhookDeliveryId,
  WebhookId,
  WebhookRpcError,
  type WebhookDetail,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";

import * as WebhookRunner from "./WebhookRunner.ts";
import * as WebhookService from "./WebhookService.ts";
import { normalizeWebhookBody, WEBHOOK_MAX_BODY_BYTES, webhookRouteLayer } from "./http.ts";

const webhook: WebhookDetail = {
  id: WebhookId.make("posthog"),
  projectId: ProjectId.make("project-1"),
  name: "PostHog errors",
  promptPrefix: "Fix this exception.",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  workspace: { kind: "project-checkout", expectedBranch: null },
  endpointPath: "/api/webhooks/posthog/secret",
  enabled: true,
  revision: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const delivery = {
  id: WebhookDeliveryId.make("delivery-1"),
  webhookId: webhook.id,
  threadId: ThreadId.make("thread-1"),
  status: "running" as const,
  receivedAt: "2026-01-02T09:00:00.000Z",
  definitionRevision: 1,
  payloadBytes: 25,
  detail: null,
};

it.effect("accepts JSON and preserves its exact body", () =>
  Effect.gen(function* () {
    const body = '{ "event": "$exception" }';
    expect(yield* normalizeWebhookBody(body, "application/json")).toBe(body);
  }),
);

it.effect("rejects invalid JSON but accepts plain text", () =>
  Effect.gen(function* () {
    expect(yield* Effect.result(normalizeWebhookBody("{", "application/json"))).toHaveProperty(
      "_tag",
      "Failure",
    );
    expect(yield* normalizeWebhookBody("exception: boom", "text/plain")).toBe("exception: boom");
  }),
);

it.effect("accepts a secret URL and launches the claimed JSON delivery", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const launches: Array<WebhookRunner.RunWebhookDeliveryInput> = [];
      const services = Layer.mergeAll(
        Layer.mock(WebhookService.WebhookService)({
          authorizeDelivery: (_id, token) =>
            token === "secret"
              ? Effect.succeed(webhook)
              : Effect.fail(
                  new WebhookRpcError({ code: "not-found", message: "Webhook not found." }),
                ),
          claimDelivery: () => Effect.succeed({ webhook, delivery, claimed: true }),
        }),
        Layer.mock(WebhookRunner.WebhookRunner)({
          runDelivery: (input) => {
            launches.push(input);
            return Effect.succeed(delivery);
          },
        }),
      );
      yield* HttpRouter.serve(webhookRouteLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.provide(services), Layer.build);
      const httpClient = yield* HttpClient.HttpClient;
      const body = '{ "event": "$exception" }';
      const accepted = yield* httpClient.post("/api/webhooks/posthog/secret", {
        headers: { "x-t3-delivery-id": "posthog-event-1" },
        body: HttpBody.text(body, "application/json"),
      });

      expect(accepted.status).toBe(202);
      expect(yield* accepted.json).toMatchObject({
        accepted: true,
        duplicate: false,
        deliveryId: delivery.id,
        threadId: delivery.threadId,
      });
      expect(launches).toHaveLength(1);
      expect(launches[0]?.payload).toBe(body);
      expect(launches[0]?.contentType).toBe("application/json");

      const rejected = yield* httpClient.post("/api/webhooks/posthog/wrong", {
        body: HttpBody.text(body, "application/json"),
      });
      expect(rejected.status).toBe(404);

      const oversized = yield* httpClient.post("/api/webhooks/posthog/secret", {
        body: HttpBody.text("x".repeat(WEBHOOK_MAX_BODY_BYTES + 1), "text/plain"),
      });
      expect(oversized.status).toBe(413);
      expect(launches).toHaveLength(1);
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, NodeServices.layer))),
);
