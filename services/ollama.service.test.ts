import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { OllamaService } from "@/services/ollama.service";
import { env } from "@/config/env";

vi.mock("axios");

describe("OllamaService.visionExtractText", () => {
  beforeEach(() => {
    vi.mocked(axios.post).mockReset();
  });

  it("posts images to /api/chat with the configured vision model and returns trimmed text", async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: { message: { content: "  Transcribed invoice text  " } },
    });

    const service = new OllamaService();
    const result = await service.visionExtractText(["base64imagedata"]);

    expect(result).toBe("Transcribed invoice text");

    const [url, body] = vi.mocked(axios.post).mock.calls[0] as [
      string,
      { model: string; messages: { images: string[] }[] },
    ];
    expect(url).toBe(`${env.OLLAMA_BASE_URL.replace(/\/$/, "")}/api/chat`);
    expect(body.model).toBe(env.OLLAMA_VISION_MODEL);
    expect(body.messages[0].images).toEqual(["base64imagedata"]);
  });

  it("accepts a model override", async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { message: { content: "text" } } });

    const service = new OllamaService();
    await service.visionExtractText(["img"], "custom-vision-model:7b");

    const [, body] = vi.mocked(axios.post).mock.calls[0] as [string, { model: string }];
    expect(body.model).toBe("custom-vision-model:7b");
  });

  it("scales the request timeout with the number of images, not a fixed ceiling", async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { message: { content: "text" } } });

    const service = new OllamaService();
    await service.visionExtractText(["page1"]);
    const [, , singlePageConfig] = vi.mocked(axios.post).mock.calls[0] as [string, unknown, { timeout: number }];

    vi.mocked(axios.post).mockClear();
    await service.visionExtractText(["page1", "page2", "page3"]);
    const [, , threePageConfig] = vi.mocked(axios.post).mock.calls[0] as [string, unknown, { timeout: number }];

    expect(threePageConfig.timeout).toBe(singlePageConfig.timeout * 3);
  });
});

describe("OllamaService.extractInvoiceData", () => {
  beforeEach(() => {
    vi.mocked(axios.post).mockReset();
  });

  const emptyAddress = { raw: null, street: null, city: null, state: null, postalCode: null, country: null };
  const emptyParty = { name: null, address: emptyAddress, taxId: null, email: null, phone: null };

  function baseExtractionResponse(overrides: Record<string, unknown> = {}) {
    return {
      invoice: { invoiceNumber: null, invoiceDate: null, dueDate: null, poNumber: null, currency: null, paymentTerms: null },
      supplier: emptyParty,
      customer: emptyParty,
      shipping: { address: emptyAddress, method: null, trackingNumber: null },
      lineItems: [],
      taxes: [],
      totals: { subtotal: null, totalTax: null, discount: null, shippingCharge: null, grandTotal: null, amountInWords: null },
      bankDetails: { bankName: null, accountName: null, accountNumber: null, ifscCode: null, swiftCode: null, branch: null },
      notes: null,
      references: [],
      additionalFields: {},
      ...overrides,
    };
  }

  it("nulls out an address.raw that looks like the whole invoice body was dumped into it", async () => {
    const bodyDump =
      "DELIVERY & TRANSPORT CHARGES INVOICE\nInvoice No: EXL-2026-2048\nSubtotal 29500\nGST (18%) 5310\nTotal Payable 34810\n";

    vi.mocked(axios.post).mockResolvedValue({
      data: {
        message: {
          content: JSON.stringify(
            baseExtractionResponse({
              supplier: { ...emptyParty, address: { ...emptyAddress, raw: bodyDump } },
              customer: { ...emptyParty, address: { ...emptyAddress, raw: "Coimbatore, Tamil Nadu, India" } },
            })
          ),
        },
      },
    });

    const service = new OllamaService();
    const outcome = await service.extractInvoiceData("some invoice text");

    expect(outcome.success).toBe(true);
    expect(outcome.data?.supplier.address.raw).toBeNull();
    expect(outcome.data?.customer.address.raw).toBe("Coimbatore, Tamil Nadu, India");
  });

  it("drops hallucinated tax entries with no rate and no real amount, keeping genuine ones", async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: {
        message: {
          content: JSON.stringify(
            baseExtractionResponse({
              taxes: [
                { type: "GST", rate: 18, amount: 5310 },
                { type: "CGST", rate: null, amount: null },
                { type: "SGST", rate: null, amount: 0 },
                { type: "Sales Tax", rate: null, amount: 0 },
                { type: "duty", rate: null, amount: null },
              ],
            })
          ),
        },
      },
    });

    const service = new OllamaService();
    const outcome = await service.extractInvoiceData("some invoice text");

    expect(outcome.success).toBe(true);
    expect(outcome.data?.taxes).toEqual([{ type: "GST", rate: 18, amount: 5310 }]);
  });

  it("keeps a tax entry that has a rate but no amount", async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: {
        message: {
          content: JSON.stringify(
            baseExtractionResponse({
              taxes: [{ type: "VAT", rate: 12, amount: null }],
            })
          ),
        },
      },
    });

    const service = new OllamaService();
    const outcome = await service.extractInvoiceData("some invoice text");

    expect(outcome.data?.taxes).toEqual([{ type: "VAT", rate: 12, amount: null }]);
  });
});

describe("OllamaService.classifyDocument", () => {
  beforeEach(() => {
    vi.mocked(axios.post).mockReset();
  });

  it("parses a valid schema-constrained classification response", async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: { message: { content: JSON.stringify({ documentType: "INVOICE", confidence: 0.88 }) } },
    });

    const service = new OllamaService();
    const outcome = await service.classifyDocument("some invoice text");

    expect(outcome.success).toBe(true);
    expect(outcome.data).toEqual({ documentType: "INVOICE", confidence: 0.88 });
  });

  it("returns a failure outcome on invalid JSON", async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: { message: { content: "not json" } },
    });

    const service = new OllamaService();
    const outcome = await service.classifyDocument("some text");

    expect(outcome.success).toBe(false);
    expect(outcome.data).toBeNull();
  });
});
