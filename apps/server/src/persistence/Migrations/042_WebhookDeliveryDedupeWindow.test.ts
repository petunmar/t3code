import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("042_WebhookDeliveryDedupeWindow", (it) => {
  it.effect("preserves history and allows a dedupe key to be reused", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 41 });
      yield* sql`
        INSERT INTO webhooks (
          webhook_id, project_id, name, prompt_prefix, model_selection_json,
          runtime_mode, interaction_mode, workspace_json, secret_hash, enabled,
          revision, created_at, updated_at, deleted_at
        ) VALUES (
          'webhook-1', 'project-1', 'PostHog errors', 'Investigate',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
          '{"kind":"project-checkout","expectedBranch":null}', 'secret', 1,
          1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO webhook_deliveries (
          delivery_id, webhook_id, thread_id, status, received_at,
          definition_revision, payload_bytes, detail, dedupe_key
        ) VALUES (
          'delivery-1', 'webhook-1', NULL, 'launching', '2026-01-02T09:00:00.000Z',
          1, 123, NULL, 'posthog:event-1'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 42 });

      yield* sql`
        INSERT INTO webhook_deliveries (
          delivery_id, webhook_id, thread_id, status, received_at,
          definition_revision, payload_bytes, detail, dedupe_key
        ) VALUES (
          'delivery-2', 'webhook-1', NULL, 'launching', '2026-01-05T09:00:00.000Z',
          1, 123, NULL, 'posthog:event-1'
        )
      `;

      const deliveries = yield* sql<{ readonly id: string }>`
        SELECT delivery_id AS id
        FROM webhook_deliveries
        ORDER BY received_at
      `;
      const dedupe = yield* sql<{
        readonly deliveryId: string;
        readonly expiresAt: string;
      }>`
        SELECT delivery_id AS "deliveryId", expires_at AS "expiresAt"
        FROM webhook_delivery_dedupe
        WHERE webhook_id = 'webhook-1' AND dedupe_key = 'posthog:event-1'
      `;

      assert.deepStrictEqual(deliveries, [{ id: "delivery-1" }, { id: "delivery-2" }]);
      assert.deepStrictEqual(dedupe, [
        {
          deliveryId: "delivery-1",
          expiresAt: "2026-01-05T09:00:00.000Z",
        },
      ]);
    }),
  );
});
