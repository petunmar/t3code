import {
  AutomationId,
  AutomationRunId,
  type AutomationSnapshot,
  type AutomationSummary,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyAutomationStreamEvent } from "./automation.ts";

function automation(id: string): AutomationSummary {
  return {
    id: AutomationId.make(id),
    projectId: ProjectId.make("project-1"),
    name: id,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    workspace: { kind: "project-checkout", expectedBranch: null },
    schedule: { cronExpression: "0 9 * * *", timeZone: "UTC" },
    enabled: true,
    pauseReason: null,
    pauseDetail: null,
    nextRunAt: "2026-01-02T09:00:00.000Z",
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastRun: null,
  };
}

describe("Automation stream reducer", () => {
  it("upserts definitions, run state, and removals", () => {
    const initial: AutomationSnapshot = { revision: 0, automations: [] };
    const definition = automation("automation-1");
    const upserted = applyAutomationStreamEvent(initial, {
      type: "automation-upserted",
      revision: 1,
      automation: definition,
    });
    const withRun = applyAutomationStreamEvent(upserted, {
      type: "run-upserted",
      revision: 2,
      run: {
        id: AutomationRunId.make("run-1"),
        automationId: definition.id,
        threadId: ThreadId.make("thread-1"),
        trigger: "scheduled",
        status: "running",
        scheduledFor: "2026-01-02T09:00:00.000Z",
        triggeredAt: "2026-01-02T09:00:00.000Z",
        coalescedThrough: null,
        missedOccurrences: { value: 1, exact: true },
        definitionRevision: 1,
        detail: null,
      },
    });

    expect(withRun.automations[0]?.lastRun?.status).toBe("running");
    expect(
      applyAutomationStreamEvent(withRun, {
        type: "automation-removed",
        revision: 3,
        automationId: definition.id,
      }),
    ).toEqual({ revision: 3, automations: [] });
  });

  it("does not replace a latest run with an older event", () => {
    const definition = {
      ...automation("automation-1"),
      lastRun: {
        runId: AutomationRunId.make("run-new"),
        status: "completed" as const,
        triggeredAt: "2026-01-03T09:00:00.000Z",
        threadId: ThreadId.make("thread-new"),
        detail: null,
      },
    };
    const result = applyAutomationStreamEvent(
      { revision: 4, automations: [definition] },
      {
        type: "run-upserted",
        revision: 5,
        run: {
          id: AutomationRunId.make("run-old"),
          automationId: definition.id,
          threadId: ThreadId.make("thread-old"),
          trigger: "scheduled",
          status: "running",
          scheduledFor: "2026-01-02T09:00:00.000Z",
          triggeredAt: "2026-01-02T09:00:00.000Z",
          coalescedThrough: null,
          missedOccurrences: { value: 1, exact: true },
          definitionRevision: 1,
          detail: null,
        },
      },
    );

    expect(result.automations[0]?.lastRun?.runId).toBe("run-new");
  });
});
