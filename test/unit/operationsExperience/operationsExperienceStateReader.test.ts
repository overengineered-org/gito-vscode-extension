import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  GitCommandOutput,
  GitCommandRequest,
  GitCommandRunner,
} from "../../../src/extension/git/gitCommandRunner.js";
import { GitOperationsExperienceStateReader } from "../../../src/extension/operationsExperience/operationsExperienceStateReader.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const temporaryDirectory = temporaryDirectories.pop();
    if (temporaryDirectory !== undefined)
      await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

describe("GitOperationsExperienceStateReader", () => {
  it("detects active rebase metadata for the operation banner", async () => {
    const repositoryRoot = await mkdtemp(
      nodePath.join("/tmp", "gito-state-reader-"),
    );
    temporaryDirectories.push(repositoryRoot);
    await mkdir(nodePath.join(repositoryRoot, ".git", "rebase-merge"), {
      recursive: true,
    });
    const reader = new GitOperationsExperienceStateReader(
      new StateReaderCommandRunner(repositoryRoot),
    );

    const banner = await reader.read(repositoryRoot);

    expect(banner.operation).toBe("rebase");
    expect(banner.branch).toBe("feature/operations");
    expect(banner.summary).toContain("Rebase in progress");
  });
});

class StateReaderCommandRunner implements GitCommandRunner {
  public constructor(private readonly repositoryRoot: string) {}

  public run(request: GitCommandRequest): Promise<GitCommandOutput> {
    if (request.arguments[0] === "status")
      return Promise.resolve({
        standardOutput: "## feature/operations...origin/main\n M README.md\n",
        standardError: "",
        exitCode: 0,
      });
    if (request.arguments[0] === "rev-parse")
      return Promise.resolve({
        standardOutput: `${this.repositoryRoot}/.git\n`,
        standardError: "",
        exitCode: 0,
      });
    return Promise.resolve({
      standardOutput: "",
      standardError: "",
      exitCode: 0,
    });
  }

  public runStreaming(
    request: GitCommandRequest,
    onStandardOutputChunk: (chunk: string) => void,
  ): Promise<GitCommandOutput> {
    void onStandardOutputChunk;
    return this.run(request);
  }
}
