import { describe, expect, it } from "vitest";
import {
  formatGitErrorForUser,
  redactGitErrorMessage,
} from "../../../src/extension/git/gitErrorFormatting.js";

describe("Git error redaction", () => {
  it("redacts URL credentials and credential query parameters", () => {
    const redactedMessage = redactGitErrorMessage(
      "fatal: https://user:secret@example.test/repo?token=abc123&path=src/app.ts returned 401",
    );
    expect(redactedMessage).toBe(
      "fatal: https://[redacted]@example.test/repo?token=[redacted]&path=src/app.ts returned 401",
    );
  });

  it("redacts token-only URL userinfo across URL schemes", () => {
    expect(
      redactGitErrorMessage(
        "fatal: ssh://deploy-token@example.test/repo and https://oauth:secret@example.test/repo",
      ),
    ).toBe(
      "fatal: ssh://[redacted]@example.test/repo and https://[redacted]@example.test/repo",
    );
  });

  it("redacts signed URL credentials", () => {
    expect(
      redactGitErrorMessage(
        "https://example.test/repo?sig=one&x-amz-signature=two&path=src",
      ),
    ).toBe(
      "https://example.test/repo?sig=[redacted]&x-amz-signature=[redacted]&path=src",
    );
  });

  it("redacts bearer/basic values while preserving actionable errors", () => {
    const redactedMessage = redactGitErrorMessage(
      "remote rejected: Bearer abc123; status=403; retry-after=30; password: secret",
    );
    expect(redactedMessage).toBe(
      "remote rejected: Bearer [redacted]; status=403; retry-after=30; password: [redacted]",
    );
  });

  it("consumes complete bearer/basic authorization header credentials", () => {
    const redactedMessage = redactGitErrorMessage(
      'headers={"Authorization":"Bearer bearer-secret"}; authorization=Basic basic-secret; retry-after=30',
    );
    expect(redactedMessage).not.toContain("bearer-secret");
    expect(redactedMessage).not.toContain("basic-secret");
    expect(redactedMessage).toContain("Bearer [redacted]");
    expect(redactedMessage).toContain("Basic [redacted]");
    expect(redactedMessage).toBe(
      'headers={"Authorization":"Bearer [redacted]"}; authorization=Basic [redacted]; retry-after=30',
    );
    expect(
      redactGitErrorMessage("request?authorization=query-secret&path=repo"),
    ).toBe("request?authorization=[redacted]&path=repo");
  });

  it("does not leak Basic credentials through generic authorization matches", () => {
    expect(
      redactGitErrorMessage(
        'Authorization: Basic dXNlcjpwYXNz==; next=1; headers={"Authorization":"Basic dXNlcjpwYXNz=="}',
      ),
    ).toBe(
      'Authorization: Basic [redacted]; next=1; headers={"Authorization":"Basic [redacted]"}',
    );
  });

  it("redacts opaque authorization header values", () => {
    expect(
      redactGitErrorMessage(
        'headers={"Authorization":"opaque-secret"}; Authorization: opaque-value',
      ),
    ).toBe('headers={"Authorization":"[redacted]"}; Authorization: [redacted]');
  });

  it("redacts request-scoped opaque credentials", () => {
    expect(
      redactGitErrorMessage("request failed for opaque-session-token", [
        "opaque-session-token",
      ]),
    ).toBe("request failed for [redacted]");
  });

  it("uses a generic message for unlabelled opaque credentials", () => {
    expect(
      formatGitErrorForUser(
        new Error("provider failed with access token opaque-secret-value"),
        "The operation could not be completed.",
      ),
    ).toBe("The operation could not be completed.");
  });

  it("redacts structured credentials and provider token prefixes", () => {
    expect(
      redactGitErrorMessage(
        'response {"password":"secret-value","refresh_token":"refresh-value"} ghp_1234567890',
      ),
    ).toBe(
      'response {"password":"[redacted]","refresh_token":"[redacted]"} [redacted]',
    );
  });
});
