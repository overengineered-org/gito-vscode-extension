import type {
  BlameLine,
  HistoryCommit,
  HistoryFileChange,
  HistoryIdentity,
} from "./historyTypes.js";

export const HISTORY_RECORD_SEPARATOR = "\x1e";
export const HISTORY_METADATA_FORMAT =
  "%x1e%H%x00%h%x00%an%x00%ae%x00%aI%x00%cI%x00%P%x00%s";

export function parseHistoryRecords(
  gitLogOutput: string,
  includeChangedFiles = true,
): readonly HistoryCommit[] {
  return gitLogOutput.split(HISTORY_RECORD_SEPARATOR).flatMap((record) => {
    const parsedRecord = parseHistoryRecord(record, includeChangedFiles);
    return parsedRecord === undefined ? [] : [parsedRecord];
  });
}

export function parseHistoryRecord(
  record: string,
  includeChangedFiles = true,
): HistoryCommit | undefined {
  const shaStart = record.search(/(?:[0-9a-f]{40}|[0-9a-f]{64})\0/i);
  if (shaStart < 0) return undefined;
  const recordWithoutLeadingNoise = record.slice(shaStart);
  const newlineIndex = recordWithoutLeadingNoise.indexOf("\n");
  const metadataText =
    newlineIndex < 0
      ? recordWithoutLeadingNoise
      : recordWithoutLeadingNoise.slice(0, newlineIndex);
  const metadataFields = metadataText.split("\0");
  const [
    sha,
    shortSha,
    authorName,
    authorEmail,
    authorDate,
    committerDate,
    parentText,
    subject,
  ] = metadataFields;
  if (
    sha === undefined ||
    shortSha === undefined ||
    authorName === undefined ||
    authorEmail === undefined ||
    authorDate === undefined ||
    committerDate === undefined ||
    parentText === undefined ||
    subject === undefined
  ) {
    return undefined;
  }
  const changedFiles =
    !includeChangedFiles || newlineIndex < 0
      ? []
      : parseNameStatusRecords(
          recordWithoutLeadingNoise.slice(newlineIndex + 1),
        );
  return {
    sha,
    shortSha,
    subject,
    authorName,
    authorEmail,
    authorDate,
    committerDate,
    parentShas: parentText.length === 0 ? [] : parentText.split(" "),
    changedFiles,
  };
}

export function parseNameStatusRecords(
  nameStatusText: string,
): readonly HistoryFileChange[] {
  // Keep this history-only parser separate from GitHistoryService's commit
  // parser: this payload is embedded after record metadata and only needs
  // history file identity, while the local commit parser also accepts
  // line-delimited fallback output and merges numstat counts.
  const records = nameStatusText.split("\0");
  const changes: HistoryFileChange[] = [];
  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    const statusRecord = records[recordIndex] ?? "";
    if (statusRecord.length === 0) continue;
    const statusSeparatorIndex = statusRecord.indexOf("\t");
    const status =
      statusSeparatorIndex < 0
        ? statusRecord
        : statusRecord.slice(0, statusSeparatorIndex);
    const statusLetter = status[0];
    if (statusLetter === undefined) continue;
    if (statusLetter === "R" || statusLetter === "C") {
      const attachedPath =
        statusSeparatorIndex < 0
          ? undefined
          : statusRecord.slice(statusSeparatorIndex + 1);
      let previousPath =
        attachedPath === undefined ? records[++recordIndex] : attachedPath;
      let currentPath = records[++recordIndex];
      if (attachedPath !== undefined && currentPath === undefined) {
        const attachedPathParts = attachedPath.split("\t");
        previousPath = attachedPathParts[0];
        currentPath = attachedPathParts[1];
      }
      if (previousPath === undefined || currentPath === undefined) continue;
      changes.push({
        path: decodeGitPath(currentPath),
        previousPath: decodeGitPath(previousPath),
        changeType: statusLetter === "R" ? "renamed" : "copied",
        additions: 0,
        deletions: 0,
      });
      continue;
    }
    const attachedPath =
      statusSeparatorIndex < 0
        ? undefined
        : statusRecord.slice(statusSeparatorIndex + 1);
    const path = attachedPath ?? records[++recordIndex];
    if (path === undefined || path.length === 0) continue;
    changes.push({
      path: decodeGitPath(path),
      changeType:
        statusLetter === "A"
          ? "added"
          : statusLetter === "D"
            ? "deleted"
            : statusLetter === "T"
              ? "type-changed"
              : "modified",
      additions: 0,
      deletions: 0,
    });
  }
  return changes;
}

/** Decode Git's C-style quoted path form, including octal UTF-8 bytes. */
export function decodeGitPath(pathText: string): string {
  if (
    pathText.length < 2 ||
    pathText[0] !== '"' ||
    pathText[pathText.length - 1] !== '"'
  )
    return pathText;
  const bytes: number[] = [];
  const quotedPath = pathText.slice(1, -1);
  for (let index = 0; index < quotedPath.length; index += 1) {
    const character = quotedPath[index];
    if (character !== "\\") {
      const codePoint = quotedPath.codePointAt(index);
      if (codePoint === undefined) continue;
      const encoded = Buffer.from(String.fromCodePoint(codePoint));
      bytes.push(...encoded);
      if (codePoint > 0xffff) index += 1;
      continue;
    }
    const escapedCharacter = quotedPath[++index];
    if (escapedCharacter === undefined) break;
    const escapeMap: Readonly<Record<string, number>> = {
      a: 0x07,
      b: 0x08,
      f: 0x0c,
      n: 0x0a,
      r: 0x0d,
      t: 0x09,
      v: 0x0b,
      "\\": 0x5c,
      '"': 0x22,
    };
    const mappedByte = escapeMap[escapedCharacter];
    if (mappedByte !== undefined) {
      bytes.push(mappedByte);
      continue;
    }
    if (/[0-7]/.test(escapedCharacter)) {
      const octalText = `${escapedCharacter}${quotedPath.slice(index + 1, index + 3)}`;
      const octalMatch = octalText.match(/^[0-7]{1,3}/u);
      if (octalMatch?.[0] !== undefined) {
        bytes.push(Number.parseInt(octalMatch[0], 8));
        index += octalMatch[0].length - 1;
        continue;
      }
    }
    bytes.push(...Buffer.from(escapedCharacter));
  }
  return Buffer.from(bytes).toString("utf8");
}

interface BlameHunk {
  readonly commitSha: string;
  readonly originalLineNumber: number;
  readonly finalLineNumber: number;
  readonly lineCount: number;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorDate: string;
  readonly summary: string;
  readonly pathAtRevision: string;
}

/** Parses `git blame --line-porcelain` without assuming fixed line lengths. */
export function parseBlamePorcelain(blameOutput: string): readonly BlameLine[] {
  const outputLines = blameOutput.split(/\r?\n/);
  const blameLines: BlameLine[] = [];
  let hunk: BlameHunk | undefined;
  let hunkLineOffset = 0;
  let pendingAuthor: HistoryIdentity | undefined;
  let pendingAuthorDate: string | undefined;
  let pendingSummary: string | undefined;
  let pendingPath: string | undefined;
  for (const outputLine of outputLines) {
    const hunkHeader = outputLine.match(
      /^(?:([0-9a-f]{40})|([0-9a-f]{64}))\s+(\d+)\s+(\d+)(?:\s+(\d+))?$/i,
    );
    if (hunkHeader !== null) {
      const commitSha = hunkHeader[1] ?? hunkHeader[2];
      const originalLineNumber = Number.parseInt(hunkHeader[3] ?? "", 10);
      const finalLineNumber = Number.parseInt(hunkHeader[4] ?? "", 10);
      const lineCount = Number.parseInt(hunkHeader[5] ?? "1", 10);
      if (
        commitSha === undefined ||
        Number.isNaN(originalLineNumber) ||
        Number.isNaN(finalLineNumber) ||
        Number.isNaN(lineCount)
      ) {
        hunk = undefined;
        continue;
      }
      hunk = {
        commitSha,
        originalLineNumber,
        finalLineNumber,
        lineCount,
        authorName: pendingAuthor?.name ?? "",
        authorEmail: pendingAuthor?.email ?? "",
        authorDate: pendingAuthorDate ?? "",
        summary: pendingSummary ?? "",
        pathAtRevision: pendingPath ?? "",
      };
      hunkLineOffset = 0;
      pendingAuthor = undefined;
      pendingAuthorDate = undefined;
      pendingSummary = undefined;
      pendingPath = undefined;
      continue;
    }
    if (hunk === undefined) {
      continue;
    }
    if (outputLine.startsWith("author ")) {
      pendingAuthor = {
        name: outputLine.slice("author ".length),
        email: pendingAuthor?.email ?? "",
      };
      hunk = { ...hunk, authorName: pendingAuthor.name };
      continue;
    }
    if (outputLine.startsWith("author-mail ")) {
      const email = outputLine
        .slice("author-mail ".length)
        .replace(/^<|>$/g, "");
      pendingAuthor = {
        name: pendingAuthor?.name ?? hunk.authorName,
        email,
      };
      hunk = { ...hunk, authorEmail: email };
      continue;
    }
    if (outputLine.startsWith("author-time ")) {
      const epochSeconds = Number.parseInt(
        outputLine.slice("author-time ".length),
        10,
      );
      if (!Number.isNaN(epochSeconds)) {
        pendingAuthorDate = new Date(epochSeconds * 1000).toISOString();
        hunk = { ...hunk, authorDate: pendingAuthorDate };
      }
      continue;
    }
    if (outputLine.startsWith("summary ")) {
      pendingSummary = outputLine.slice("summary ".length);
      hunk = { ...hunk, summary: pendingSummary };
      continue;
    }
    if (outputLine.startsWith("filename ")) {
      pendingPath = decodeGitPath(outputLine.slice("filename ".length));
      hunk = { ...hunk, pathAtRevision: pendingPath };
      continue;
    }
    if (!outputLine.startsWith("\t")) continue;
    const lineNumber = hunk.finalLineNumber + hunkLineOffset;
    blameLines.push({
      lineNumber,
      content: outputLine.slice(1),
      commitSha: hunk.commitSha,
      originalLineNumber: hunk.originalLineNumber + hunkLineOffset,
      authorName: hunk.authorName,
      authorEmail: hunk.authorEmail,
      authorDate: hunk.authorDate,
      summary: hunk.summary,
      pathAtRevision: hunk.pathAtRevision,
    });
    hunkLineOffset += 1;
    if (hunkLineOffset >= hunk.lineCount) hunk = undefined;
  }
  return blameLines;
}
