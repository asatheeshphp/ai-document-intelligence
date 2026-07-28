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

  it("skips inline images (e.g. email signature logos) even though the extension matches", async () => {
    const client = fakeImapClient({
      search: vi.fn().mockResolvedValue([305]),
      fetchOne: vi.fn().mockResolvedValue({ source: Buffer.from("raw-mime") }),
    });
    const repository = fakeRepository();
    const documentIngestionService = fakeDocumentIngestionService();
    const parseMail = vi.fn().mockResolvedValue({
      messageId: "<msg-5@techgrit.com>",
      attachments: [
        { filename: "signature-logo.png", contentDisposition: "inline", content: Buffer.from("png-bytes") },
        { filename: "invoice.pdf", contentDisposition: "attachment", content: Buffer.from("pdf-bytes") },
      ],
    });

    const service = new EmailIngestionService(repository, documentIngestionService, () => client, parseMail);
    const result = await service.checkInbox();

    expect(result.documentsIngested).toBe(1);
    expect(documentIngestionService.processLocalDocument).toHaveBeenCalledTimes(1);
    expect(documentIngestionService.processLocalDocument).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "invoice.pdf" })
    );
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

  it("records a failure on the processed message without throwing", async () => {
    const client = fakeImapClient({
      search: vi.fn().mockResolvedValue([501]),
      fetchOne: vi.fn().mockRejectedValue(new Error("IMAP fetch failed")),
    });
    const repository = fakeRepository();
    const documentIngestionService = fakeDocumentIngestionService();

    const service = new EmailIngestionService(repository, documentIngestionService, () => client);
    const result = await service.checkInbox();

    expect(result.errors).toEqual([{ messageUid: 501, error: "IMAP fetch failed" }]);
    expect(result.documentsIngested).toBe(0);
  });

  it("processes only the newest unread message (descending UID), even when search returns others out of order", async () => {
    const fetchOne = vi.fn().mockResolvedValue({ source: Buffer.from("raw-mime") });
    const client = fakeImapClient({
      search: vi.fn().mockResolvedValue([701, 703, 702]),
      fetchOne,
    });
    const repository = fakeRepository();
    const documentIngestionService = fakeDocumentIngestionService();
    const parseMail = vi.fn().mockResolvedValue({
      messageId: "<msg-703@techgrit.com>",
      attachments: [{ filename: "invoice.pdf", content: Buffer.from("pdf-bytes") }],
    });

    const service = new EmailIngestionService(repository, documentIngestionService, () => client, parseMail);
    const result = await service.checkInbox();

    expect(result.emailsScanned).toBe(1);
    expect(fetchOne).toHaveBeenCalledTimes(1);
    expect(fetchOne).toHaveBeenCalledWith("703", expect.anything(), expect.anything());
    expect(client.messageFlagsAdd).toHaveBeenCalledWith(703, ["\\Seen"], { uid: true });
    expect(result.documentsIngested).toBe(1);
  });

  it("skips a message whose subject doesn't match EMAIL_SUBJECT_FILTER, even with a matching attachment", async () => {
    vi.stubEnv("EMAIL_SUBJECT_FILTER", "invoice");
    const client = fakeImapClient({
      search: vi.fn().mockResolvedValue([601]),
      fetchOne: vi.fn().mockResolvedValue({ source: Buffer.from("raw-mime") }),
    });
    const repository = fakeRepository();
    const documentIngestionService = fakeDocumentIngestionService();
    const parseMail = vi.fn().mockResolvedValue({
      messageId: "<msg-601@techgrit.com>",
      subject: "Weekly team newsletter",
      attachments: [{ filename: "report.pdf", content: Buffer.from("pdf-bytes") }],
    });

    const service = new EmailIngestionService(repository, documentIngestionService, () => client, parseMail);
    const result = await service.checkInbox();

    expect(result.emailsWithAttachments).toBe(0);
    expect(repository.createEmail).not.toHaveBeenCalled();
    expect(documentIngestionService.processLocalDocument).not.toHaveBeenCalled();
    expect(client.messageFlagsAdd).toHaveBeenCalledWith(601, ["\\Seen"], { uid: true });
  });

  it("processes a message when the subject contains the filter, case-insensitively, anywhere in the string", async () => {
    vi.stubEnv("EMAIL_SUBJECT_FILTER", "invoice");
    const client = fakeImapClient({
      search: vi.fn().mockResolvedValue([602]),
      fetchOne: vi.fn().mockResolvedValue({ source: Buffer.from("raw-mime") }),
    });
    const repository = fakeRepository();
    const documentIngestionService = fakeDocumentIngestionService();
    const parseMail = vi.fn().mockResolvedValue({
      messageId: "<msg-602@techgrit.com>",
      subject: "Please see attached INVOICE for July",
      attachments: [{ filename: "report.pdf", content: Buffer.from("pdf-bytes") }],
    });

    const service = new EmailIngestionService(repository, documentIngestionService, () => client, parseMail);
    const result = await service.checkInbox();

    expect(result.documentsIngested).toBe(1);
    expect(documentIngestionService.processLocalDocument).toHaveBeenCalledTimes(1);
  });
});
