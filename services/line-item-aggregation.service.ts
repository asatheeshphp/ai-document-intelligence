import { SearchService } from "@/services/search.service";
import { ProcessingRepository } from "@/repositories/processing.repository";

// Mirrors SearchService's own MAX_TOP_K cap (not exported from there, since it's meant
// as an internal safety limit, not a public constant) -- this aggregation wants as much
// recall as SearchService allows, since undercounting silently produces a wrong total.
const MAX_LINE_ITEM_RESULTS = 50;

export interface LineItemAggregationItem {
  invoiceNumber?: string;
  vendorName?: string;
  description: string;
  amount: number;
}

export interface LineItemAggregationSummary {
  keyword: string;
  totalAmount: number;
  currencies: string[];
  items: LineItemAggregationItem[];
}

// Every line-item chunk observed in this corpus ends with its own extracted total in
// this exact "amount <value>" shape (e.g. "..., unit price 4069.53, amount 4069.53") --
// this is the SOURCE OF TRUTH line total already computed once during extraction, not
// something to recompute from qty * unit price (which isn't reliably consistent across
// differently-formatted invoices in this corpus).
const LINE_ITEM_AMOUNT_PATTERN = /amount\s+([\d,]+\.?\d*)/i;

function extractLineItemAmount(chunkText: string): number | null {
  const match = chunkText.match(LINE_ITEM_AMOUNT_PATTERN);
  if (!match) return null;
  const value = parseFloat(match[1].replace(/,/g, ""));
  return Number.isNaN(value) ? null : value;
}

// Confirmed live: asked to "summarize the total computer invoice related amount", the
// model picked a garbled per-unit-price fragment ($1,330.29) out of a line item's raw
// text and then did its own (sometimes wrong) arithmetic on top of it -- "$1,330.29 * 3
// = $4,000.87" doesn't even multiply correctly, and the real per-line total (4069.53,
// already sitting right there in that same chunk's own "amount" field) was never used.
// Same "never let the model touch the arithmetic" principle SpendQueryService already
// established for vendor totals, applied here to product/category totals instead.
export class LineItemAggregationService {
  constructor(
    private readonly searchService: SearchService = new SearchService(),
    private readonly repository: ProcessingRepository = new ProcessingRepository()
  ) {}

  async getLineItemTotal(keyword: string): Promise<LineItemAggregationSummary | null> {
    const { results } = await this.searchService.search({
      query: keyword,
      topK: MAX_LINE_ITEM_RESULTS,
      filters: { chunkType: "line_items" },
    });

    const matched = results
      .map((result) => {
        const amount = extractLineItemAmount(result.chunkText);
        if (amount === null) return null;
        return {
          invoiceId: result.invoiceId,
          invoiceNumber: result.invoice?.invoiceNumber,
          vendorName: result.invoice?.vendorName,
          description: result.chunkText,
          amount,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    if (matched.length === 0) return null;

    const invoiceIds = [...new Set(matched.map((item) => item.invoiceId))];
    const invoices = await this.repository.findInvoicesByIds(invoiceIds);
    const currencyByInvoiceId = new Map(invoices.map((invoice) => [invoice._id.toString(), invoice.currency]));

    const currencies = [
      ...new Set(matched.map((item) => currencyByInvoiceId.get(item.invoiceId)).filter((value): value is string => Boolean(value))),
    ];

    return {
      keyword,
      totalAmount: matched.reduce((sum, item) => sum + item.amount, 0),
      currencies,
      items: matched.map(({ invoiceId, ...item }) => item),
    };
  }
}
