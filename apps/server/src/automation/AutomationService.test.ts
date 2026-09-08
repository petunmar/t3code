import * as NodeServices from "@effect/platform-node/NodeServices";
import { AutomationId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as AutomationService from "./AutomationService.ts";

const AutomationServiceTestLayer = AutomationService.AutomationServiceLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-automation-test-" })),
);

const createDefinition = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const service = yield* AutomationService.AutomationService;
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
    name: "Daily review",
    message: { text: "Review the project", attachments: [] },
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    workspace: { kind: "project-checkout", expectedBranch: null },
    schedule: { cronExpression: "0 9 * * *", timeZone: "UTC" },
    enabled: true,
  });
});

it.layer(NodeServices.layer)("AutomationService", (it) => {
  it.effect("claims concurrent occurrences without ever overlapping", () =>
    Effect.gen(function* () {
      const service = yield* AutomationService.AutomationService;
      const definition = yield* createDefinition;
      const claim = (suffix: string) =>
        service.claimRun({
          automationId: AutomationId.make(definition.id),
          trigger: "scheduled",
          scheduledFor: `2026-01-02T09:0${suffix}:00.000Z`,
          triggeredAt: "2026-01-02T09:10:00.000Z",
          coalescedThrough: null,
          missedOccurrences: { value: 1, exact: true },
          nextRunAt: "2026-01-03T09:00:00.000Z",
          occurrenceKey: `schedule:${suffix}`,
        });
      const claims = yield* Effect.all([claim("0"), claim("1")], { concurrency: "unbounded" });

      expect(claims.map(({ run }) => run.status).toSorted()).toEqual(["launching", "skipped"]);
    }).pipe(Effect.provide(AutomationServiceTestLayer)),
  );

  it.effect("rejects Run now while an earlier run is active", () =>
    Effect.gen(function* () {
      const service = yield* AutomationService.AutomationService;
      const definition = yield* createDefinition;
      yield* service.claimRun({
        automationId: definition.id,
        trigger: "scheduled",
        scheduledFor: "2026-01-02T09:00:00.000Z",
        triggeredAt: "2026-01-02T09:00:00.000Z",
        coalescedThrough: null,
        missedOccurrences: { value: 1, exact: true },
        nextRunAt: "2026-01-03T09:00:00.000Z",
        occurrenceKey: "schedule:one",
      });
      const error = yield* Effect.flip(
        service.claimRun({
          automationId: definition.id,
          trigger: "manual",
          scheduledFor: "2026-01-02T09:01:00.000Z",
          triggeredAt: "2026-01-02T09:01:00.000Z",
          coalescedThrough: null,
          missedOccurrences: { value: 1, exact: true },
          occurrenceKey: "manual:one",
        }),
      );

      expect(error.code).toBe("overlap");
    }).pipe(Effect.provide(AutomationServiceTestLayer)),
  );
});
