import { describe, it, expect } from "vitest";
import { extractDateRangeFromQuery } from "@/utils/date-range-from-query";

describe("extractDateRangeFromQuery", () => {
  it("returns null when no month is named", () => {
    expect(extractDateRangeFromQuery("Which invoice has fuel surcharge?")).toBeNull();
  });

  it("infers the reference year when only a month is named", () => {
    const reference = new Date(Date.UTC(2026, 6, 28));
    const range = extractDateRangeFromQuery("What was billed in July?", reference);

    expect(range).not.toBeNull();
    expect(range?.from.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(range?.to.toISOString()).toBe("2026-07-31T23:59:59.999Z");
  });

  it("uses an explicit year when the query states one", () => {
    const range = extractDateRangeFromQuery("invoices from March 2014");

    expect(range?.from.toISOString()).toBe("2014-03-01T00:00:00.000Z");
    expect(range?.to.toISOString()).toBe("2014-03-31T23:59:59.999Z");
  });

  it("is case-insensitive", () => {
    const range = extractDateRangeFromQuery("JUNE 2020 charges");
    expect(range?.from.getUTCMonth()).toBe(5);
  });

  it("handles a 30-day month correctly", () => {
    const range = extractDateRangeFromQuery("June 2026 invoices");
    expect(range?.to.toISOString()).toBe("2026-06-30T23:59:59.999Z");
  });
});
