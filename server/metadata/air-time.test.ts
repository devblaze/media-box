import { describe, expect, test } from "vitest";
import {
  airDateToUtc,
  countryUtcOffsetMinutes,
  DEFAULT_AIR_HOUR_LOCAL,
} from "./air-time";

describe("countryUtcOffsetMinutes", () => {
  test("known countries map to their representative standard-time offset", () => {
    expect(countryUtcOffsetMinutes("US")).toBe(-300); // Eastern
    expect(countryUtcOffsetMinutes("GB")).toBe(0);
    expect(countryUtcOffsetMinutes("JP")).toBe(540);
    expect(countryUtcOffsetMinutes("AU")).toBe(600);
  });

  test("lookup is case-insensitive", () => {
    expect(countryUtcOffsetMinutes("us")).toBe(-300);
    expect(countryUtcOffsetMinutes("jp")).toBe(540);
  });

  test("unknown / missing country falls back to 0 (UTC)", () => {
    expect(countryUtcOffsetMinutes("ZZ")).toBe(0);
    expect(countryUtcOffsetMinutes(null)).toBe(0);
    expect(countryUtcOffsetMinutes(undefined)).toBe(0);
    expect(countryUtcOffsetMinutes("")).toBe(0);
  });
});

describe("airDateToUtc", () => {
  test("assumed local air hour is prime-time 20:00", () => {
    expect(DEFAULT_AIR_HOUR_LOCAL).toBe(20);
  });

  test("US air date lands next-day 01:00Z (20:00 Eastern)", () => {
    const d = airDateToUtc("2026-03-10", "US");
    expect(d?.toISOString()).toBe("2026-03-11T01:00:00.000Z");
  });

  test("GB air date lands same-day 20:00Z", () => {
    const d = airDateToUtc("2026-03-10", "GB");
    expect(d?.toISOString()).toBe("2026-03-10T20:00:00.000Z");
  });

  test("JP air date lands same-day 11:00Z (20:00 JST)", () => {
    const d = airDateToUtc("2026-03-10", "JP");
    expect(d?.toISOString()).toBe("2026-03-10T11:00:00.000Z");
  });

  test("unknown country falls back to 20:00 UTC", () => {
    expect(airDateToUtc("2026-03-10", "ZZ")?.toISOString()).toBe(
      "2026-03-10T20:00:00.000Z"
    );
    expect(airDateToUtc("2026-03-10", null)?.toISOString()).toBe(
      "2026-03-10T20:00:00.000Z"
    );
    expect(airDateToUtc("2026-03-10", undefined)?.toISOString()).toBe(
      "2026-03-10T20:00:00.000Z"
    );
  });

  test("US offset works across a month boundary", () => {
    // 20:00 ET on Jan 31 = 01:00Z on Feb 1.
    expect(airDateToUtc("2026-01-31", "US")?.toISOString()).toBe(
      "2026-02-01T01:00:00.000Z"
    );
  });

  test("missing date returns null", () => {
    expect(airDateToUtc(null, "US")).toBeNull();
    expect(airDateToUtc(undefined, "US")).toBeNull();
    expect(airDateToUtc("", "US")).toBeNull();
  });

  test("malformed dates return null", () => {
    expect(airDateToUtc("not-a-date", "US")).toBeNull();
    expect(airDateToUtc("2026", "US")).toBeNull(); // no month/day parts
    expect(airDateToUtc("2026-03", "US")).toBeNull(); // no day part
    expect(airDateToUtc("abcd-ef-gh", "GB")).toBeNull(); // NaN parts
    expect(airDateToUtc("2026-00-10", "GB")).toBeNull(); // zero month is falsy
    expect(airDateToUtc("2026-03-00", "GB")).toBeNull(); // zero day is falsy
  });
});
