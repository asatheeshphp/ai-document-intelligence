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

  it("recognizes Spanish month names", () => {
    const range = extractDateRangeFromQuery("¿Qué se facturó en julio de 2026?");
    expect(range?.from.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(range?.to.toISOString()).toBe("2026-07-31T23:59:59.999Z");
  });

  it("recognizes French month names, including accented ones", () => {
    const range = extractDateRangeFromQuery("Qu'est-ce qui a été facturé en juillet 2026 ?");
    expect(range?.from.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("recognizes Tamil month names", () => {
    // \b doesn't bound non-Latin scripts in JS regex -- this is the real regression test
    // for the Unicode-aware lookaround fix, not just a language-coverage check.
    const range = extractDateRangeFromQuery("ஜூலை 2026-ல் என்னென்ன பில் செய்யப்பட்டது?");
    expect(range?.from.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(range?.to.toISOString()).toBe("2026-07-31T23:59:59.999Z");
  });

  it("recognizes Telugu month names", () => {
    const range = extractDateRangeFromQuery("జూలై 2026లో ఏమేమి బిల్ చేయబడ్డాయి?");
    expect(range?.from.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(range?.to.toISOString()).toBe("2026-07-31T23:59:59.999Z");
  });
});
