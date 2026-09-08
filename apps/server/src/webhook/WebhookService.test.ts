import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as WebhookService from "./WebhookService.ts";

const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-webhook-test-" });
const WebhookServiceTestLayer = WebhookService.WebhookServiceLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerSecretStore.layer.pipe(Layer.provide(configLayer))),
  Layer.provide(configLayer),
);

const createDefinition = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const service = yield* WebhookService.WebhookService;
  const projectId = ProjectId.make("project-1");
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json, scripts_json,
      created_at, updated_at, deleted_at
    ) VALUES (
      ${projectId}, 'Project', '/tmp/project-1', NULL, '[]',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
    )
  `;
  return yield* service.create({
    projectId,
    name: "PostHog errors",
    promptPrefix: "Investigate this exception.",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    workspace: { kind: "project-checkout", expectedBranch: null },
    enabled: true,
  });
});

function tokenFromEndpoint(endpointPath: string): string {
  return decodeURIComponent(endpointPath.slice(endpointPath.lastIndexOf("/") + 1));
}

it.layer(NodeServices.layer)("WebhookService", (it) => {
  it.effect("authorizes only the current secret on an enabled webhook", () =>
    Effect.gen(function* () {
      const service = yield* WebhookService.WebhookService;
      const definition = yield* createDefinition;
      const originalToken = tokenFromEndpoint(definition.endpointPath);

      expect((yield* service.authorizeDelivery(definition.id, originalToken)).id).toBe(
        definition.id,
      );
      expect((yield* Effect.flip(service.authorizeDelivery(definition.id, "wrong"))).code).toBe(
        "not-found",
      );

      const rotations = yield* Effect.all(
        [
          Effect.result(
            service.rotateSecret({ id: definition.id, expectedRevision: definition.revision }),
          ),
          Effect.result(
            service.rotateSecret({ id: definition.id, expectedRevision: definition.revision }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      const successfulRotations = rotations.filter((result) => result._tag === "Success");
      const failedRotations = rotations.filter((result) => result._tag === "Failure");
      expect(successfulRotations).toHaveLength(1);
      expect(failedRotations).toHaveLength(1);
      const rotated = successfulRotations[0]?.success;
      if (!rotated) return;
      expect(
        (yield* Effect.flip(service.authorizeDelivery(definition.id, originalToken))).code,
      ).toBe("not-found");
      expect(
        (yield* service.authorizeDelivery(definition.id, tokenFromEndpoint(rotated.endpointPath)))
          .id,
      ).toBe(definition.id);

      const paused = yield* service.pause({
        id: rotated.id,
        expectedRevision: rotated.revision,
      });
      expect(
        (yield* Effect.flip(
          service.authorizeDelivery(paused.id, tokenFromEndpoint(rotated.endpointPath)),
        )).code,
      ).toBe("not-found");
    }).pipe(Effect.provide(WebhookServiceTestLayer)),
  );

  it.effect("deduplicates delivery retries and permits a failed launch to retry", () =>
    Effect.gen(function* () {
      const service = yield* WebhookService.WebhookService;
      const definition = yield* createDefinition;
      const claim = () =>
        service.claimDelivery({
          webhookId: definition.id,
          dedupeKey: "posthog:event-1",
          receivedAt: "2026-01-02T09:00:00.000Z",
          payloadBytes: 123,
        });

      const claims = yield* Effect.all([claim(), claim()], { concurrency: "unbounded" });
      const first = claims.find(({ claimed }) => claimed);
      const duplicate = claims.find(({ claimed }) => !claimed);
      expect(first).toBeDefined();
      expect(duplicate).toBeDefined();
      if (!first || !duplicate) return;
      expect(duplicate.delivery.id).toBe(first.delivery.id);

      yield* service.failDelivery({
        webhookId: definition.id,
        deliveryId: first.delivery.id,
        detail: "launch failed",
      });
      const retried = yield* claim();
      expect(retried.claimed).toBe(true);
      expect(retried.delivery.id).toBe(first.delivery.id);
      expect(retried.delivery.status).toBe("launching");
    }).pipe(Effect.provide(WebhookServiceTestLayer)),
  );
});
