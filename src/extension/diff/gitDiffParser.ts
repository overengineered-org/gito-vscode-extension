import type { DiffChangeRange, DiffFileMetadata } from "./diffModels.js";
import { takeUtf8Prefix } from "../git/utf8.js";

interface ParsedRawDiffRecord {
  readonly metadata: DiffFileMetadata;
  readonly oldPath?: string;
  readonly newPath?: string;
}

export interface ParsedDiffMetadata {
  readonly records: readonly ParsedRawDiffRecord[];
  readonly truncated: boolean;
}

export interface ParsedDiffHunks {
  readonly rangesByPath: ReadonlyMap<string, readonly DiffChangeRange[]>;
  readonly truncated: boolean;
}

/**
 * Parses `git diff --raw -z` without interpreting paths as shell input.
 * Raw records are NUL-delimited, so tabs/newlines in filenames are safe.
 */
export function parseRawDiffMetadata(
  rawOutput: string,
  numstatOutput: string,
  maxRecords: number,
  maxBytes: number,
): ParsedDiffMetadata {
  const rawRecords = parseRawRecords(rawOutput, maxRecords, maxBytes);
  const numstatRecords = parseNumstatRecords(
    numstatOutput,
    rawRecords.records.map((record) => record.metadata.changeType),
    maxRecords,
    maxBytes,
  );
  const records = rawRecords.records.map((rawRecord, index) => {
    const numstatRecord = numstatRecords.records[index];
    if (numstatRecord === undefined) return rawRecord;
    return {
      ...rawRecord,
      metadata: {
        ...rawRecord.metadata,
        additions: numstatRecord.additions,
        deletions: numstatRecord.deletions,
        isBinary: numstatRecord.isBinary,
      },
    };
  });
  return {
    records,
    truncated: rawRecords.truncated || numstatRecords.truncated,
  };
}

export function parseDiffHunks(
  patchOutput: string,
  maxChanges: number,
  maxBytes: number,
): ParsedDiffHunks {
  const cappedPatchOutput = takeUtf8Prefix(patchOutput, maxBytes);
  const truncated = Buffer.byteLength(patchOutput, "utf8") > maxBytes;
  const rangesByPath = new Map<string, DiffChangeRange[]>();
  let currentPath: string | undefined;
  let rangeCount = 0;
  for (const line of cappedPatchOutput.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      currentPath = parseNewDiffPath(line);
      continue;
    }
    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunkMatch === null || currentPath === undefined) continue;
    if (rangeCount >= maxChanges) {
      return { rangesByPath, truncated: true };
    }
    const oldStartLine = parsePositiveInteger(hunkMatch[1], "old start");
    const newStartLine = parsePositiveInteger(hunkMatch[3], "new start");
    const range: DiffChangeRange = {
      oldStartLine,
      oldLineCount: parseOptionalCount(hunkMatch[2]),
      newStartLine,
      newLineCount: parseOptionalCount(hunkMatch[4]),
    };
    const ranges = rangesByPath.get(currentPath) ?? [];
    ranges.push(range);
    rangesByPath.set(currentPath, ranges);
    rangeCount += 1;
  }
  return { rangesByPath, truncated };
}

interface ParsedNumstatRecord {
  readonly additions: number;
  readonly deletions: number;
  readonly isBinary: boolean;
}

interface ParsedRecords<T> {
  readonly records: readonly T[];
  readonly truncated: boolean;
}

function parseRawRecords(
  rawOutput: string,
  maxRecords: number,
  maxBytes: number,
): ParsedRecords<ParsedRawDiffRecord> {
  const cappedOutput = takeUtf8Prefix(rawOutput, maxBytes);
  const tokens = completeNulTokens(cappedOutput);
  const records: ParsedRawDiffRecord[] = [];
  let tokenIndex = 0;
  let truncated =
    rawOutput.length > cappedOutput.length ||
    (cappedOutput.length > 0 && !cappedOutput.endsWith("\0"));
  while (tokenIndex < tokens.length) {
    const header = tokens[tokenIndex++];
    if (header === undefined || header.length === 0) break;
    if (!header.startsWith(":")) continue;
    const headerParts = header.slice(1).split(" ");
    if (headerParts.length < 5) continue;
    const oldMode = headerParts[0];
    const newMode = headerParts[1];
    const status = headerParts[4];
    if (
      oldMode === undefined ||
      newMode === undefined ||
      status === undefined
    ) {
      continue;
    }
    const oldPath = tokens[tokenIndex++];
    if (oldPath === undefined) {
      truncated = true;
      break;
    }
    const changeCode = status[0] ?? "M";
    const renameOrCopy = changeCode === "R" || changeCode === "C";
    const newPath = renameOrCopy ? tokens[tokenIndex++] : oldPath;
    if (newPath === undefined) {
      truncated = true;
      break;
    }
    if (records.length >= maxRecords) {
      truncated = true;
      break;
    }
    const metadata = createRawMetadata(
      changeCode,
      oldPath,
      newPath,
      oldMode,
      newMode,
      parseSimilarity(status),
    );
    records.push({ metadata, oldPath, newPath });
  }
  return { records, truncated };
}

function parseNumstatRecords(
  numstatOutput: string,
  changeTypes: readonly DiffFileMetadata["changeType"][],
  maxRecords: number,
  maxBytes: number,
): ParsedRecords<ParsedNumstatRecord> {
  const cappedOutput = takeUtf8Prefix(numstatOutput, maxBytes);
  const tokens = completeNulTokens(cappedOutput);
  const records: ParsedNumstatRecord[] = [];
  let tokenIndex = 0;
  let changeIndex = 0;
  let truncated =
    numstatOutput.length > cappedOutput.length ||
    (cappedOutput.length > 0 && !cappedOutput.endsWith("\0"));
  while (tokenIndex < tokens.length && changeIndex < changeTypes.length) {
    const statHeader = tokens[tokenIndex++];
    if (statHeader === undefined || statHeader.length === 0) break;
    const firstTab = statHeader.indexOf("\t");
    const secondTab =
      firstTab < 0 ? -1 : statHeader.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const additionsText = statHeader.slice(0, firstTab);
    const deletionsText = statHeader.slice(firstTab + 1, secondTab);
    const inlinePath = statHeader.slice(secondTab + 1);
    const changeType = changeTypes[changeIndex];
    const renameOrCopy = changeType === "renamed" || changeType === "copied";
    if (inlinePath.length === 0) {
      const pathTokenCount = renameOrCopy ? 2 : 1;
      if (tokenIndex + pathTokenCount > tokens.length) {
        truncated = true;
        break;
      }
      tokenIndex += pathTokenCount;
    } else if (renameOrCopy) {
      if (tokenIndex >= tokens.length) {
        truncated = true;
        break;
      }
      tokenIndex += 1;
    }
    if (records.length >= maxRecords) {
      truncated = true;
      break;
    }
    records.push({
      additions: parseNumstatNumber(additionsText),
      deletions: parseNumstatNumber(deletionsText),
      isBinary: additionsText === "-" || deletionsText === "-",
    });
    changeIndex += 1;
  }
  if (changeIndex >= changeTypes.length && tokenIndex < tokens.length)
    truncated = true;
  if (records.length < changeTypes.length && !truncated) truncated = true;
  return { records, truncated };
}

/** A final token without its terminating NUL may be a byte-capped path. */
function completeNulTokens(cappedOutput: string): string[] {
  if (cappedOutput.length === 0 || !cappedOutput.endsWith("\0")) {
    return cappedOutput.length === 0
      ? []
      : cappedOutput.split("\0").slice(0, -1);
  }
  return cappedOutput.split("\0").slice(0, -1);
}

function createRawMetadata(
  changeCode: string,
  oldPath: string,
  newPath: string,
  oldMode: string,
  newMode: string,
  similarityPercent: number | undefined,
): DiffFileMetadata {
  const isSubmodule = oldMode === "160000" || newMode === "160000";
  const isSymlink = oldMode === "120000" || newMode === "120000";
  const changeType =
    changeCode === "A"
      ? "added"
      : changeCode === "D"
        ? "deleted"
        : changeCode === "R"
          ? "renamed"
          : changeCode === "C"
            ? "copied"
            : changeCode === "T"
              ? "type-changed"
              : changeCode === "U"
                ? "unmerged"
                : "modified";
  const pathFields =
    changeType === "added"
      ? { newPath }
      : changeType === "deleted"
        ? { oldPath }
        : { oldPath, newPath };
  return {
    changeType,
    ...pathFields,
    ...(similarityPercent === undefined ? {} : { similarityPercent }),
    additions: 0,
    deletions: 0,
    isBinary: false,
    isSubmodule,
    isSymlink,
    oldMode,
    newMode,
  };
}

function parseSimilarity(status: string): number | undefined {
  const similarityText = status.slice(1);
  if (similarityText.length === 0) return undefined;
  const similarityPercent = Number(similarityText);
  return Number.isFinite(similarityPercent) ? similarityPercent : undefined;
}

function parseNumstatNumber(numberText: string): number {
  if (numberText === "-") return 0;
  const parsedNumber = Number(numberText);
  return Number.isFinite(parsedNumber) && parsedNumber >= 0 ? parsedNumber : 0;
}

function parseNewDiffPath(diffHeader: string): string | undefined {
  const pathTokens = parseDiffHeaderTokens(diffHeader);
  const newPath = pathTokens[1];
  return newPath?.startsWith("b/") ? newPath.slice(2) : newPath;
}

/** Git quotes unusual path names in patch headers using C-style escapes. */
function parseDiffHeaderTokens(diffHeader: string): readonly string[] {
  const headerPrefix = "diff --git ";
  if (!diffHeader.startsWith(headerPrefix)) return [];
  const tokens: string[] = [];
  let cursor = headerPrefix.length;
  while (cursor < diffHeader.length && tokens.length < 2) {
    while (diffHeader[cursor] === " ") cursor += 1;
    if (cursor >= diffHeader.length) break;
    if (diffHeader[cursor] !== '"') {
      const tokenStart = cursor;
      while (cursor < diffHeader.length && diffHeader[cursor] !== " ")
        cursor += 1;
      tokens.push(diffHeader.slice(tokenStart, cursor));
      continue;
    }
    cursor += 1;
    let token = "";
    let hasOctalEscape = false;
    while (cursor < diffHeader.length) {
      const character = diffHeader[cursor++];
      if (character === '"') break;
      if (character !== "\\" || cursor >= diffHeader.length) {
        token += character;
        continue;
      }
      const escapedCharacter = diffHeader[cursor++] ?? "";
      const escapeMap: Record<string, string> = {
        a: String.fromCharCode(7),
        b: String.fromCharCode(8),
        t: "\t",
        n: "\n",
        v: String.fromCharCode(11),
        f: "\f",
        r: "\r",
        "\\": "\\",
        '"': '"',
      };
      const mappedCharacter = escapeMap[escapedCharacter];
      if (mappedCharacter !== undefined) {
        token += mappedCharacter;
        continue;
      }
      if (/[0-7]/.test(escapedCharacter)) {
        hasOctalEscape = true;
        let octalDigits = escapedCharacter;
        while (
          octalDigits.length < 3 &&
          cursor < diffHeader.length &&
          /[0-7]/.test(diffHeader[cursor] ?? "")
        ) {
          octalDigits += diffHeader[cursor++];
        }
        token += String.fromCharCode(Number.parseInt(octalDigits, 8));
        continue;
      }
      token += escapedCharacter;
    }
    tokens.push(
      hasOctalEscape ? Buffer.from(token, "latin1").toString("utf8") : token,
    );
  }
  return tokens;
}

function parseOptionalCount(countText: string | undefined): number {
  return countText === undefined ? 1 : parsePositiveInteger(countText, "count");
}

function parsePositiveInteger(
  value: string | undefined,
  label: string,
): number {
  const parsedValue = Number(value);
  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    throw new Error(`Invalid Git diff ${label}: ${value ?? "undefined"}`);
  }
  return parsedValue;
}
