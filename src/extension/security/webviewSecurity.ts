import { randomBytes } from "node:crypto";

/** Creates a fresh CSP nonce for each webview document. */
export function createContentSecurityNonce(): string {
  return randomBytes(32).toString("base64url");
}

/** Escapes values interpolated into HTML attributes. */
export function escapeHtmlAttribute(attributeValue: string): string {
  return attributeValue.replace(/[&<>'"]/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "'":
        return "&#39;";
      case '"':
        return "&quot;";
      default:
        return character;
    }
  });
}
