import type {
  ConflictEntryKind,
  ConflictOperationKind,
  ConflictSide,
} from "./conflictModels.js";

export interface ParsedUnmergedIndexEntry {
  readonly path: string;
  readonly mode: string;
  readonly objectId: string | undefined;
  readonly stage: 1 | 2 | 3;
}

export interface ParsedConflictStatusRecord {
  readonly path: string;
  readonly originalPath: string | undefined;
  readonly statusCode: string;
}

/** Parses `git ls-files -u -z` without treating paths as whitespace-delimited. */
export function parseUnmergedIndexEntries(
  nullSeparatedOutput: string,
): readonly ParsedUnmergedIndexEntry[] {
  const entries: ParsedUnmergedIndexEntry[] = [];
  for (const record of nullSeparatedOutput.split("\0")) {
    if (record.length === 0) continue;
    const tabIndex = record.indexOf("\t");
    if (tabIndex < 0) continue;
    const metadata = record.slice(0, tabIndex).split(" ");
    const mode = metadata[0];
    const objectId = metadata[1];
    const stageText = metadata[2];
    if (
      mode === undefined ||
      objectId === undefined ||
      stageText === undefined ||
      !isConflictStage(stageText)
    ) {
      continue;
    }
    entries.push({
      path: record.slice(tabIndex + 1),
      mode,
      objectId: isMissingObjectId(objectId) ? undefined : objectId,
      stage: Number(stageText) as 1 | 2 | 3,
    });
  }
  return entries;
}

/**
 * Parses `git status --porcelain=v2 -z --untracked-files=no` unmerged records.
 * Only unmerged `u` records contribute conflict paths; other valid porcelain
 * v2 records are validated and ignored. Paths may begin with record prefixes.
 */
export function parseConflictStatusRecords(
  nullSeparatedOutput: string,
): readonly ParsedConflictStatusRecord[] {
  const records = nullSeparatedOutput.split("\0");
  const conflicts: ParsedConflictStatusRecord[] = [];
  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    const record = records[recordIndex];
    if (record === undefined || !record.startsWith("u ")) continue;
    if (!looksLikeStatusRecord(record)) continue;
    const metadataAndPath = record.split(" ");
    const statusCode = metadataAndPath[1];
    if (statusCode === undefined || !isUnmergedStatus(statusCode)) continue;
    const path = unmergedPathFromRecord(record);
    if (path.length === 0) continue;
    conflicts.push({ path, originalPath: undefined, statusCode });
  }
  return conflicts;
}

export function classifyConflictEntry(
  statusCode: string,
  stages: Readonly<
    Record<ConflictSide, { readonly exists: boolean } | undefined>
  >,
  originalPath: string | undefined,
  hasBinaryStage: boolean,
  hasSubmoduleStage: boolean,
): ConflictEntryKind {
  if (hasSubmoduleStage) return "submodule";
  if (hasBinaryStage) return "binary";
  if (originalPath !== undefined) return "rename";
  if (statusCode === "AA") return "add-add";
  if (statusCode === "DD") return "delete-delete";
  if (
    statusCode === "UD" ||
    statusCode === "DU" ||
    statusCode === "UA" ||
    statusCode === "AU"
  ) {
    return "modify-delete";
  }
  if (
    stages.base?.exists &&
    stages.current?.exists &&
    stages.incoming?.exists
  ) {
    return "content";
  }
  return "unknown";
}

export function operationLabel(operation: ConflictOperationKind): string {
  switch (operation) {
    case "merge":
      return "Merge conflict";
    case "rebase":
      return "Rebase conflict";
    case "am":
      return "Patch apply conflict";
    case "cherry-pick":
      return "Cherry-pick conflict";
    case "revert":
      return "Revert conflict";
  }
}

function isConflictStage(stage: string): stage is "1" | "2" | "3" {
  return stage === "1" || stage === "2" || stage === "3";
}

function isMissingObjectId(objectId: string): boolean {
  return /^0+$/.test(objectId);
}

function isUnmergedStatus(statusCode: string): boolean {
  return /^[UDAT]{2}$/.test(statusCode) || statusCode === "UU";
}

function looksLikeStatusRecord(record: string): boolean {
  const fields = record.split(" ");
  const recordType = fields[0];
  if (recordType === "u") {
    // `u XY sub m1 m2 m3 mW h1 h2 h3 path`: ten fixed fields precede
    // the path. Validate the complete fixed grammar so a rename source such
    // as `u source.txt` is never mistaken for another record.
    return (
      fields.length >= 11 &&
      isStatusCode(fields[1]) &&
      isMode(fields[3]) &&
      isMode(fields[4]) &&
      isMode(fields[5]) &&
      isMode(fields[6]) &&
      hasNonEmptyFields(fields, 2, 10)
    );
  }
  if (recordType === "1") {
    // `1 XY sub mH mI mW hH hI path`.
    return (
      fields.length >= 9 &&
      isStatusCode(fields[1]) &&
      isMode(fields[3]) &&
      isMode(fields[4]) &&
      isMode(fields[5]) &&
      hasNonEmptyFields(fields, 2, 8)
    );
  }
  if (recordType === "2") {
    // `2 XY sub mH mI mW hH hI Xscore path` plus a NUL source path.
    return (
      fields.length >= 10 &&
      isStatusCode(fields[1]) &&
      isMode(fields[3]) &&
      isMode(fields[4]) &&
      isMode(fields[5]) &&
      hasNonEmptyFields(fields, 2, 9)
    );
  }
  if (recordType === "?" || recordType === "!" || recordType === "#") {
    return fields.length >= 2 && fields[1]?.length !== 0;
  }
  return false;
}

function isStatusCode(statusCode: string | undefined): boolean {
  return statusCode !== undefined && /^[.MADRCTU?!]{2}$/.test(statusCode);
}

function isMode(mode: string | undefined): boolean {
  return mode !== undefined && /^\d{6}$/.test(mode);
}

function hasNonEmptyFields(
  fields: readonly string[],
  startIndex: number,
  endIndexExclusive: number,
): boolean {
  for (
    let fieldIndex = startIndex;
    fieldIndex < endIndexExclusive;
    fieldIndex += 1
  ) {
    if ((fields[fieldIndex] ?? "").length === 0) return false;
  }
  return true;
}

function unmergedPathFromRecord(record: string): string {
  let separatorIndex = -1;
  for (let separatorCount = 0; separatorCount < 10; separatorCount += 1) {
    separatorIndex = record.indexOf(" ", separatorIndex + 1);
    if (separatorIndex < 0) return "";
  }
  return record.slice(separatorIndex + 1);
}
