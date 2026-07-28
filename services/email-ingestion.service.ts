import fs from "node:fs/promises";
import path from "node:path";
import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { getEmailEnv } from "@/config/email-env";
import { ProcessingRepository } from "@/repositories/processing.repository";
import { DocumentIngestionService } from "@/services/document-ingestion.service";

// Narrow slice of ImapFlow's surface actually used here -- kept as an interface so tests
// can pass a fake object (per this codebase's convention of injecting fakes rather than
// vi.mock-ing a class constructed with `new`).
export interface ImapClient {
  connect(): Promise<void>;
  logout(): Promise<void>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  search(query: { seen: boolean }, options: { uid: boolean }): Promise<number[] | false>;
  fetchOne(
    uid: string,
    query: { source: boolean },
    options: { uid: boolean }
  ): Promise<{ source?: Buffer } | false>;
  messageFlagsAdd(uid: number, flags: string[], options: { uid: boolean }): Promise<boolean>;
}

const MATCHING_EXTENSIONS = [".pdf", ".jpg", ".jpeg", ".png"];

// contentDisposition "inline" means an image embedded in the message body/signature
// (a logo, a tracking pixel) -- not a file the sender deliberately attached. Confirmed
// live: a real test email's 3 inline signature PNGs got downloaded and pushed through
// slow vision OCR alongside the one genuine invoice PDF, none of which were the actual
// invoice. Only "attachment" (or unspecified, since not every server sets this reliably)
// is treated as a candidate.
function isMatchingAttachment(filename: string | undefined, contentDisposition: string | undefined): boolean {
  if (!filename) return false;
  if (contentDisposition === "inline") return false;
  const ext = path.extname(filename).toLowerCase();
  return MATCHING_EXTENSIONS.includes(ext);
}

// No filter configured means every subject passes -- today's behavior, unchanged.
function subjectMatches(subject: string | undefined, filter: string | undefined): boolean {
  if (!filter) return true;
  if (!subject) return false;
  return subject.toLowerCase().includes(filter.toLowerCase());
}

export interface EmailCheckError {
  messageUid: number;
  error: string;
}

export interface EmailCheckResult {
  emailsScanned: number;
  emailsWithAttachments: number;
  documentsIngested: number;
  errors: EmailCheckError[];
}

export class EmailIngestionService {
  constructor(
    private readonly repository: ProcessingRepository = new ProcessingRepository(),
    private readonly documentIngestionService: DocumentIngestionService = new DocumentIngestionService(),
    private readonly createClient: () => ImapClient = () => {
      const config = getEmailEnv();
      return new ImapFlow({
        host: config.EMAIL_IMAP_HOST,
        port: config.EMAIL_IMAP_PORT,
        secure: true,
        auth: { user: config.EMAIL_IMAP_USER, pass: config.EMAIL_IMAP_PASSWORD },
        logger: false,
      }) as unknown as ImapClient;
    },
    private readonly parseMail: (source: Buffer) => Promise<ParsedMail> = simpleParser
  ) {}

  /**
   * Reads unread mail from the configured mailbox, downloads any PDF/image attachments
   * to EMAIL_ATTACHMENT_DIR, and feeds it through the existing DocumentIngestionService
   * pipeline (no extraction/chunking/embedding logic is duplicated here). Marks the
   * message \Seen once its attachments are safely on disk -- not after extraction
   * succeeds -- so a slow or failed extraction doesn't cause the same email to be
   * re-downloaded on the next check. If EMAIL_SUBJECT_FILTER is set, a non-matching
   * subject is marked read and skipped, same as a message with no matching attachment.
   *
   * Processes at most ONE message per call -- the newest unread message (by UID
   * descending), whatever it is, even if it doesn't qualify (wrong subject, no matching
   * attachment). One trigger call = one message looked at, not "keep going until
   * something qualifies" -- the next unprocessed message is picked up on the next call.
   */
  async checkInbox(): Promise<EmailCheckResult> {
    const config = getEmailEnv();
    const client = this.createClient();

    const result: EmailCheckResult = {
      emailsScanned: 0,
      emailsWithAttachments: 0,
      documentsIngested: 0,
      errors: [],
    };

    await client.connect();

    try {
      const lock = await client.getMailboxLock(config.EMAIL_IMAP_MAILBOX);

      try {
        const uids = await client.search({ seen: false }, { uid: true });
        if (!uids || uids.length === 0) return result;

        const newestUid = [...uids].sort((a, b) => b - a)[0];
        result.emailsScanned = 1;

        try {
          const ingested = await this.processMessage(
            newestUid,
            client,
            config.EMAIL_ATTACHMENT_DIR,
            config.EMAIL_SUBJECT_FILTER
          );
          if (ingested > 0) {
            result.emailsWithAttachments += 1;
            result.documentsIngested += ingested;
          }
        } catch (err) {
          result.errors.push({
            messageUid: newestUid,
            error: err instanceof Error ? err.message : "Unknown error processing message",
          });
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }

    return result;
  }

  private async processMessage(
    uid: number,
    client: ImapClient,
    attachmentDir: string,
    subjectFilter: string | undefined
  ): Promise<number> {
    const fetched = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!fetched || !fetched.source) {
      throw new Error(`Message UID ${uid} had no source content to parse.`);
    }

    const parsed = await this.parseMail(fetched.source);

    if (!subjectMatches(parsed.subject, subjectFilter)) {
      await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
      return 0;
    }

    const attachments = (parsed.attachments ?? []).filter((attachment) =>
      isMatchingAttachment(attachment.filename, attachment.contentDisposition)
    );

    if (attachments.length === 0) {
      await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
      return 0;
    }

    const messageId = parsed.messageId ?? `imap-uid-${uid}`;
    const existingEmail = await this.repository.findEmailByMessageId(messageId);

    const email =
      existingEmail ??
      (await this.repository.createEmail({
        messageId,
        senderAddress: parsed.from?.value?.[0]?.address ?? "unknown@unknown",
        senderName: parsed.from?.value?.[0]?.name,
        subject: parsed.subject,
        receivedAt: parsed.date ?? new Date(),
        source: "INBOX",
        metadata: { imapUid: uid },
      }));

    await fs.mkdir(attachmentDir, { recursive: true });

    let ingestedCount = 0;
    for (const attachment of attachments) {
      const filename = `${uid}-${attachment.filename}`;
      const destination = path.join(attachmentDir, filename);
      await fs.writeFile(destination, attachment.content);

      await this.documentIngestionService.processLocalDocument({
        sourcePath: destination,
        filename: attachment.filename,
        metadata: { emailId: email._id.toString() },
      });
      ingestedCount += 1;
    }

    await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
    return ingestedCount;
  }
}
