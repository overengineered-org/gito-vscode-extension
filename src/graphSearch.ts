import type { GitCommit } from "./gitApi.ts";
import { runGitCommand, type GitCommandContext } from "./gitCommand.ts";
import type { GitReference } from "./gitModel.ts";

export interface GraphSearchQuery {
  readonly authorTerms: readonly string[];
  readonly filePath?: string;
  readonly messageTerms: readonly string[];
  readonly refTerms: readonly string[];
}

export interface GraphSearchPage {
  readonly changeStatsByCommitHash: ReadonlyMap<string, FileChangeStats>;
  readonly commits: readonly GitCommit[];
  readonly hasMore: boolean;
}

export interface FileChangeStats {
  readonly additions: number;
  readonly deletions: number;
}

const gitLogFieldSeparator = "\u001f";
const gitLogRecordSeparator = "\u001e";

export function parseGraphSearchQuery(searchText: string): GraphSearchQuery {
  const authorTerms: string[] = [];
  const messageTerms: string[] = [];
  const refTerms: string[] = [];
  let filePath: string | undefined;
  const searchTokenPattern = /(?:(author|message|ref|file):)?(?:"([^"]+)"|(\S+))/giu;
  for (const searchTokenMatch of searchText.matchAll(searchTokenPattern)) {
    const searchField = searchTokenMatch[1]?.toLowerCase();
    const searchTerm = (searchTokenMatch[2] ?? searchTokenMatch[3] ?? "").trim();
    if (searchTerm === "") {
      continue;
    }
    switch (searchField) {
      case "author":
        authorTerms.push(searchTerm);
        break;
      case "file":
        filePath = searchTerm;
        break;
      case "ref":
        refTerms.push(searchTerm);
        break;
      default:
        messageTerms.push(searchTerm);
    }
  }
  return {
    authorTerms,
    ...(filePath === undefined ? {} : { filePath }),
    messageTerms,
    refTerms,
  };
}

export async function searchCommitHistory(
  gitCommandContext: GitCommandContext,
  graphReferences: readonly GitReference[],
  searchText: string,
  fallbackFilePath: string | undefined,
  entryLimit: number,
): Promise<GraphSearchPage> {
  const searchQuery = parseGraphSearchQuery(searchText);
  const matchingReferenceNames = searchQuery.refTerms.length === 0
    ? []
    : graphReferences.flatMap((gitReference) => {
        const referenceName = gitReference.name;
        return referenceName !== undefined && searchQuery.refTerms.every((referenceTerm) =>
          referenceName.toLocaleLowerCase().includes(referenceTerm.toLocaleLowerCase()))
          ? [referenceName]
          : [];
      });
  if (searchQuery.refTerms.length > 0 && matchingReferenceNames.length === 0) {
    return { changeStatsByCommitHash: new Map(), commits: [], hasMore: false };
  }
  const requestedCommitCount = entryLimit + 1;
  const gitLogArguments = [
    "log",
    "--date-order",
    `--max-count=${requestedCommitCount}`,
    `--format=%x1e%H%x1f%P%x1f%an%x1f%at%x1f%s`,
    "--regexp-ignore-case",
    ...searchQuery.authorTerms.map((authorTerm) => `--author=${authorTerm}`),
    ...(searchQuery.messageTerms.length > 1 ? ["--all-match"] : []),
    ...searchQuery.messageTerms.map((messageTerm) => `--grep=${messageTerm}`),
    ...(matchingReferenceNames.length > 0 ? matchingReferenceNames : ["--all"]),
  ];
  const historyFilePath = normalizeGraphFileFilter(searchQuery.filePath ?? fallbackFilePath);
  if (historyFilePath !== undefined) {
    gitLogArguments.push("--numstat", "--", historyFilePath);
  }
  const gitLogOutput = await runGitCommand(gitCommandContext, gitLogArguments);
  const matchingCommits = parseGitLogRecords(gitLogOutput);
  return {
    changeStatsByCommitHash: parseFileChangeStatsByCommitHash(gitLogOutput),
    commits: matchingCommits.slice(0, entryLimit),
    hasMore: matchingCommits.length > entryLimit,
  };
}

export function normalizeGraphFileFilter(filePath: string | undefined): string | undefined {
  if (filePath === undefined) return undefined;
  const normalizedFilePath = filePath.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  if (
    normalizedFilePath === "" ||
    normalizedFilePath.startsWith("/") ||
    /^[a-z]:\//iu.test(normalizedFilePath) ||
    normalizedFilePath.split("/").includes("..")
  ) {
    throw new Error("File history paths must stay inside the selected repository.");
  }
  return normalizedFilePath;
}

export function parseFileChangeStatsByCommitHash(
  gitLogOutput: string,
): ReadonlyMap<string, FileChangeStats> {
  const changeStatsByCommitHash = new Map<string, FileChangeStats>();
  for (const gitLogRecord of gitLogOutput.split(gitLogRecordSeparator)) {
    const normalizedRecord = gitLogRecord.replace(/^\r?\n/u, "");
    const commitHash = normalizedRecord.split(gitLogFieldSeparator, 1)[0];
    if (commitHash === undefined || !/^[0-9a-f]{40,64}$/iu.test(commitHash)) continue;
    let additions = 0;
    let deletions = 0;
    for (const recordLine of normalizedRecord.split(/\r?\n/u)) {
      const numstatMatch = recordLine.match(/^(\d+|-)\t(\d+|-)\t/u);
      if (numstatMatch === null) continue;
      additions += numstatMatch[1] === "-" ? 0 : Number.parseInt(numstatMatch[1] ?? "0", 10);
      deletions += numstatMatch[2] === "-" ? 0 : Number.parseInt(numstatMatch[2] ?? "0", 10);
    }
    changeStatsByCommitHash.set(commitHash, { additions, deletions });
  }
  return changeStatsByCommitHash;
}

export function parseGitLogRecords(gitLogOutput: string): readonly GitCommit[] {
  return gitLogOutput
    .split(gitLogRecordSeparator)
    .flatMap((gitLogRecord): GitCommit[] => {
      const normalizedRecord = gitLogRecord.replace(/^\r?\n/u, "");
      if (normalizedRecord === "") {
        return [];
      }
      const [hash, parentList = "", authorName = "", unixTimestamp = "", messageAndStats = ""] =
        normalizedRecord.split(gitLogFieldSeparator);
      if (hash === undefined || !/^[0-9a-f]{40,64}$/iu.test(hash)) {
        return [];
      }
      const [message = ""] = messageAndStats.split(/\r?\n/u, 1);
      const parsedTimestamp = Number.parseInt(unixTimestamp, 10);
      return [{
        ...(authorName === "" ? {} : { authorName }),
        ...(Number.isFinite(parsedTimestamp) ? { commitDate: new Date(parsedTimestamp * 1_000) } : {}),
        hash,
        message,
        parents: parentList === "" ? [] : parentList.split(" "),
      }];
    });
}
