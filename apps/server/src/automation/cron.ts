// @effect-diagnostics globalDate:off globalDateInEffect:off -- Croner evaluates native Date instances at its boundary.
import { AutomationRpcError, type AutomationSchedule } from "@t3tools/contracts";
import { Cron } from "croner";

const STANDARD_FIELD = /^[0-9a-z*,/-]+$/i;
const FORBIDDEN_EXTENSION = /[?#+@]|(^|[^a-z])(?:lw|l|w)(?=$|[^a-z])/i;

function normalizedExpression(expression: string): string {
  return expression.trim().split(/\s+/).join(" ");
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(new Date(0));
  } catch {
    throw new AutomationRpcError({
      code: "invalid-schedule",
      message: `Unknown IANA timezone '${timeZone}'.`,
    });
  }
}

export function parseAutomationSchedule(schedule: AutomationSchedule): {
  readonly expression: string;
  readonly timeZone: string;
  readonly cron: Cron;
} {
  const expression = normalizedExpression(schedule.cronExpression);
  const fields = expression.split(" ");
  if (
    fields.length !== 5 ||
    fields.some((field) => !STANDARD_FIELD.test(field) || FORBIDDEN_EXTENSION.test(field))
  ) {
    throw new AutomationRpcError({
      code: "invalid-schedule",
      message:
        "Use a standard five-field CRON expression: minute hour day-of-month month day-of-week.",
    });
  }
  assertTimeZone(schedule.timeZone);
  try {
    return {
      expression,
      timeZone: schedule.timeZone,
      cron: new Cron(expression, {
        timezone: schedule.timeZone,
        paused: true,
        domAndDow: false,
        alternativeWeekdays: false,
      }),
    };
  } catch (cause) {
    throw new AutomationRpcError({
      code: "invalid-schedule",
      message: cause instanceof Error ? cause.message : "Invalid CRON expression.",
    });
  }
}

export function previewAutomationSchedule(
  schedule: AutomationSchedule,
  from = new Date(),
): { readonly normalizedCronExpression: string; readonly nextRuns: ReadonlyArray<string> } {
  const parsed = parseAutomationSchedule(schedule);
  const nextRuns = parsed.cron.nextRuns(5, from).map((date) => date.toISOString());
  if (nextRuns.length !== 5) {
    throw new AutomationRpcError({
      code: "invalid-schedule",
      message: "The CRON expression does not produce five future occurrences.",
    });
  }
  return { normalizedCronExpression: parsed.expression, nextRuns };
}

export function nextAutomationRunAt(schedule: AutomationSchedule, after: Date): string {
  const next = parseAutomationSchedule(schedule).cron.nextRun(after);
  if (next === null) {
    throw new AutomationRpcError({
      code: "invalid-schedule",
      message: "The CRON expression has no future occurrence.",
    });
  }
  return next.toISOString();
}

export interface CoalescedAutomationOccurrences {
  readonly scheduledFor: string;
  readonly coalescedThrough: string | null;
  readonly missedOccurrences: { readonly value: number; readonly exact: boolean };
  readonly nextRunAt: string;
}

export function coalesceAutomationOccurrences(input: {
  readonly schedule: AutomationSchedule;
  readonly firstDueAt: string;
  readonly now: Date;
  readonly countLimit?: number;
}): CoalescedAutomationOccurrences {
  const countLimit = input.countLimit ?? 100_000;
  const parsed = parseAutomationSchedule(input.schedule);
  let current = new Date(input.firstDueAt);
  let count = 1;
  let exact = true;
  let coalescedThrough = input.firstDueAt;

  while (count < countLimit) {
    const next = parsed.cron.nextRun(current);
    if (next === null || next.getTime() > input.now.getTime()) {
      return {
        scheduledFor: input.firstDueAt,
        coalescedThrough: count > 1 ? coalescedThrough : null,
        missedOccurrences: { value: count, exact },
        nextRunAt:
          next?.toISOString() ??
          nextAutomationRunAt(input.schedule, new Date(input.now.getTime() + 1)),
      };
    }
    current = next;
    coalescedThrough = next.toISOString();
    count += 1;
  }

  exact = false;
  return {
    scheduledFor: input.firstDueAt,
    coalescedThrough,
    missedOccurrences: { value: countLimit, exact },
    nextRunAt: nextAutomationRunAt(input.schedule, input.now),
  };
}
