import { execFile } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { NodeGitCommandRunner } from "../../../src/extension/git/gitCommandRunner.js";
import {
  PremiumHistoryService,
  type HistoryRepositoryRoot,
} from "../../../src/extension/history/index.js";
import { createRealHistoryRootBindingResolver } from "../../unit/history/historyRootBindingTestSupport.js";

const executeFile = promisify(execFile);
const disposableFixtureRoots: string[] = [];

afterEach(async () => {
  while (disposableFixtureRoots.length > 0) {
    const fixtureRoot = disposableFixtureRoots.pop();
    if (fixtureRoot !== undefined)
      await rm(fixtureRoot, { recursive: true, force: true });
  }
});

describe("premium history real Git fixture", () => {
  it("proves rename, line movement, merge parents, blame, contributors, binary, and deleted history", async () => {
    const fixture = await createHistoryFixture();
    const repositoryRoot: HistoryRepositoryRoot = fixture.repositoryPath;
    const historyService = new PremiumHistoryService(
      new NodeGitCommandRunner(),
      createRealHistoryRootBindingResolver(),
    );

    const fileHistory = await historyService.listFileHistory(
      repositoryRoot,
      "renamed.txt",
      { maxEntries: 20 },
    );
    expect([
      fixture.mergeSha,
      fixture.mainParentSha,
      fixture.deleteSha,
    ]).toContain(fileHistory.entries[0]?.sha);
    expect(
      fileHistory.entries.some((entry) => entry.path === "story.txt"),
    ).toBe(true);
    const renameEntry = fileHistory.entries.find(
      (entry) => entry.sha === fixture.renameSha,
    );
    expect(renameEntry?.path).toBe("renamed.txt");
    expect(renameEntry?.previousPath).toBe("story.txt");
    expect(renameEntry?.changedFiles[0]).toMatchObject({
      changeType: "renamed",
      additions: 0,
      deletions: 0,
      previousPath: "story.txt",
    });

    const movedLineBlame = await historyService.getBlame(
      repositoryRoot,
      "renamed.txt",
      { revision: fixture.renameSha, range: { startLine: 3, endLine: 3 } },
    );
    expect(movedLineBlame).toHaveLength(1);
    expect(movedLineBlame[0]).toMatchObject({
      lineNumber: 3,
      content: "shared",
      commitSha: fixture.initialSha,
      pathAtRevision: "story.txt",
      summary: "initial story",
    });
    const expectedInitialAuthorDate = await runGit(fixture.repositoryPath, [
      "show",
      "-s",
      "--format=%aI",
      fixture.initialSha,
    ]);
    expect(movedLineBlame[0]?.authorDate).toBe(
      new Date(expectedInitialAuthorDate).toISOString(),
    );

    const lineHistory = await historyService.listLineHistory(
      repositoryRoot,
      "renamed.txt",
      3,
      { revision: fixture.renameSha, maxEntries: 20 },
    );
    expect(lineHistory.map((entry) => entry.sha)).toContain(fixture.moveSha);
    expect(
      lineHistory.find((entry) => entry.sha === fixture.moveSha)?.path,
    ).toBe("story.txt");
    const mergeNavigation = await historyService.getRevisionNavigation(
      repositoryRoot,
      fixture.mergeSha,
      "renamed.txt",
      fixture.featureParentSha,
    );
    expect(mergeNavigation.current.revisionSha).toBe(fixture.mergeSha);
    expect(mergeNavigation.parents.map((parent) => parent.sha)).toEqual(
      fixture.mergeParentShas,
    );
    expect(mergeNavigation.selectedParent?.sha).toBe(fixture.featureParentSha);
    expect(mergeNavigation.previousRevision?.revisionSha).toBe(
      fixture.featureParentSha,
    );
    expect(mergeNavigation.previousDiff?.left.revisionSha).toBe(
      fixture.featureParentSha,
    );
    expect(mergeNavigation.previousDiff?.right.revisionSha).toBe(
      fixture.mergeSha,
    );

    const contributors =
      await historyService.aggregateContributors(repositoryRoot);
    expect(
      contributors.contributors.map((contributor) => [
        contributor.authorEmail,
        contributor.commitCount,
      ]),
    ).toEqual([
      ["bea@example.test", 4],
      ["ada@example.test", 2],
      ["cal@example.test", 1],
    ]);

    const deletedFileHistory = await historyService.listFileHistory(
      repositoryRoot,
      "deleted.txt",
      { maxEntries: 20 },
    );
    expect(deletedFileHistory.entries.map((entry) => entry.sha)).toEqual([
      fixture.deleteSha,
      fixture.initialSha,
    ]);
    expect(deletedFileHistory.entries[0]?.changedFiles[0]).toMatchObject({
      changeType: "deleted",
      additions: 0,
      deletions: 1,
    });
    const binaryBlame = await historyService.getBlame(
      repositoryRoot,
      "binary.bin",
    );
    expect(binaryBlame[0]).toMatchObject({
      commitSha: fixture.initialSha,
      lineNumber: 1,
      pathAtRevision: "binary.bin",
    });
    const binaryHistory = await historyService.listFileHistory(
      repositoryRoot,
      "binary.bin",
      { maxEntries: 5 },
    );
    expect(binaryHistory.entries[0]?.changedFiles[0]).toMatchObject({
      changeType: "binary",
      additions: 0,
      deletions: 0,
    });
    expect(
      await readFile(nodePath.join(fixture.repositoryPath, "binary.bin")),
    ).toEqual(Buffer.from([0, 1, 255, 0, 4]));
  }, 30_000);

  it("searches exact file and regex patch terms with bounded native results", async () => {
    const fixture = await createHistoryFixture();
    const historyService = new PremiumHistoryService(
      new NodeGitCommandRunner(),
      createRealHistoryRootBindingResolver(),
    );
    const cancellationController = new AbortController();
    cancellationController.abort();
    await expect(
      historyService.listRepositoryHistory(fixture.repositoryPath, {
        cancellationSignal: cancellationController.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    const patchResults = await historyService.search(fixture.repositoryPath, {
      terms: [{ field: "patch", value: "needle.?patch" }],
      regex: true,
      matchAll: true,
      limit: 50,
    });
    expect(patchResults.matches.map((match) => match.sha)).toContain(
      fixture.moveSha,
    );
    expect(patchResults.matches[0]?.patchText).toMatch(/needle patch/);

    const fileResults = await historyService.search(fixture.repositoryPath, {
      terms: [
        { field: "file", value: "renamed.txt" },
        { field: "author", value: "Bea" },
      ],
      matchAll: true,
      matchCase: false,
      limit: 50,
    });
    expect(fileResults.matches.map((match) => match.sha)).toEqual([
      fixture.mainParentSha,
    ]);
  }, 30_000);

  it("reads real SHA-256 commit and blame identities", async () => {
    const rootDirectory = await mkdtemp(
      nodePath.join("/tmp", "gito-premium-history-sha256-"),
    );
    disposableFixtureRoots.push(rootDirectory);
    const repositoryPath = nodePath.join(rootDirectory, "repository");
    await runGit(rootDirectory, [
      "init",
      "--object-format=sha256",
      "-b",
      "main",
      repositoryPath,
    ]);
    await configureAuthor(repositoryPath, "Ada", "ada@example.test");
    await writeFile(nodePath.join(repositoryPath, "story.txt"), "sha256\n");
    await runGit(repositoryPath, ["add", "story.txt"]);
    await runGit(repositoryPath, ["commit", "-m", "sha256 story"]);
    const commitSha = await runGit(repositoryPath, ["rev-parse", "HEAD"]);
    expect(commitSha).toHaveLength(64);
    const historyService = new PremiumHistoryService(
      new NodeGitCommandRunner(),
      createRealHistoryRootBindingResolver(),
    );
    const history = await historyService.listRepositoryHistory(repositoryPath, {
      maxEntries: 2,
    });
    expect(history.commits[0]?.sha).toBe(commitSha);
    const blame = await historyService.getBlame(repositoryPath, "story.txt");
    expect(blame[0]?.commitSha).toBe(commitSha);
  }, 30_000);

  it("includes an unreachable detached HEAD in unscoped history surfaces", async () => {
    const fixture = await createHistoryFixture();
    await runGit(fixture.repositoryPath, [
      "checkout",
      "--detach",
      fixture.mergeSha,
    ]);
    await configureAuthor(
      fixture.repositoryPath,
      "Detached Dana",
      "dana@example.test",
    );
    await writeFile(
      nodePath.join(fixture.repositoryPath, "detached.txt"),
      "detached history\n",
    );
    await runGit(fixture.repositoryPath, ["add", "detached.txt"]);
    const detachedSha = await commit(
      fixture.repositoryPath,
      "detached-only history",
      "Detached Dana",
      "dana@example.test",
    );
    const historyService = new PremiumHistoryService(
      new NodeGitCommandRunner(),
      createRealHistoryRootBindingResolver(),
    );

    const history = await historyService.listRepositoryHistory(
      fixture.repositoryPath,
      { maxEntries: 100 },
    );
    expect(history.commits.map((commit) => commit.sha)).toContain(detachedSha);
    const search = await historyService.search(fixture.repositoryPath, {
      terms: [{ field: "message", value: "detached-only" }],
      limit: 1,
    });
    expect(search.matches.map((match) => match.sha)).toEqual([detachedSha]);
    const contributors = await historyService.aggregateContributors(
      fixture.repositoryPath,
      { maxEntries: 100 },
    );
    expect(
      contributors.contributors.map((contributor) => contributor.authorEmail),
    ).toContain("dana@example.test");
  }, 30_000);

  it("continues repository, file, and search pages with opaque cursors", async () => {
    const fixture = await createHistoryFixture();
    const historyService = new PremiumHistoryService(
      new NodeGitCommandRunner(),
      createRealHistoryRootBindingResolver(),
    );

    const firstHistoryPage = await historyService.listRepositoryHistory(
      fixture.repositoryPath,
      { maxEntries: 2 },
    );
    expect(firstHistoryPage.hasMore).toBe(true);
    expect(firstHistoryPage.nextCursor).toEqual(expect.any(String));
    const secondHistoryPage = await historyService.listRepositoryHistory(
      fixture.repositoryPath,
      {
        maxEntries: 2,
        ...(firstHistoryPage.nextCursor === undefined
          ? {}
          : { cursor: firstHistoryPage.nextCursor }),
      },
    );
    expect(secondHistoryPage.commits.map((commit) => commit.sha)).not.toEqual(
      expect.arrayContaining(
        firstHistoryPage.commits.map((commit) => commit.sha),
      ),
    );

    const firstFilePage = await historyService.listFileHistory(
      fixture.repositoryPath,
      "renamed.txt",
      { maxEntries: 2 },
    );
    expect(firstFilePage.nextCursor).toEqual(expect.any(String));
    const secondFilePage = await historyService.listFileHistory(
      fixture.repositoryPath,
      "renamed.txt",
      {
        maxEntries: 1,
        ...(firstFilePage.nextCursor === undefined
          ? {}
          : { cursor: firstFilePage.nextCursor }),
      },
    );
    expect(secondFilePage.entries[0]?.sha).not.toBe(
      firstFilePage.entries[0]?.sha,
    );
    expect(secondFilePage.entries[0]?.path).toBe("story.txt");

    const firstSearchPage = await historyService.search(
      fixture.repositoryPath,
      {
        terms: [],
        limit: 1,
      },
    );
    expect(firstSearchPage.hasMore).toBe(true);
    expect(firstSearchPage.nextCursor).toEqual(expect.any(String));
    const secondSearchPage = await historyService.search(
      fixture.repositoryPath,
      {
        terms: [],
        limit: 1,
        ...(firstSearchPage.nextCursor === undefined
          ? {}
          : { cursor: firstSearchPage.nextCursor }),
      },
    );
    expect(secondSearchPage.matches[0]?.sha).not.toBe(
      firstSearchPage.matches[0]?.sha,
    );
  }, 30_000);

  it("keeps magic-looking filenames literal and fails closed on a .git swap", async () => {
    const fixture = await createHistoryFixture();
    const historyService = new PremiumHistoryService(
      new NodeGitCommandRunner(),
      createRealHistoryRootBindingResolver(),
    );
    const magicPath = ":(literal)*[history].txt";
    await writeFile(
      nodePath.join(fixture.repositoryPath, magicPath),
      "magic\n",
    );
    await runGit(fixture.repositoryPath, [
      "--literal-pathspecs",
      "add",
      "--",
      magicPath,
    ]);
    const magicSha = await commit(
      fixture.repositoryPath,
      "add magic-looking filename",
      "Ada",
      "ada@example.test",
    );
    const magicHistory = await historyService.listFileHistory(
      fixture.repositoryPath,
      magicPath,
      { maxEntries: 5 },
    );
    expect(magicHistory.entries[0]?.sha).toBe(magicSha);
    expect(magicHistory.entries[0]?.path).toBe(magicPath);

    const gitDirectoryPath = nodePath.join(fixture.repositoryPath, ".git");
    const swappedGitDirectoryPath = nodePath.join(
      fixture.repositoryPath,
      ".git-swap",
    );
    await rename(gitDirectoryPath, swappedGitDirectoryPath);
    try {
      await expect(
        historyService.listRepositoryHistory(fixture.repositoryPath),
      ).rejects.toThrow(
        /history repository root|Git root binding|not a git repository/i,
      );
    } finally {
      await rename(swappedGitDirectoryPath, gitDirectoryPath);
    }
  }, 30_000);
});

interface HistoryFixture {
  readonly rootDirectory: string;
  readonly repositoryPath: string;
  readonly initialSha: string;
  readonly moveSha: string;
  readonly renameSha: string;
  readonly mainParentSha: string;
  readonly featureParentSha: string;
  readonly mergeSha: string;
  readonly mergeParentShas: readonly string[];
  readonly deleteSha: string;
}

async function createHistoryFixture(): Promise<HistoryFixture> {
  const rootDirectory = await mkdtemp(
    nodePath.join("/tmp", "gito-premium-history-"),
  );
  disposableFixtureRoots.push(rootDirectory);
  const repositoryPath = nodePath.join(rootDirectory, "repository");
  await runGit(rootDirectory, ["init", "-b", "main", repositoryPath]);
  await configureAuthor(repositoryPath, "Ada", "ada@example.test");
  await writeFile(
    nodePath.join(repositoryPath, "story.txt"),
    "alpha\nshared\nbeta\n",
  );
  await writeFile(
    nodePath.join(repositoryPath, "deleted.txt"),
    "to be deleted\n",
  );
  await writeFile(
    nodePath.join(repositoryPath, "binary.bin"),
    Buffer.from([0, 1, 255, 0, 4]),
  );
  await runGit(repositoryPath, ["add", "--all"]);
  const initialSha = await commit(
    repositoryPath,
    "initial story",
    "Ada",
    "ada@example.test",
  );

  await configureAuthor(repositoryPath, "Bea", "bea@example.test");
  await writeFile(
    nodePath.join(repositoryPath, "story.txt"),
    "alpha\nbeta\nshared\nneedle patch\n",
  );
  await runGit(repositoryPath, ["add", "story.txt"]);
  const moveSha = await commit(
    repositoryPath,
    "move shared line",
    "Bea",
    "bea@example.test",
  );

  await configureAuthor(repositoryPath, "Ada", "ada@example.test");
  await runGit(repositoryPath, ["mv", "story.txt", "renamed.txt"]);
  await runGit(repositoryPath, ["add", "-A"]);
  const renameSha = await commit(
    repositoryPath,
    "rename story",
    "Ada",
    "ada@example.test",
  );

  await runGit(repositoryPath, ["branch", "feature"]);
  await configureAuthor(repositoryPath, "Bea", "bea@example.test");
  await writeFile(
    nodePath.join(repositoryPath, "renamed.txt"),
    "alpha\nbeta\nshared\nneedle patch\nmain line\n",
  );
  await runGit(repositoryPath, ["add", "renamed.txt"]);
  const mainParentSha = await commit(
    repositoryPath,
    "main line",
    "Bea",
    "bea@example.test",
  );

  await runGit(repositoryPath, ["checkout", "feature"]);
  await configureAuthor(repositoryPath, "Cal", "cal@example.test");
  await writeFile(
    nodePath.join(repositoryPath, "feature.txt"),
    "feature line\n",
  );
  await runGit(repositoryPath, ["add", "feature.txt"]);
  const featureParentSha = await commit(
    repositoryPath,
    "feature line",
    "Cal",
    "cal@example.test",
  );

  await runGit(repositoryPath, ["checkout", "main"]);
  await configureAuthor(repositoryPath, "Bea", "bea@example.test");
  await runGit(repositoryPath, [
    "merge",
    "--no-ff",
    "feature",
    "-m",
    "merge feature",
  ]);
  const mergeSha = await runGit(repositoryPath, ["rev-parse", "HEAD"]);
  const mergeParentShas = (
    await runGit(repositoryPath, ["rev-list", "--parents", "-n", "1", mergeSha])
  )
    .split(" ")
    .slice(1);

  await runGit(repositoryPath, ["rm", "deleted.txt"]);
  const deleteSha = await commit(
    repositoryPath,
    "delete obsolete file",
    "Bea",
    "bea@example.test",
  );
  return {
    rootDirectory,
    repositoryPath,
    initialSha,
    moveSha,
    renameSha,
    mainParentSha,
    featureParentSha,
    mergeSha,
    mergeParentShas,
    deleteSha,
  };
}

async function configureAuthor(
  repositoryPath: string,
  authorName: string,
  authorEmail: string,
): Promise<void> {
  await runGit(repositoryPath, ["config", "user.name", authorName]);
  await runGit(repositoryPath, ["config", "user.email", authorEmail]);
}

async function commit(
  repositoryPath: string,
  subject: string,
  authorName: string,
  authorEmail: string,
): Promise<string> {
  await configureAuthor(repositoryPath, authorName, authorEmail);
  await runGit(repositoryPath, ["commit", "-m", subject]);
  return runGit(repositoryPath, ["rev-parse", "HEAD"]);
}

async function runGit(
  repositoryPath: string,
  gitArguments: readonly string[],
): Promise<string> {
  const commandResult = await executeFile("git", [...gitArguments], {
    cwd: repositoryPath,
    shell: false,
    encoding: "utf8",
  });
  return commandResult.stdout.trim();
}
