import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getEmailEnv } from "@/config/email-env";

describe("getEmailEnv", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws naming every missing required variable", () => {
    expect(() => getEmailEnv()).toThrow(/EMAIL_IMAP_HOST, EMAIL_IMAP_USER, EMAIL_IMAP_PASSWORD/);
  });

  it("throws naming only the variables that are actually missing", () => {
    vi.stubEnv("EMAIL_IMAP_HOST", "outlook.office365.com");
    expect(() => getEmailEnv()).toThrow(/EMAIL_IMAP_USER, EMAIL_IMAP_PASSWORD/);
  });

  it("returns parsed config with defaults when all required vars are set", () => {
    vi.stubEnv("EMAIL_IMAP_HOST", "outlook.office365.com");
    vi.stubEnv("EMAIL_IMAP_USER", "someone@techgrit.com");
    vi.stubEnv("EMAIL_IMAP_PASSWORD", "app-password");

    const config = getEmailEnv();

    expect(config.EMAIL_IMAP_HOST).toBe("outlook.office365.com");
    expect(config.EMAIL_IMAP_PORT).toBe(993);
    expect(config.EMAIL_IMAP_MAILBOX).toBe("INBOX");
    expect(config.EMAIL_ATTACHMENT_DIR).toBe("data/incoming");
  });

  it("respects an explicit port override", () => {
    vi.stubEnv("EMAIL_IMAP_HOST", "outlook.office365.com");
    vi.stubEnv("EMAIL_IMAP_USER", "someone@techgrit.com");
    vi.stubEnv("EMAIL_IMAP_PASSWORD", "app-password");
    vi.stubEnv("EMAIL_IMAP_PORT", "143");

    expect(getEmailEnv().EMAIL_IMAP_PORT).toBe(143);
  });

  it("leaves EMAIL_SUBJECT_FILTER undefined when not set", () => {
    vi.stubEnv("EMAIL_IMAP_HOST", "outlook.office365.com");
    vi.stubEnv("EMAIL_IMAP_USER", "someone@techgrit.com");
    vi.stubEnv("EMAIL_IMAP_PASSWORD", "app-password");

    expect(getEmailEnv().EMAIL_SUBJECT_FILTER).toBeUndefined();
  });

  it("passes through an explicit EMAIL_SUBJECT_FILTER", () => {
    vi.stubEnv("EMAIL_IMAP_HOST", "outlook.office365.com");
    vi.stubEnv("EMAIL_IMAP_USER", "someone@techgrit.com");
    vi.stubEnv("EMAIL_IMAP_PASSWORD", "app-password");
    vi.stubEnv("EMAIL_SUBJECT_FILTER", "invoice");

    expect(getEmailEnv().EMAIL_SUBJECT_FILTER).toBe("invoice");
  });
});
