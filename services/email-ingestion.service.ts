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

function isMatchingAttachment(filename: string | undefined): boolean {
  if (!filename) return false;
  const ext = path.extname(filename).toLowerCase();
  return MATCHING_EXTENSIONS.includes(ext);
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
   * to EMAIL_ATTACHMENT_DIR, and feeds each one through the existing
   * DocumentIngestionService pipeline (no extraction/chunking/embedding logic is
   * duplicated here). Marks a message \Seen once its attachments are safely on disk --
   * not after extraction succeeds -- so a slow or failed extraction doesn't cause the
   * same email to be re-downloaded on every subsequent check. One message failing is
   * recorded and skipped; it does not abort the rest of the batch.
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

        result.emailsScanned = uids.length;

        for (const uid of uids) {
          try {
            const ingested = await this.processMessage(uid, client, config.EMAIL_ATTACHMENT_DIR);
            if (ingested > 0) {
              result.emailsWithAttachments += 1;
              result.documentsIngested += ingested;
            }
          } catch (err) {
            result.errors.push({
              messageUid: uid,
              error: err instanceof Error ? err.message : "Unknown error processing message",
            });
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }

    return result;
  }

  private async processMessage(uid: number, client: ImapClient, attachmentDir: string): Promise<number> {
    const fetched = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!fetched || !fetched.source) {
      throw new Error(`Message UID ${uid} had no source content to parse.`);
    }

    const parsed = await this.parseMail(fetched.source);
    const attachments = (parsed.attachments ?? []).filter((attachment) => isMatchingAttachment(attachment.filename));

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
