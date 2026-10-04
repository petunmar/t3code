import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE webhook_deliveries_v42 (
      delivery_id TEXT PRIMARY KEY,
      webhook_id TEXT NOT NULL,
      thread_id TEXT,
      status TEXT NOT NULL,
      received_at TEXT NOT NULL,
      definition_revision INTEGER NOT NULL,
      payload_bytes INTEGER NOT NULL,
      detail TEXT,
      dedupe_key TEXT NOT NULL,
      UNIQUE (thread_id)
    )
  `;
  yield* sql`
    INSERT INTO webhook_deliveries_v42 (
      delivery_id, webhook_id, thread_id, status, received_at,
      definition_revision, payload_bytes, detail, dedupe_key
    )
    SELECT
      delivery_id, webhook_id, thread_id, status, received_at,
      definition_revision, payload_bytes, detail, dedupe_key
    FROM webhook_deliveries
  `;
  yield* sql`DROP TABLE webhook_deliveries`;
  yield* sql`ALTER TABLE webhook_deliveries_v42 RENAME TO webhook_deliveries`;

  yield* sql`
    CREATE INDEX idx_webhook_deliveries_history
    ON webhook_deliveries(webhook_id, received_at DESC, delivery_id DESC)
  `;
  yield* sql`
    CREATE INDEX idx_webhook_deliveries_dedupe_history
    ON webhook_deliveries(webhook_id, dedupe_key, received_at DESC)
  `;

  yield* sql`
    CREATE TABLE webhook_delivery_dedupe (
      webhook_id TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (webhook_id, dedupe_key),
      UNIQUE (delivery_id)
    )
  `;
  yield* sql`
    INSERT INTO webhook_delivery_dedupe (
      webhook_id, dedupe_key, delivery_id, expires_at
    )
    SELECT
      webhook_id,
      dedupe_key,
      delivery_id,
      strftime('%Y-%m-%dT%H:%M:%fZ', received_at, '+3 days')
    FROM webhook_deliveries
  `;
});
