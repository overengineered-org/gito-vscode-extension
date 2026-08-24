/** Returns a UTF-8 byte-bounded prefix without splitting a code point. */
export function takeUtf8Prefix(text: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maximumBytes) return text;
  let prefix = "";
  let usedBytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (usedBytes + characterBytes > maximumBytes) break;
    prefix += character;
    usedBytes += characterBytes;
  }
  return prefix;
}
