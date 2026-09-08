import {
  AUTOMATION_WS_METHODS,
  type AutomationSnapshot,
  type AutomationStreamEvent,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export const EMPTY_AUTOMATION_SNAPSHOT: AutomationSnapshot = {
  revision: 0,
  automations: [],
};

export function applyAutomationStreamEvent(
  current: AutomationSnapshot,
  event: AutomationStreamEvent,
): AutomationSnapshot {
  switch (event.type) {
    case "snapshot":
      return event.snapshot;
    case "automation-upserted":
      return {
        revision: event.revision,
        automations: [
          ...current.automations.filter((automation) => automation.id !== event.automation.id),
          event.automation,
        ].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      };
    case "automation-removed":
      return {
        revision: event.revision,
        automations: current.automations.filter(
          (automation) => automation.id !== event.automationId,
        ),
      };
    case "run-upserted":
      return {
        revision: event.revision,
        automations: current.automations.map((automation) =>
          automation.id !== event.run.automationId ||
          (automation.lastRun !== null && automation.lastRun.triggeredAt > event.run.triggeredAt)
            ? automation
            : {
                ...automation,
                lastRun: {
                  runId: event.run.id,
                  status: event.run.status,
                  triggeredAt: event.run.triggeredAt,
                  threadId: event.run.threadId,
                  detail: event.run.detail,
                },
              },
        ),
      };
  }
}

export function createAutomationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    snapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:automation:snapshot",
      tag: AUTOMATION_WS_METHODS.getSnapshot,
    }),
    changes: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:automation:changes",
      tag: AUTOMATION_WS_METHODS.subscribe,
      transform: (stream) =>
        stream.pipe(Stream.scan(EMPTY_AUTOMATION_SNAPSHOT, applyAutomationStreamEvent)),
    }),
    detail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:automation:detail",
      tag: AUTOMATION_WS_METHODS.getDetail,
    }),
    runs: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:automation:runs",
      tag: AUTOMATION_WS_METHODS.getRunsPage,
    }),
    previewSchedule: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:automation:preview-schedule",
      tag: AUTOMATION_WS_METHODS.previewSchedule,
      staleTimeMs: 60_000,
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:automation:create",
      tag: AUTOMATION_WS_METHODS.create,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:automation:update",
      tag: AUTOMATION_WS_METHODS.update,
    }),
    pause: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:automation:pause",
      tag: AUTOMATION_WS_METHODS.pause,
    }),
    resume: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:automation:resume",
      tag: AUTOMATION_WS_METHODS.resume,
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:automation:delete",
      tag: AUTOMATION_WS_METHODS.delete,
    }),
    runNow: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:automation:run-now",
      tag: AUTOMATION_WS_METHODS.runNow,
    }),
  };
}
