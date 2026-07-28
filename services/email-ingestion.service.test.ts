import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Types } from "mongoose";
import { EmailIngestionService, type ImapClient } from "@/services/email-ingestion.service";
import type { ProcessingRepository } from "@/repositories/processing.repository";
import type { DocumentIngestionService } from "@/services/document-ingestion.service";

const mkdir = vi.fn().mockResolvedValue(undefined);
const writeFile = vi.fn().mockResolvedValue(undefined);

vi.mock("node:fs/promises", () => ({
  default: { mkdir: (...args: unknown[]) => mkdir(...args), writeFile: (...args: unknown[]) => writeFile(...args) },
}));

function fakeImapClient(overrides: Partial<ImapClient> = {}): ImapClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    search: vi.fn().mockResolvedValue([]),
    fetchOne: vi.fn().mockResolvedValue(false),
    messageFlagsAdd: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function fakeRepository(overrides: Record<string, unknown> = {}): ProcessingRepository {
  return {
    findEmailByMessageId: vi.fn().mockResolvedValue(null),
    createEmail: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
    ...overrides,
  } as unknown as ProcessingRepository;
}

function fakeDocumentIngestionService(overrides: Record<string, unknown> = {}): DocumentIngestionService {
  return {
    processLocalDocument: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as DocumentIngestionService;
}

beforeEach(() => {
  vi.stubEnv("EMAIL_IMAP_HOST", "outlook.office365.com");
  vi.stubEnv("EMAIL_IMAP_USER", "someone@techgrit.com");
  vi.stubEnv("EMAIL_IMAP_PASSWORD", "app-password");
  mkdir.mockClear();
  writeFile.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("EmailIngestionService.checkInbox", () => {
  it("returns a zero result when there are no unread messages", async () => {
    const client = fakeImapClient({ search: vi.fn().mockResolvedValue([]) });
    const repository = fakeRepository();
    const documentIngestionService = fakeDocumentIngestionService();

    const service = new EmailIngestionService(repository, documentIngestionService, () => client);
    const result = await service.checkInbox();

    expect(result).toEqual({ emailsScanned: 0, emailsWithAttachments: 0, documentsIngested: 0, errors: [] });
    expect(client.connect).toHaveBeenCalled();
    expect(client.logout).toHaveBeenCalled();
  });

  it("downloads a matching PDF attachment, records the email, and ingests it", async () => {
    const client = fakeImapClient({
      search: vi.fn().mockResolvedValue([101]),
      fetchOne: vi.fn().mockResolvedValue({ source: Buffer.from("raw-mime") }),
    });
    const repository = fakeRepository();
    const documentIngestionService = fakeDocumentIngestionService();
    const parseMail = vi.fn().mockResolvedValue({
      messageId: "<msg-1@techgrit.com>",
      from: { value: [{ address: "vendor@example.com", name: "Vendor Co" }] },
      subject: "Invoice attached",
      date: new Date("2026-07-20"),
      attachments: [{ filename: "invoice.pdf", content: Buffer.from("pdf-bytes") }],
    });

    const service = new EmailIngestionService(repository, documentIngestionService, () => client, parseMail);
    const result = await service.checkInbox();

    expect(result.emailsScanned).toBe(1);
    expect(result.emailsWithAttachments).toBe(1);
    expect(result.documentsIngested).toBe(1);
    expect(result.errors).toEqual([]);

    expect(repository.createEmail).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "<msg-1@techgrit.com>", senderAddress: "vendor@example.com" })
    );
    expect(writeFile).toHaveBeenCalledWith(expect.stringContaining("101-invoice.pdf"), expect.any(Buffer));
    expect(documentIngestionService.processLocalDocument).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "invoice.pdf" })
    );
    expect(client.messageFlagsAdd).toHaveBeenCalledWith(101, ["\\Seen"], { uid: true });
  });

  it("marks a message with no matching attachments as seen without creating an Email record", async () => {
    const client = fakeImapClient({
      search: vi.fn().mockResolvedValue([202]),
      fetchOne: vi.fn().mockResolvedValue({ source: Buffer.from("raw-mime") }),
    });
    const repository = fakeRepository();
    const documentIngestionService = fakeDocumentIngestionService();
    const parseMail = vi.fn().mockResolvedValue({
      messageId: "<msg-2@techgrit.com>",
      attachments: [{ filename: "terms.docx", content: Buffer.from("docx-bytes") }],
    });

    const service = new EmailIngestionService(repository, documentIngestionService, () => client, parseMail);
    const result = await service.checkInbox();

    expect(result.emailsWithAttachments).toBe(0);
    expect(result.documentsIngested).toBe(0);
    expect(repository.createEmail).not.toHaveBeenCalled();
    expect(documentIngestionService.processLocalDocument).not.toHaveBeenCalled();
    expect(client.messageFlagsAdd).toHaveBeenCalledWith(202, ["\\Seen"], { uid: true });
  });

  it("only downloads matching attachments out of a mixed set", async () => {
    const client = fakeImapClient({
      search: vi.fn().mockResolvedValue([303]),
      fetchOne: vi.fn().mockResolvedValue({ source: Buffer.from("raw-mime") }),
    });
    const repository = fakeRepository();
    const documentIngestionService = fakeDocumentIngestionService();
    const parseMail = vi.fn().mockResolvedValue({
      messageId: "<msg-3@techgrit.com>",
      attachments: [
        { filename: "invoice.pdf", content: Buffer.from("pdf-bytes") },
        { filename: "terms.docx", content: Buffer.from("docx-bytes") },
        { filename: "scan.png", content: Buffer.from("png-bytes") },
      ],
    });

    const service = new EmailIngestionService(repository, documentIngestionService, () => client, parseMail);
    const result = await service.checkInbox();

    expect(result.documentsIngested).toBe(2);
    expect(documentIngestionService.processLocalDocument).toHaveBeenCalledTimes(2);
  });

  it("does not create a duplicate Email record when the message was already recorded", async () => {
    const client = fakeImapClient({
      search: vi.fn().mockResolvedValue([404]),
      fetchOne: vi.fn().mockResolvedValue({ source: Buffer.from("raw-mime") }),
    });
    const existingEmail = { _id: new Types.ObjectId() };
    const repository = fakeRepository({ findEmailByMessageId: vi.fn().mockResolvedValue(existingEmail) });
    const documentIngestionService = fakeDocumentIngestionService();
    const parseMail = vi.fn().mockResolvedValue({
      messageId: "<msg-4@techgrit.com>",
      attachments: [{ filename: "invoice.pdf", content: Buffer.from("pdf-bytes") }],
    });

    const service = new EmailIngestionService(repository, documentIngestionService, () => client, parseMail);
    await service.checkInbox();

    expect(repository.createEmail).not.toHaveBeenCalled();
    expect(documentIngestionService.processLocalDocument).toHaveBeenCalledTimes(1);
  });

  it("records a per-message failure without aborting the rest of the batch", async () => {
    const client = fakeImapClient({
      search: vi.fn().mockResolvedValue([501, 502]),
      fetchOne: vi
        .fn()
        .mockRejectedValueOnce(new Error("IMAP fetch failed"))
        .mockResolvedValueOnce({ source: Buffer.from("raw-mime") }),
    });
    const repository = fakeRepository();
    const documentIngestionService = fakeDocumentIngestionService();
    const parseMail = vi.fn().mockResolvedValue({
      messageId: "<msg-502@techgrit.com>",
      attachments: [{ filename: "invoice.pdf", content: Buffer.from("pdf-bytes") }],
    });

    const service = new EmailIngestionService(repository, documentIngestionService, () => client, parseMail);
    const result = await service.checkInbox();

    expect(result.errors).toEqual([{ messageUid: 501, error: "IMAP fetch failed" }]);
    expect(result.documentsIngested).toBe(1);
  });
});
