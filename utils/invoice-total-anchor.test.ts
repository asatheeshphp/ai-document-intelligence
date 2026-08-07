import { describe, expect, it } from "vitest";
import { findTotalAnchor, resolveInvoiceTotal } from "@/utils/invoice-total-anchor";

const EMPTY_TOTALS = {
  subtotal: null,
  totalTax: null,
  discount: null,
  shippingCharge: null,
  grandTotal: null,
  amountInWords: null,
};

describe("findTotalAnchor", () => {
  it("extracts the Total line, not Sub Total or Balance Due", () => {
    const text = `Sub Total 55,539.00\nTotal $55,539.00\nPayment Made (-) 539.00\nBalance Due $55,000.00`;
    expect(findTotalAnchor(text)).toBe(55539);
  });

  it("handles a plain decimal amount with no currency symbol", () => {
    expect(findTotalAnchor("Total: 1,234.56")).toBe(1234.56);
  });

  it("does not match Total Tax or Total Items lines", () => {
    expect(findTotalAnchor("Total Tax: 100.00\nTotal Items: 5")).toBeNull();
  });

  it("returns null when no Total line is present", () => {
    expect(findTotalAnchor("Amount Due $19.00")).toBeNull();
  });
});

describe("resolveInvoiceTotal", () => {
  const textWithTotalLine = `Sub Total 55,539.00\nTotal $55,539.00\nPayment Made (-) 539.00\nBalance Due $55,000.00`;

  it("prefers the printed Total line over the model's grandTotal when they disagree", () => {
    const totals = { ...EMPTY_TOTALS, subtotal: 55539, grandTotal: 55000 };
    expect(resolveInvoiceTotal(textWithTotalLine, totals)).toBe(55539);
  });

  it("computes from parts when no printed Total line exists", () => {
    const totals = { ...EMPTY_TOTALS, subtotal: 100, totalTax: 18, discount: 5, shippingCharge: 10 };
    expect(resolveInvoiceTotal("no total line here", totals)).toBe(123);
  });

  it("treats missing tax/discount/shipping as zero when computing from parts", () => {
    const totals = { ...EMPTY_TOTALS, subtotal: 100 };
    expect(resolveInvoiceTotal("no total line here", totals)).toBe(100);
  });

  it("falls back to the model's grandTotal when there is no anchor and no subtotal", () => {
    const totals = { ...EMPTY_TOTALS, grandTotal: 42 };
    expect(resolveInvoiceTotal("no total line here", totals)).toBe(42);
  });

  it("returns undefined when nothing is available at all", () => {
    expect(resolveInvoiceTotal("no total line here", EMPTY_TOTALS)).toBeUndefined();
  });

  it("discards an anchor that matches totalTax -- a tax-column footer, not the grand total", () => {
    // Real layout: "TOTAL:" sums just the CGST+SGST columns (86.80); the actual invoice
    // amount (569.00) sits right after it on the same line, so the anchor regex grabs
    // the tax subtotal instead. The model's own grandTotal was correct here.
    const text = "TOTAL: \n₹86.80 ₹569.00";
    const totals = { ...EMPTY_TOTALS, totalTax: 86.8, grandTotal: 569 };
    expect(resolveInvoiceTotal(text, totals)).toBe(569);
  });

  it("still uses the anchor when it does not match totalTax", () => {
    const text = "TOTAL: \n₹86.80 ₹569.00";
    const totals = { ...EMPTY_TOTALS, totalTax: 50, grandTotal: 569 };
    expect(resolveInvoiceTotal(text, totals)).toBe(86.8);
  });
});
