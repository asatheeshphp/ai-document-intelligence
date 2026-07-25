import { z } from "zod";

const AddressSchema = z.object({
  raw: z.string().nullable(),
  street: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  country: z.string().nullable(),
});

const PartySchema = z.object({
  name: z.string().nullable(),
  address: AddressSchema,
  taxId: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
});

const ShippingSchema = z.object({
  address: AddressSchema,
  method: z.string().nullable(),
  trackingNumber: z.string().nullable(),
});

const LineItemSchema = z.object({
  description: z.string().nullable(),
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
  unitPrice: z.number().nullable(),
  taxRate: z.number().nullable(),
  amount: z.number().nullable(),
});

const TaxSchema = z.object({
  type: z.string().nullable(),
  rate: z.number().nullable(),
  amount: z.number().nullable(),
});

const TotalsSchema = z.object({
  subtotal: z.number().nullable(),
  totalTax: z.number().nullable(),
  discount: z.number().nullable(),
  shippingCharge: z.number().nullable(),
  grandTotal: z.number().nullable(),
  amountInWords: z.string().nullable(),
});

const BankDetailsSchema = z.object({
  bankName: z.string().nullable(),
  accountName: z.string().nullable(),
  accountNumber: z.string().nullable(),
  ifscCode: z.string().nullable(),
  swiftCode: z.string().nullable(),
  branch: z.string().nullable(),
});

const ReferenceSchema = z.object({
  type: z.string().nullable(),
  value: z.string().nullable(),
});

export const InvoiceExtractionSchema = z.object({
  invoice: z.object({
    invoiceNumber: z.string().nullable(),
    invoiceDate: z.string().nullable(),
    dueDate: z.string().nullable(),
    poNumber: z.string().nullable(),
    currency: z.string().nullable(),
    paymentTerms: z.string().nullable(),
  }),
  supplier: PartySchema,
  customer: PartySchema,
  shipping: ShippingSchema,
  lineItems: z.array(LineItemSchema),
  taxes: z.array(TaxSchema),
  totals: TotalsSchema,
  bankDetails: BankDetailsSchema,
  notes: z.string().nullable(),
  references: z.array(ReferenceSchema),
  additionalFields: z.record(z.string(), z.unknown()),
});

export type InvoiceExtraction = z.infer<typeof InvoiceExtractionSchema>;

export const InvoiceExtractionJsonSchema = z.toJSONSchema(InvoiceExtractionSchema, {
  target: "draft-2020-12",
});
