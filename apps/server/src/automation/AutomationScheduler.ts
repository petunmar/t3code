// @effect-diagnostics globalDate:off globalDateInEffect:off -- Croner consumes native Date instances.
import type { AutomationId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as AutomationRunner from "./AutomationRunner.ts";
import * as AutomationService from "./AutomationService.ts";
import { coalesceAutomationOccurrences } from "./cron.ts";

const MAX_IDLE_SLEEP = Duration.hours(24);

const make = Effect.gen(function* () {
  const service = yield* AutomationService.AutomationService;
  const runner = yield* AutomationRunner.AutomationRunner;
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
  const wakeQueue = yield* Queue.sliding<void>(1);

  const wake = Queue.offer(wakeQueue, undefined).pipe(Effect.asVoid);

  const runDue = Effect.fn("AutomationScheduler.runDue")(function* () {
    const nowDateTime = yield* DateTime.now;
    const now = DateTime.toDateUtc(nowDateTime);
    const triggeredAt = DateTime.formatIso(nowDateTime);
    const due = yield* service.listDue(triggeredAt);
    yield* Effect.forEach(
      due,
      (automation) => {
        if (automation.nextRunAt === null) return Effect.void;
        const occurrence = coalesceAutomationOccurrences({
          schedule: automation.schedule,
          firstDueAt: automation.nextRunAt,
          now,
        });
        return runner
          .runOccurrence({
            automationId: automation.id as AutomationId,
            trigger: occurrence.missedOccurrences.value > 1 ? "catch-up" : "scheduled",
            scheduledFor: occurrence.scheduledFor,
            triggeredAt,
            coalescedThrough: occurrence.coalescedThrough,
            missedOccurrences: occurrence.missedOccurrences,
            nextRunAt: occurrence.nextRunAt,
            occurrenceKey: `schedule:${occurrence.scheduledFor}`,
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Automation occurrence failed", {
                automationId: automation.id,
                detail: error.message,
              }),
            ),
          );
      },
      { concurrency: 1, discard: true },
    );
  });

  const waitForNext = Effect.gen(function* () {
    const nextDueAt = yield* service.getNextDueAt();
    const nowMillis = yield* Clock.currentTimeMillis;
    const delay =
      nextDueAt === null
        ? MAX_IDLE_SLEEP
        : Duration.millis(Math.max(0, new Date(nextDueAt).getTime() - nowMillis));
    yield* Effect.raceFirst(Queue.take(wakeQueue), Effect.sleep(delay));
  });

  const loop = startup.awaitCommandReady.pipe(
    Effect.andThen(
      Effect.forever(
        runDue().pipe(
          Effect.catch((error) =>
            Effect.logWarning("Automation scheduler cycle failed", { detail: error.message }),
          ),
          Effect.andThen(waitForNext),
        ),
      ),
    ),
  );
  yield* Effect.forkScoped(loop);

  return { wake };
});

export class AutomationScheduler extends Context.Service<
  AutomationScheduler,
  Effect.Success<typeof make>
>()("t3/automation/AutomationScheduler") {}

export const layer = Layer.effect(AutomationScheduler, make);
