import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Trigger history follows V2 runs, falling back to V1 for threads awaiting import.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE VIEW fork_trigger_thread_status AS
    SELECT
      threads.thread_id,
      threads.deleted_at,
      runs.run_id AS latest_turn_id,
      CASE
        WHEN runs.status IN ('preparing', 'queued', 'starting', 'running') THEN 'running'
        WHEN runs.status = 'failed' THEN 'error'
        WHEN runs.status IN ('cancelled', 'rolled_back') THEN 'interrupted'
        WHEN runs.status = 'waiting' THEN 'running'
        ELSE 'idle'
      END AS session_status,
      CASE WHEN runs.status = 'failed' THEN 'error'
           WHEN runs.status IN ('cancelled', 'rolled_back') THEN 'interrupted'
           ELSE runs.status END AS turn_state,
      NULL AS last_error,
      CASE WHEN runs.status = 'waiting' THEN 1 ELSE 0 END AS pending_approval_count,
      0 AS pending_user_input_count
    FROM orchestration_v2_projection_threads AS threads
    LEFT JOIN orchestration_v2_projection_runs AS runs ON runs.run_id = (
      SELECT run_id FROM orchestration_v2_projection_runs
      WHERE thread_id = threads.thread_id ORDER BY ordinal DESC LIMIT 1
    )
    UNION ALL
    SELECT threads.thread_id, threads.deleted_at, threads.latest_turn_id,
      sessions.status, turns.state, sessions.last_error,
      threads.pending_approval_count, threads.pending_user_input_count
    FROM projection_threads AS threads
    LEFT JOIN projection_thread_sessions AS sessions ON sessions.thread_id = threads.thread_id
    LEFT JOIN projection_turns AS turns ON turns.thread_id = threads.thread_id AND turns.turn_id = threads.latest_turn_id
    WHERE NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_threads AS v2 WHERE v2.thread_id = threads.thread_id)
  `;
});
