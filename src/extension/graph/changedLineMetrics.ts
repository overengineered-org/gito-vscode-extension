import type { GitCommandRunner } from "../git/gitCommandRunner.js";
import type { ChangedLineMetrics } from "./graphModels.js";

export interface GraphMetricsRepositoryRoot {
  readonly fsPath: string;
}

const graphMetricsOutputByteCap = 16 * 1024 * 1024;
const graphMetricsFieldCharacterCap = 4_096;

function assertCommitSha(commitSha: string): void {
  if (commitSha.trim().length === 0 || commitSha.includes("\0"))
    throw new Error("A valid commit identity is required.");
}

/** Parses numstat without retaining file paths or patch bodies. */
export function parseChangedLineMetrics(
  commitSha: string,
  numstatOutput: string,
  options: { readonly truncated?: boolean } = {},
): ChangedLineMetrics {
  assertCommitSha(commitSha);
  let additions = 0;
  let deletions = 0;
  let changedFileCount = 0;
  let binaryFileCount = 0;
  for (const line of numstatOutput.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const fields = line.slice(0, graphMetricsFieldCharacterCap).split("\t");
    const additionField = fields[0];
    const deletionField = fields[1];
    if (additionField === undefined || deletionField === undefined) continue;
    changedFileCount += 1;
    if (additionField === "-" || deletionField === "-") {
      binaryFileCount += 1;
      continue;
    }
    const additionCount = Number(additionField);
    const deletionCount = Number(deletionField);
    if (
      !Number.isSafeInteger(additionCount) ||
      !Number.isSafeInteger(deletionCount)
    )
      continue;
    additions += Math.max(0, additionCount);
    deletions += Math.max(0, deletionCount);
  }
  return {
    commitSha,
    additions,
    deletions,
    changedFileCount,
    binaryFileCount,
    ...(options.truncated === true ? { truncated: true } : {}),
  };
}

export class GitChangedLineMetricsLoader {
  public constructor(
    private readonly gitCommandRunner: GitCommandRunner,
    private readonly repositoryRoot: GraphMetricsRepositoryRoot,
  ) {}

  public async loadChangedLineMetrics(
    commitSha: string,
    cancellationSignal?: AbortSignal,
  ): Promise<ChangedLineMetrics> {
    assertCommitSha(commitSha);
    const output = await this.gitCommandRunner.run({
      repositoryRoot: this.repositoryRoot.fsPath,
      arguments: [
        "show",
        "--no-ext-diff",
        "--format=",
        "--numstat",
        "--no-renames",
        commitSha,
      ],
      cancellationSignal,
      maxStandardOutputBytes: graphMetricsOutputByteCap,
    });
    return parseChangedLineMetrics(
      commitSha,
      output.standardOutput,
      output.standardOutputTruncated === true ? { truncated: true } : {},
    );
  }
}
