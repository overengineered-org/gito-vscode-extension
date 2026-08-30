export interface LineBlame {
  readonly authorName: string;
  readonly authoredAt?: Date;
  readonly commitHash?: string;
  readonly summary: string;
}

export function parseLineBlame(blamePorcelain: string): LineBlame | undefined {
  const [headerLine = ""] = blamePorcelain.split("\n", 1);
  const commitHash = headerLine.split(" ", 1)[0];
  if (commitHash === undefined || !/^[0-9a-f]{40,64}$/iu.test(commitHash)) {
    return undefined;
  }
  const authorName = readPorcelainField(blamePorcelain, "author") ?? "Unknown author";
  const summary = readPorcelainField(blamePorcelain, "summary") ?? "No commit message";
  if (/^0+$/u.test(commitHash)) {
    return { authorName: "You", summary: "Uncommitted change" };
  }
  const authorTimestamp = Number.parseInt(
    readPorcelainField(blamePorcelain, "author-time") ?? "",
    10,
  );
  return {
    authorName,
    ...(Number.isFinite(authorTimestamp) ? { authoredAt: new Date(authorTimestamp * 1_000) } : {}),
    commitHash,
    summary,
  };
}

export function formatBlameAge(authoredAt: Date, now = new Date()): string {
  const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - authoredAt.getTime()) / 1_000));
  if (elapsedSeconds < 60) return "now";
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 30) return `${elapsedDays}d`;
  const elapsedMonths = Math.floor(elapsedDays / 30);
  return elapsedMonths < 12 ? `${elapsedMonths}mo` : `${Math.floor(elapsedMonths / 12)}y`;
}

export function formatLineBlameAnnotation(
  lineBlame: LineBlame,
  blameAge: string,
  maximumSummaryGraphemes = 72,
): string {
  const summaryGraphemes = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(lineBlame.summary),
  ].map((summarySegment) => summarySegment.segment);
  const conciseSummary = summaryGraphemes.length > maximumSummaryGraphemes
    ? `${summaryGraphemes.slice(0, maximumSummaryGraphemes - 1).join("")}…`
    : lineBlame.summary;
  return `  ${lineBlame.authorName} · ${blameAge} · ${conciseSummary}`;
}

function readPorcelainField(blamePorcelain: string, fieldName: string): string | undefined {
  const fieldPrefix = `${fieldName} `;
  return blamePorcelain
    .split("\n")
    .find((blameLine) => blameLine.startsWith(fieldPrefix))
    ?.slice(fieldPrefix.length);
}
