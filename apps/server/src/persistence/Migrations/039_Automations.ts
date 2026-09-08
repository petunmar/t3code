import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS automations (
      automation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      message_text TEXT NOT NULL,
      attachments_json TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      workspace_json TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      time_zone TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      pause_reason TEXT,
      pause_detail TEXT,
      next_run_at TEXT,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS automation_runs (
      run_id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      thread_id TEXT,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      triggered_at TEXT NOT NULL,
      coalesced_through TEXT,
      missed_occurrences INTEGER NOT NULL,
      missed_occurrences_exact INTEGER NOT NULL,
      definition_revision INTEGER NOT NULL,
      detail TEXT,
      occurrence_key TEXT NOT NULL,
      UNIQUE (automation_id, occurrence_key),
      UNIQUE (thread_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS automation_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL
    )
  `;
  yield* sql`
    INSERT OR IGNORE INTO automation_state (singleton, revision)
    VALUES (1, 0)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automations_due
    ON automations(enabled, next_run_at)
    WHERE deleted_at IS NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automation_runs_history
    ON automation_runs(automation_id, triggered_at DESC, run_id DESC)
  `;
});
