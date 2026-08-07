import type { InvoiceExtraction } from "@/schemas/invoice.schema";

// A layered, priority-ordered resolver for the invoice's grand total. Never trusts the
// extraction model to both READ a number and COMPUTE a total in one step -- qwen2.5:1.5b
// (the configured OLLAMA_CHAT_MODEL) is reliable at single-field lookups but not at that
// combination. Confirmed live on one real invoice: five separate extraction attempts
// (increasingly explicit prompt wording, a worked example) returned five different wrong
// grandTotal values, while the parts feeding a from-scratch computation (subtotal,
// totalTax) were themselves inconsistent run to run too -- so "compute from the model's
// parts" alone isn't a fix either. Only the literal printed "Total" line stayed correct
// every time, because it never depends on the model at all. Hence the priority order:
//
//   1. A printed "Total" line, read directly out of the source text (most reliable --
//      no model involved).
//   2. A computed total from the model's own subtotal/tax/discount/shipping fields, but
//      only when there's no printed line to read directly.
//   3. The model's own reported grandTotal, as a last resort when neither of the above
//      is available.
//
// Deliberately excludes "Sub Total" (negative lookbehind) and anything not immediately
// followed by either a currency symbol or a 2-decimal amount -- "Total Items: 5" or
// "Total Tax: 100.00" must not match, only a monetary "Total" line should.
const TOTAL_LINE_PATTERN =
  /(?<!Sub[\s-])\bTotal\b(?:\s+(?:Amount|Due|Payable))?\s*[:\-]?\s*(?:[$€£₹]\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)|(\d{1,3}(?:,\d{3})*\.\d{2}))/i;

export function findTotalAnchor(documentText: string): number | null {
  const match = TOTAL_LINE_PATTERN.exec(documentText);
  if (!match) return null;

  const raw = match[1] ?? match[2];
  const value = Number(raw.replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

function computeTotalFromParts(totals: InvoiceExtraction["totals"]): number | null {
  if (totals.subtotal == null) return null;
  return totals.subtotal + (totals.totalTax ?? 0) - (totals.discount ?? 0) + (totals.shippingCharge ?? 0);
}

// A "Total" line is not always the invoice's grand total -- a tax-column footer (e.g.
// "TOTAL: ₹86.80 ₹569.00", where 86.80 sums just the CGST+SGST columns and 569.00 is the
// actual invoice amount sitting right after it on the same line) also matches the
// pattern and reads as a false anchor: the regex grabs the *first* number after "Total",
// which here is the tax subtotal, not the grand total. Confirmed live: the model's own
// grandTotal (569) was correct while the anchor (86.80) overrode it with the tax amount.
// An anchor that exactly matches the model's own totalTax is a strong, generic signal it
// found a tax-footer line rather than the real total -- not a guess specific to this
// invoice's layout -- so it's discarded rather than trusted.
function looksLikeATaxTotal(anchor: number, totals: InvoiceExtraction["totals"]): boolean {
  return totals.totalTax != null && Math.abs(anchor - totals.totalTax) < 0.01;
}

export function resolveInvoiceTotal(documentText: string, totals: InvoiceExtraction["totals"]): number | undefined {
  const anchor = findTotalAnchor(documentText);
  if (anchor != null && !looksLikeATaxTotal(anchor, totals)) return anchor;

  const computed = computeTotalFromParts(totals);
  if (computed != null) return computed;

  return totals.grandTotal ?? undefined;
}
