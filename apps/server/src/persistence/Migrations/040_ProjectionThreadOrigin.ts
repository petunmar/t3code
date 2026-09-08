import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN origin_json TEXT`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_origin_automation
    ON projection_threads(json_extract(origin_json, '$.automationId'))
    WHERE origin_json IS NOT NULL
  `;
});
