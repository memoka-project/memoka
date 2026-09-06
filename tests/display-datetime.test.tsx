import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventDateTime } from "../app/src/components/EventDateTime";
import {
  formatDisplayDateTime,
  formatElapsedTime,
  formatEventDateTime,
} from "../app/src/core/display-datetime";

describe("GUI date/time presentation", () => {
  afterEach(() => vi.useRealTimers());
  it("zero-pads local calendar components and uses midnight in 24-hour time", () => {
    const midnight = new Date(2026, 0, 2, 0, 4, 5);
    expect(formatDisplayDateTime(midnight.toISOString())).toBe(
      "2026/01/02 00:04:05",
    );
    expect(
      formatDisplayDateTime(new Date(2026, 8, 6, 23, 59, 1).toISOString()),
    ).toBe("2026/09/06 23:59:01");
    expect(formatDisplayDateTime("2026-09-06T09:00:00+09:00")).toBe(
      formatDisplayDateTime("2026-09-06T00:00:00Z"),
    );
  });
  it.each([
    [0, "0s"],
    [59, "59s"],
    [60, "1m"],
    [3599, "59m"],
    [3600, "1h"],
    [86399, "23h"],
    [86400, "1d"],
    [30 * 86400, "1mo"],
    [360 * 86400, "12mo"],
    [365 * 86400, "1y"],
  ] as const)(
    "formats elapsed %s seconds without zero-year artifacts",
    (seconds, result) => {
      const now = Date.parse("2026-09-06T00:00:00Z");
      expect(
        formatElapsedTime(new Date(now - seconds * 1000).toISOString(), now),
      ).toBe(result + " ago");
    },
  );
  it("does not call future or invalid events ago", () => {
    const now = Date.parse("2026-09-06T00:00:00Z");
    expect(formatElapsedTime("2026-09-07T00:00:00Z", now)).toBeNull();
    expect(formatEventDateTime("invalid", now)).toBe("—");
    expect(formatEventDateTime("2026-09-07T00:00:00Z", now)).not.toContain(
      "ago",
    );
  });
  it("ticks only timestamp leaves with one shared clock and stops when hidden", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T00:00:10Z"));
    let parentRenders = 0;
    function Parent() {
      parentRenders++;
      return (
        <>
          <EventDateTime value="2026-09-06T00:00:00Z" />
          <EventDateTime value="2026-09-06T00:00:01Z" />
        </>
      );
    }
    const rendered = render(<Parent />);
    expect(screen.getByText(/\(10s ago\)/)).toBeTruthy();
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByText(/\(12s ago\)/)).toBeTruthy();
    expect(parentRenders).toBe(1);
    rendered.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
