// @effect-diagnostics globalDate:off -- Cron behavior is tested at its native Date boundary.
import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  coalesceAutomationOccurrences,
  nextAutomationRunAt,
  parseAutomationSchedule,
  previewAutomationSchedule,
} from "./cron.ts";

describe("Automation CRON schedules", () => {
  it("normalizes a standard five-field expression and previews in its timezone", () => {
    const preview = previewAutomationSchedule(
      { cronExpression: "  */15   * * * * ", timeZone: "UTC" },
      new Date("2026-01-01T00:07:00.000Z"),
    );

    NodeAssert.equal(preview.normalizedCronExpression, "*/15 * * * *");
    NodeAssert.deepEqual(preview.nextRuns, [
      "2026-01-01T00:15:00.000Z",
      "2026-01-01T00:30:00.000Z",
      "2026-01-01T00:45:00.000Z",
      "2026-01-01T01:00:00.000Z",
      "2026-01-01T01:15:00.000Z",
    ]);
  });

  it("rejects seconds, Quartz extensions, and unknown timezones", () => {
    NodeAssert.throws(
      () => parseAutomationSchedule({ cronExpression: "0 0 9 * * 1", timeZone: "UTC" }),
      { code: "invalid-schedule" },
    );
    NodeAssert.throws(
      () => parseAutomationSchedule({ cronExpression: "0 9 ? * 1", timeZone: "UTC" }),
      { code: "invalid-schedule" },
    );
    NodeAssert.throws(
      () => parseAutomationSchedule({ cronExpression: "0 9 * * 1", timeZone: "Moon/Base" }),
      { code: "invalid-schedule" },
    );
  });

  it("accepts standard named months and weekdays", () => {
    NodeAssert.doesNotThrow(() =>
      parseAutomationSchedule({
        cronExpression: "0 9 * JUL MON-WED",
        timeZone: "UTC",
      }),
    );
  });

  it("coalesces missed occurrences into one catch-up run", () => {
    NodeAssert.deepEqual(
      coalesceAutomationOccurrences({
        schedule: { cronExpression: "* * * * *", timeZone: "UTC" },
        firstDueAt: "2026-01-01T00:01:00.000Z",
        now: new Date("2026-01-01T00:05:30.000Z"),
      }),
      {
        scheduledFor: "2026-01-01T00:01:00.000Z",
        coalescedThrough: "2026-01-01T00:05:00.000Z",
        missedOccurrences: { value: 5, exact: true },
        nextRunAt: "2026-01-01T00:06:00.000Z",
      },
    );
  });

  it("caps catch-up counting without replaying the remaining backlog", () => {
    const result = coalesceAutomationOccurrences({
      schedule: { cronExpression: "* * * * *", timeZone: "UTC" },
      firstDueAt: "2026-01-01T00:01:00.000Z",
      now: new Date("2026-01-01T00:10:30.000Z"),
      countLimit: 3,
    });

    NodeAssert.deepEqual(result.missedOccurrences, { value: 3, exact: false });
    NodeAssert.equal(result.coalescedThrough, "2026-01-01T00:03:00.000Z");
    NodeAssert.equal(result.nextRunAt, "2026-01-01T00:11:00.000Z");
  });

  it("computes the next occurrence strictly after the supplied instant", () => {
    NodeAssert.equal(
      nextAutomationRunAt(
        { cronExpression: "0 9 * * 1-5", timeZone: "UTC" },
        new Date("2026-01-02T09:00:00.000Z"),
      ),
      "2026-01-05T09:00:00.000Z",
    );
  });
});
