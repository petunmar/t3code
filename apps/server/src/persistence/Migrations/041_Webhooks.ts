import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS webhooks (
      webhook_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      prompt_prefix TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      workspace_json TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      delivery_id TEXT PRIMARY KEY,
      webhook_id TEXT NOT NULL,
      thread_id TEXT,
      status TEXT NOT NULL,
      received_at TEXT NOT NULL,
      definition_revision INTEGER NOT NULL,
      payload_bytes INTEGER NOT NULL,
      detail TEXT,
      dedupe_key TEXT NOT NULL,
      UNIQUE (webhook_id, dedupe_key),
      UNIQUE (thread_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS webhook_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL
    )
  `;
  yield* sql`
    INSERT OR IGNORE INTO webhook_state (singleton, revision)
    VALUES (1, 0)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_history
    ON webhook_deliveries(webhook_id, received_at DESC, delivery_id DESC)
  `;
});
