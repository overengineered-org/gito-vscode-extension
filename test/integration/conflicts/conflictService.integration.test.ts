import { execFile } from "node:child_process";
import {
  lstat,
  mkdtemp,
  mkdir,
  rename,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ConflictService } from "../../../src/extension/conflicts/index.js";
import {
  NodeGitCommandRunner,
  type GitCommandOutput,
  type GitCommandRequest,
  type GitCommandRunner,
} from "../../../src/extension/git/gitCommandRunner.js";

const executeFile = promisify(execFile);

const realGitIntegrationTest = (
  testName: string,
  testBody: () => Promise<void>,
): void => {
  it(testName, testBody, 30_000);
};

function createConflictService(
  gitCommandRunner: GitCommandRunner,
  workspaceTrustGuard: {
    readonly isWorkspaceTrusted: () => boolean;
    readonly assertTrusted: (operationName: string) => void;
  } = createTrustedWorkspaceTrustGuard(),
): ConflictService {
  return new ConflictService(gitCommandRunner, workspaceTrustGuard);
}

function createTrustedWorkspaceTrustGuard() {
  return {
    isWorkspaceTrusted: () => true,
    assertTrusted: () => undefined,
  };
}
const fixtureDirectories: string[] = [];

afterEach(async () => {
  while (fixtureDirectories.length > 0) {
    const fixtureDirectory = fixtureDirectories.pop();
    if (fixtureDirectory !== undefined) {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  }
});

describe("real Git conflict service", () => {
  realGitIntegrationTest(
    "detects labeled stages, previews without writing, applies one exact file, and rejects stale state",
    async () => {
      const repository = await createConflictRepository({
        baseContent: "base\n",
        currentContent: "current\n",
        incomingContent: "incoming\n",
      });
      const service = createConflictService(new NodeGitCommandRunner());
      const initialSnapshot = await service.inspect(repository);
      const conflictFile = initialSnapshot.files.find(
        (file) => file.path === "conflict.txt",
      );

      expect(initialSnapshot.operation?.kind).toBe("merge");
      expect(initialSnapshot.repositoryRootBinding).toMatchObject({
        canonicalPath: await realpath(repository),
        gitDirectory: {
          canonicalPath: initialSnapshot.gitDirectory,
        },
        commonDirectory: {
          canonicalPath: initialSnapshot.gitDirectory,
        },
      });
      expect(initialSnapshot.operation?.sourceDescription).toContain("merged");
      expect(conflictFile?.kind).toBe("content");
      expect(conflictFile?.stages.base?.content?.toString()).toBe("base\n");
      expect(conflictFile?.stages.current?.content?.toString()).toBe(
        "current\n",
      );
      expect(conflictFile?.stages.incoming?.content?.toString()).toBe(
        "incoming\n",
      );

      const plan = await service.previewResolutions(repository, [
        {
          path: "conflict.txt",
          choice: "keep-current",
          combinedContent: undefined,
        },
      ]);
      expect(plan.preview).toContain("Current (checked-out branch)");
      expect(plan.preview).toContain("Incoming (operation source)");
      expect(
        await readFile(path.join(repository, "conflict.txt"), "utf8"),
      ).toContain("<<<<<<<");

      await writeFile(
        path.join(repository, "conflict.txt"),
        "changed while preview open\n",
      );
      await expect(
        service.applyResolution(plan, { confirm: () => Promise.resolve(true) }),
      ).rejects.toMatchObject({ code: "stale-state" });
      await writeFile(
        path.join(repository, "conflict.txt"),
        "<<<<<<< HEAD\ncurrent\n=======\nincoming\n>>>>>>> incoming\n",
      );

      await writeFile(path.join(repository, "unrelated.txt"), "leave staged\n");
      await runGit(repository, ["add", "unrelated.txt"]);
      const freshPlan = await service.previewResolutions(repository, [
        {
          path: "conflict.txt",
          choice: "keep-current",
          combinedContent: undefined,
        },
      ]);
      expect(freshPlan.expectedRepositoryRootBinding).toEqual(
        freshPlan.rollback.sourceRepositoryRootBinding,
      );
      const applyResult = await service.applyResolution(freshPlan, {
        confirm: (preview) => Promise.resolve(preview.includes("conflict.txt")),
      });

      expect(applyResult.appliedPaths).toEqual(["conflict.txt"]);
      expect(
        await readFile(path.join(repository, "conflict.txt"), "utf8"),
      ).toBe("current\n");
      expect(
        await runGit(repository, ["ls-files", "-s", "--", "conflict.txt"]),
      ).toMatch(/ 0\tconflict\.txt\n/);
      expect(
        await runGit(repository, ["diff", "--cached", "--name-only"]),
      ).toContain("unrelated.txt");
      expect(await runGit(repository, ["ls-files", "-u"])).toBe("");
    },
  );

  realGitIntegrationTest(
    "classifies add/add, modify/delete, and binary conflicts without guessing renames",
    async () => {
      const addAddRepository = await createAddAddRepository();
      const modifyDeleteRepository = await createModifyDeleteRepository();
      const renameRepository = await createRenameRenameRepository();
      const renameDeleteRepository = await createRenameDeleteRepository();
      const binaryRepository = await createBinaryRepository();
      const service = createConflictService(new NodeGitCommandRunner());

      expect((await service.inspect(addAddRepository)).files[0]?.kind).toBe(
        "add-add",
      );
      expect(
        (await service.inspect(modifyDeleteRepository)).files[0]?.kind,
      ).toBe("modify-delete");
      const renameFiles = (await service.inspect(renameRepository)).files;
      expect(renameFiles.every((file) => file.originalPath === undefined)).toBe(
        true,
      );
      expect(renameFiles.every((file) => file.kind !== "rename")).toBe(true);
      const renameDeleteFiles = (await service.inspect(renameDeleteRepository))
        .files;
      expect(
        renameDeleteFiles.every((file) => file.originalPath === undefined),
      ).toBe(true);
      expect((await service.inspect(binaryRepository)).files[0]?.kind).toBe(
        "binary",
      );
    },
  );

  realGitIntegrationTest(
    "inspects a real file-directory type-change conflict without synthetic rename data",
    async () => {
      const repository = await createTypeChangeRepository();
      const service = createConflictService(new NodeGitCommandRunner());
      const snapshot = await service.inspect(repository);
      expect(snapshot.files.some((file) => file.path === "type.txt~HEAD")).toBe(
        true,
      );
      expect(
        snapshot.files.every((file) => file.originalPath === undefined),
      ).toBe(true);
    },
  );

  realGitIntegrationTest(
    "preserves CRLF stage bytes and refuses invalid-encoding blobs as text",
    async () => {
      const crlfRepository = await createConflictRepository({
        baseContent: "base\r\n",
        currentContent: "current\r\n",
        incomingContent: "incoming\r\n",
      });
      const invalidEncodingRepository = await createInvalidEncodingRepository();
      const service = createConflictService(new NodeGitCommandRunner());
      const crlfFile = (await service.inspect(crlfRepository)).files[0];
      expect(crlfFile?.stages.base?.content).toEqual(Buffer.from("base\r\n"));
      expect(crlfFile?.stages.current?.content).toEqual(
        Buffer.from("current\r\n"),
      );
      expect(crlfFile?.stages.incoming?.content).toEqual(
        Buffer.from("incoming\r\n"),
      );
      expect(
        (await service.inspect(invalidEncodingRepository)).files[0]?.kind,
      ).toBe("binary");
    },
  );

  realGitIntegrationTest(
    "passes wildcard-looking paths as literal Git pathspecs",
    async () => {
      const conflictPath = "literal*[x]?.txt";
      const repository = await createPathConflictRepository(conflictPath);
      const service = createConflictService(new NodeGitCommandRunner());
      const plan = await service.previewResolutions(repository, [
        { path: conflictPath, choice: "keep-current" },
      ]);
      await service.applyResolution(plan, {
        confirm: () => Promise.resolve(true),
      });
      expect(await readFile(path.join(repository, conflictPath), "utf8")).toBe(
        "current\n",
      );
    },
  );

  realGitIntegrationTest(
    "does not resolve a second path matched by a wildcard-looking conflict path",
    async () => {
      const repository = await createMultiPathWildcardConflictRepository();
      const service = createConflictService(new NodeGitCommandRunner());
      const plan = await service.previewResolutions(repository, [
        { path: "literal*.txt", choice: "keep-current" },
      ]);

      await service.applyResolution(plan, {
        confirm: () => Promise.resolve(true),
      });

      expect(
        await readFile(path.join(repository, "literal*.txt"), "utf8"),
      ).toBe("current literal\n");
      expect(
        await readFile(path.join(repository, "literal-other.txt"), "utf8"),
      ).toContain("<<<<<<<");
      expect(
        await runGit(repository, ["ls-files", "-u", "--", "literal-other.txt"]),
      ).not.toBe("");
    },
  );

  realGitIntegrationTest(
    "rechecks workspace trust after confirmation before changing a conflict",
    async () => {
      const repository = await createConflictRepository({
        baseContent: "base\n",
        currentContent: "current\n",
        incomingContent: "incoming\n",
      });
      let workspaceTrusted = true;
      const service = createConflictService(new NodeGitCommandRunner(), {
        isWorkspaceTrusted: () => workspaceTrusted,
        assertTrusted: () => {
          if (!workspaceTrusted) {
            throw new Error("workspace trust revoked");
          }
        },
      });
      const plan = await service.previewResolutions(repository, [
        { path: "conflict.txt", choice: "keep-current" },
      ]);
      await expect(
        service.applyResolution(plan, {
          confirm: () => {
            workspaceTrusted = false;
            return Promise.resolve(true);
          },
        }),
      ).rejects.toThrow("untrusted workspace");
      expect(await runGit(repository, ["ls-files", "-u"])).not.toBe("");
      expect(
        await readFile(path.join(repository, "conflict.txt"), "utf8"),
      ).toContain("<<<<<<<");
    },
  );

  realGitIntegrationTest(
    "fails closed when workspace trust is unavailable",
    async () => {
      const repository = await createConflictRepository({
        baseContent: "base\n",
        currentContent: "current\n",
        incomingContent: "incoming\n",
      });
      const service = createConflictService(new NodeGitCommandRunner(), {
        isWorkspaceTrusted: () => false,
        assertTrusted: () => {
          throw new Error("workspace trust unavailable");
        },
      });
      const plan = await service.previewResolutions(repository, [
        { path: "conflict.txt", choice: "keep-current" },
      ]);

      await expect(
        service.applyResolution(plan, { confirm: () => Promise.resolve(true) }),
      ).rejects.toMatchObject({ code: "operation-unavailable" });
      expect(await runGit(repository, ["ls-files", "-u"])).not.toBe("");
    },
  );

  realGitIntegrationTest(
    "fails closed when bounded conflict status output is truncated",
    async () => {
      const repository = await createConflictRepository({
        baseContent: "base\n",
        currentContent: "current\n",
        incomingContent: "incoming\n",
      });
      const service = createConflictService(
        new TruncatedConflictOutputRunner(),
      );
      await expect(service.inspect(repository)).rejects.toMatchObject({
        code: "invalid-plan",
      });
    },
  );

  realGitIntegrationTest(
    "rejects oversized combined content before changing the worktree",
    async () => {
      const repository = await createConflictRepository({
        baseContent: "base\n",
        currentContent: "current\n",
        incomingContent: "incoming\n",
      });
      const service = createConflictService(new NodeGitCommandRunner());
      const snapshot = await service.inspect(repository);
      const conflictFile = snapshot.files[0];
      await expect(
        service.previewResolutions(repository, [
          {
            path: conflictFile?.path ?? "conflict.txt",
            choice: "combine",
            combinedContent: Buffer.alloc(4 * 1024 * 1024 + 1, 0x61),
          },
        ]),
      ).rejects.toMatchObject({ code: "invalid-plan" });
      expect(await runGit(repository, ["ls-files", "-u"])).not.toBe("");
    },
  );

  realGitIntegrationTest(
    "refuses transactional choices when recorded working bytes exceed the cap",
    async () => {
      const repository = await createConflictRepository({
        baseContent: "base\n",
        currentContent: "current\n",
        incomingContent: "incoming\n",
      });
      const oversizedWorkingTreeBytes = Buffer.alloc(4 * 1024 * 1024 + 1, 0x62);
      await writeFile(
        path.join(repository, "conflict.txt"),
        oversizedWorkingTreeBytes,
      );
      const service = createConflictService(new NodeGitCommandRunner());
      const snapshot = await service.inspect(repository);
      expect(snapshot.files[0]?.workingTreeContent).toBeUndefined();
      expect(snapshot.files[0]?.workingTreeKind).toBe("file");
      expect(snapshot.files[0]?.workingTreeByteLength).toBe(
        oversizedWorkingTreeBytes.byteLength,
      );
      await expect(
        service.previewResolutions(repository, [
          { path: "conflict.txt", choice: "keep-current" },
        ]),
      ).rejects.toMatchObject({ code: "invalid-plan" });
      expect(
        (await readFile(path.join(repository, "conflict.txt"))).equals(
          oversizedWorkingTreeBytes,
        ),
      ).toBe(true);
      expect(await runGit(repository, ["ls-files", "-u"])).not.toBe("");
    },
  );

  realGitIntegrationTest(
    "refuses side choices for a real conflicted gitlink directory",
    async () => {
      const repository = await createSubmoduleConflictRepository();
      const service = createConflictService(new NodeGitCommandRunner());
      const snapshot = await service.inspect(repository);
      expect(snapshot.files[0]?.kind).toBe("submodule");
      await expect(
        service.previewResolutions(repository, [
          { path: "submodule", choice: "keep-current" },
        ]),
      ).rejects.toMatchObject({ code: "operation-unavailable" });
      expect(
        (await lstat(path.join(repository, "submodule"))).isDirectory(),
      ).toBe(true);
      expect(await runGit(repository, ["ls-files", "-u"])).not.toBe("");
    },
  );

  realGitIntegrationTest(
    "propagates an already-cancelled inspection without reading Git state",
    async () => {
      const repository = await createConflictRepository({
        baseContent: "base\n",
        currentContent: "current\n",
        incomingContent: "incoming\n",
      });
      const cancellationController = new AbortController();
      cancellationController.abort();
      const service = createConflictService(new NodeGitCommandRunner());

      await expect(
        service.inspect(repository, {
          cancellationSignal: cancellationController.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
    },
  );

  realGitIntegrationTest(
    "fails closed when the canonical Git directory changes before apply",
    async () => {
      const repository = await createConflictRepository({
        baseContent: "base\n",
        currentContent: "current\n",
        incomingContent: "incoming\n",
      });
      const planningService = createConflictService(new NodeGitCommandRunner());
      const plan = await planningService.previewResolutions(repository, [
        { path: "conflict.txt", choice: "keep-current" },
      ]);
      const service = createConflictService(new ChangedGitDirectoryRunner());

      await expect(
        service.applyResolution(plan, { confirm: () => Promise.resolve(true) }),
      ).rejects.toMatchObject({ code: "invalid-plan" });
      expect(
        await readFile(path.join(repository, "conflict.txt"), "utf8"),
      ).toContain("<<<<<<<");
    },
  );

  realGitIntegrationTest(
    "classifies symlink conflicts as non-editor content and blocks unsafe writes",
    async () => {
      const repository = await createSymlinkConflictRepository();
      const service = createConflictService(new NodeGitCommandRunner());
      const snapshot = await service.inspect(repository);
      expect(snapshot.files[0]?.kind).toBe("binary");
      await expect(
        service.previewResolutions(repository, [
          {
            path: "link",
            choice: "combine",
            combinedContent: Buffer.from("unsafe replacement\n"),
          },
        ]),
      ).rejects.toMatchObject({ code: "operation-unavailable" });
      expect(await readlink(path.join(repository, "link"))).toBe(
        "current-target",
      );
      expect(await runGit(repository, ["ls-files", "-u"])).not.toBe("");
    },
  );

  realGitIntegrationTest(
    "keeps a symlink side with exact target bytes",
    async () => {
      const repository = await createSymlinkConflictRepository();
      const service = createConflictService(new NodeGitCommandRunner());
      const plan = await service.previewResolutions(repository, [
        { path: "link", choice: "keep-current" },
      ]);

      await service.applyResolution(plan, {
        confirm: () => Promise.resolve(true),
      });

      expect(await readlink(path.join(repository, "link"))).toBe(
        "current-target",
      );
      expect(await runGit(repository, ["ls-files", "-u"])).toBe("");
    },
  );

  realGitIntegrationTest(
    "rejects a root-level symlink replacement after preview",
    async () => {
      const repository = await createSymlinkConflictRepository();
      const service = createConflictService(new NodeGitCommandRunner());
      const plan = await service.previewResolutions(repository, [
        { path: "link", choice: "keep-current" },
      ]);
      await rm(path.join(repository, "link"), { force: true });
      await symlink("replacement-target", path.join(repository, "link"));

      await expect(
        service.applyResolution(plan, {
          confirm: () => Promise.resolve(true),
        }),
      ).rejects.toMatchObject({ code: "stale-state" });
      expect(await readlink(path.join(repository, "link"))).toBe(
        "replacement-target",
      );
    },
  );

  realGitIntegrationTest(
    "rejects a FIFO leaf before any file write",
    async () => {
      const repository = await createConflictRepository({
        baseContent: "base\n",
        currentContent: "current\n",
        incomingContent: "incoming\n",
      });
      const conflictPath = path.join(repository, "conflict.txt");
      await rm(conflictPath, { force: true });
      await executeFile("mkfifo", [conflictPath]);
      const service = createConflictService(new NodeGitCommandRunner());
      await expect(
        service.previewResolutions(repository, [
          { path: "conflict.txt", choice: "keep-current" },
        ]),
      ).rejects.toMatchObject({ code: "invalid-plan" });
      expect((await lstat(conflictPath)).isFIFO()).toBe(true);
    },
  );

  realGitIntegrationTest(
    "fails closed when a parent is swapped during mutation validation",
    async () => {
      const repository = await createConflictRepository({
        baseContent: "base\n",
        currentContent: "current\n",
        incomingContent: "incoming\n",
        conflictPath: "nested/conflict.txt",
      });
      const outsideDirectory = await mkdtemp(
        path.join(path.dirname(repository), "outside-parent-"),
      );
      fixtureDirectories.push(outsideDirectory);
      await writeFile(path.join(outsideDirectory, "conflict.txt"), "outside\n");
      const planningService = createConflictService(new NodeGitCommandRunner());
      const plan = await planningService.previewResolutions(repository, [
        { path: "nested/conflict.txt", choice: "keep-current" },
      ]);
      const service = createConflictService(
        new ParentSwapRunner(path.join(repository, "nested"), outsideDirectory),
      );

      await expect(
        service.applyResolution(plan, {
          confirm: () => Promise.resolve(true),
        }),
      ).rejects.toMatchObject({ code: "invalid-plan" });
      expect(
        await readFile(path.join(outsideDirectory, "conflict.txt"), "utf8"),
      ).toBe("outside\n");
    },
  );

  realGitIntegrationTest(
    "rejects another conflict changing after preview",
    async () => {
      const repository = await createTwoFileConflictRepository();
      const service = createConflictService(new NodeGitCommandRunner());
      const plan = await service.previewResolutions(repository, [
        { path: "conflict.txt", choice: "keep-current" },
      ]);
      await writeFile(
        path.join(repository, "other.txt"),
        "changed elsewhere\n",
      );

      await expect(
        service.applyResolution(plan, {
          confirm: () => Promise.resolve(true),
        }),
      ).rejects.toMatchObject({ code: "stale-state" });
    },
  );

  realGitIntegrationTest(
    "rejects a same-byte working-tree leaf replacement after preview",
    async () => {
      const repository = await createConflictRepository({
        baseContent: "base\n",
        currentContent: "current\n",
        incomingContent: "incoming\n",
      });
      const service = createConflictService(new NodeGitCommandRunner());
      const plan = await service.previewResolutions(repository, [
        { path: "conflict.txt", choice: "keep-current" },
      ]);
      const conflictPath = path.join(repository, "conflict.txt");
      const originalLeaf = await lstat(conflictPath);
      const replacementPath = path.join(repository, ".same-byte-replacement");
      await writeFile(replacementPath, await readFile(conflictPath), {
        mode: originalLeaf.mode & 0o777,
      });
      await rename(replacementPath, conflictPath);
      const replacementLeaf = await lstat(conflictPath);
      expect(
        `${String(replacementLeaf.dev)}:${String(replacementLeaf.ino)}`,
      ).not.toBe(`${String(originalLeaf.dev)}:${String(originalLeaf.ino)}`);

      await expect(
        service.applyResolution(plan, {
          confirm: () => Promise.resolve(true),
        }),
      ).rejects.toMatchObject({ code: "stale-state" });
      expect(await readFile(conflictPath, "utf8")).toContain("<<<<<<<");
      expect(await runGit(repository, ["ls-files", "-u"])).not.toBe("");
    },
  );

  realGitIntegrationTest("rejects HEAD changes after preview", async () => {
    const repository = await createConflictRepository({
      baseContent: "base\n",
      currentContent: "current\n",
      incomingContent: "incoming\n",
    });
    const service = createConflictService(new NodeGitCommandRunner());
    const plan = await service.previewResolutions(repository, [
      { path: "conflict.txt", choice: "keep-current" },
    ]);
    const headTree = await runGit(repository, ["rev-parse", "HEAD^{tree}"]);
    const currentHead = await runGit(repository, ["rev-parse", "HEAD"]);
    const movedHead = await runGit(repository, [
      "commit-tree",
      headTree.trim(),
      "-p",
      currentHead.trim(),
      "-m",
      "move head during conflict",
    ]);
    await runGit(repository, [
      "update-ref",
      "refs/heads/main",
      movedHead.trim(),
    ]);

    await expect(
      service.applyResolution(plan, {
        confirm: () => Promise.resolve(true),
      }),
    ).rejects.toMatchObject({ code: "stale-state" });
  });

  realGitIntegrationTest(
    "propagates cancellation during a large working-tree read",
    async () => {
      const repository = await createConflictRepository({
        baseContent: "base\n",
        currentContent: "current\n",
        incomingContent: "incoming\n",
      });
      await writeFile(
        path.join(repository, "conflict.txt"),
        Buffer.alloc(32 * 1024 * 1024, 0x61),
      );
      const cancellationController = new AbortController();
      const cancellationTimer = setTimeout(
        () => cancellationController.abort(),
        0,
      );
      try {
        await expect(
          createConflictService(new NodeGitCommandRunner()).inspect(
            repository,
            {
              cancellationSignal: cancellationController.signal,
            },
          ),
        ).rejects.toMatchObject({ name: "AbortError" });
      } finally {
        clearTimeout(cancellationTimer);
      }
    },
  );

  realGitIntegrationTest(
    "requires explicit confirmation, supports manual editor previews, and aborts safely",
    async () => {
      const repository = await createConflictRepository({
        baseContent: "base\n",
        currentContent: "current\n",
        incomingContent: "incoming\n",
      });
      const service = createConflictService(new NodeGitCommandRunner());
      const snapshot = await service.inspect(repository);
      const manualPlan = await service.previewResolutions(repository, [
        { path: "conflict.txt", choice: "manual", combinedContent: undefined },
      ]);
      expect(manualPlan.actions[0]).toMatchObject({
        type: "open-merge-editor",
        commandIdentifier: "git.openMergeEditor",
      });
      expect(
        service.createMergeEditorCommand(repository, "conflict.txt")
          .commandIdentifier,
      ).toBe("git.openMergeEditor");
      await expect(
        service.applyResolution(manualPlan, {
          confirm: () => Promise.resolve(true),
        }),
      ).rejects.toMatchObject({ code: "manual-resolution-required" });

      const keepIncomingPlan = await service.previewResolutions(repository, [
        {
          path: "conflict.txt",
          choice: "keep-incoming",
          combinedContent: undefined,
        },
      ]);
      await expect(
        service.applyResolution(keepIncomingPlan, {
          confirm: () => Promise.resolve(false),
        }),
      ).rejects.toMatchObject({ code: "cancelled" });
      expect(await runGit(repository, ["ls-files", "-u"])).not.toBe("");

      const aborted = await service.abort(
        repository,
        { confirm: () => Promise.resolve(true) },
        snapshot.fingerprint,
      );
      expect(aborted.operation).toBe("merge");
      expect(aborted.snapshot.operation).toBeUndefined();
      expect(
        await readFile(path.join(repository, "conflict.txt"), "utf8"),
      ).toBe("current\n");
    },
  );

  realGitIntegrationTest(
    "applies only explicitly supplied combined bytes",
    async () => {
      const repository = await createConflictRepository({
        baseContent: "base\n",
        currentContent: "current\n",
        incomingContent: "incoming\n",
      });
      const service = createConflictService(new NodeGitCommandRunner());
      const plan = await service.previewResolutions(repository, [
        {
          path: "conflict.txt",
          choice: "combine",
          combinedContent: Buffer.from("combined by the caller\n"),
        },
      ]);
      expect(plan.actions[0]).toMatchObject({ type: "write-content" });
      await service.applyResolution(plan, {
        confirm: () => Promise.resolve(true),
      });
      expect(
        await readFile(path.join(repository, "conflict.txt"), "utf8"),
      ).toBe("combined by the caller\n");
      expect(await runGit(repository, ["ls-files", "-u"])).toBe("");
    },
  );

  realGitIntegrationTest(
    "continues a resolved merge only after eligibility and confirmation",
    async () => {
      const repository = await createConflictRepository({
        baseContent: "base\n",
        currentContent: "current\n",
        incomingContent: "incoming\n",
      });
      const service = createConflictService(new NodeGitCommandRunner());
      const plan = await service.previewResolutions(repository, [
        {
          path: "conflict.txt",
          choice: "keep-incoming",
          combinedContent: undefined,
        },
      ]);
      const applied = await service.applyResolution(plan, {
        confirm: () => Promise.resolve(true),
      });
      expect(applied.snapshotAfterApply.canContinue).toBe(true);
      const continued = await service.continue(
        repository,
        { confirm: () => Promise.resolve(true) },
        applied.snapshotAfterApply.fingerprint,
      );
      expect(continued.snapshot.operation).toBeUndefined();
      expect(await runGit(repository, ["log", "-1", "--format=%s"])).toContain(
        "Merge branch",
      );
    },
  );

  realGitIntegrationTest(
    "detects rebase, cherry-pick, and revert operation state and abort restores cleanly",
    async () => {
      const rebaseRepository = await createRebaseRepository();
      const cherryPickRepository = await createCherryPickRepository();
      const revertRepository = await createRevertRepository();
      const service = createConflictService(new NodeGitCommandRunner());

      expect((await service.inspect(rebaseRepository)).operation?.kind).toBe(
        "rebase",
      );
      expect(
        (await service.inspect(cherryPickRepository)).operation?.kind,
      ).toBe("cherry-pick");
      expect((await service.inspect(revertRepository)).operation?.kind).toBe(
        "revert",
      );

      expect(
        (
          await service.previewResolutions(rebaseRepository, [
            { path: "conflict.txt", choice: "keep-current" },
          ])
        ).preview,
      ).toContain("Ours (rebase target)");
      expect(
        (
          await service.previewResolutions(cherryPickRepository, [
            { path: "conflict.txt", choice: "keep-incoming" },
          ])
        ).preview,
      ).toContain("Theirs (picked commit)");
      expect(
        (
          await service.previewResolutions(revertRepository, [
            { path: "conflict.txt", choice: "keep-incoming" },
          ])
        ).preview,
      ).toContain("Theirs (revert source)");

      for (const repository of [
        rebaseRepository,
        cherryPickRepository,
        revertRepository,
      ]) {
        const beforeAbort = await service.inspect(repository);
        await service.abort(
          repository,
          { confirm: () => Promise.resolve(true) },
          beforeAbort.fingerprint,
        );
        expect((await service.inspect(repository)).operation).toBeUndefined();
      }
    },
  );

  realGitIntegrationTest(
    "distinguishes a conflicted git am from a rebase",
    async () => {
      const repository = await createAmRepository();
      const service = createConflictService(new NodeGitCommandRunner());
      const snapshot = await service.inspect(repository);

      expect(snapshot.operation?.kind).toBe("am");
      expect(snapshot.operation?.metadataPath).toContain("rebase-apply");
      await service.abort(repository, { confirm: () => Promise.resolve(true) });
      expect((await service.inspect(repository)).operation).toBeUndefined();
    },
  );

  realGitIntegrationTest(
    "restores exact working bytes and index stages after a partial apply failure",
    async () => {
      const repository = await createTwoFileConflictRepository();
      const baselineService = createConflictService(new NodeGitCommandRunner());
      const baselineSnapshot = await baselineService.inspect(repository);
      const baselineIndex = await runGit(repository, ["ls-files", "-u", "-z"]);
      const failingRunner = new FailOnePathRunner("other.txt");
      const service = createConflictService(failingRunner);
      const plan = await service.previewResolutions(repository, [
        { path: "conflict.txt", choice: "keep-current" },
        { path: "other.txt", choice: "keep-incoming" },
      ]);

      await expect(
        service.applyResolution(plan, {
          confirm: () => Promise.resolve(true),
        }),
      ).rejects.toThrow("intentional add failure");
      expect(await readFile(path.join(repository, "conflict.txt"))).toEqual(
        baselineSnapshot.files.find((file) => file.path === "conflict.txt")
          ?.workingTreeContent,
      );
      expect(await readFile(path.join(repository, "other.txt"))).toEqual(
        baselineSnapshot.files.find((file) => file.path === "other.txt")
          ?.workingTreeContent,
      );
      expect(await runGit(repository, ["ls-files", "-u", "-z"])).toBe(
        baselineIndex,
      );
    },
  );

  realGitIntegrationTest(
    "reports rollback failure separately when exact index recovery fails",
    async () => {
      const repository = await createTwoFileConflictRepository();
      const service = createConflictService(
        new FailOnePathRunner("other.txt", true),
      );
      const plan = await service.previewResolutions(repository, [
        { path: "conflict.txt", choice: "keep-current" },
        { path: "other.txt", choice: "keep-incoming" },
      ]);

      await expect(
        service.applyResolution(plan, {
          confirm: () => Promise.resolve(true),
        }),
      ).rejects.toMatchObject({ code: "rollback-failed" });
    },
  );

  realGitIntegrationTest(
    "fails rollback closed when a post-apply leaf changes",
    async () => {
      const repository = await createTwoFileConflictRepository();
      const service = createConflictService(
        new FailAfterChangingPathRunner(
          path.join(repository, "conflict.txt"),
          "other.txt",
        ),
      );
      const plan = await service.previewResolutions(repository, [
        { path: "conflict.txt", choice: "keep-current" },
        { path: "other.txt", choice: "keep-incoming" },
      ]);

      await expect(
        service.applyResolution(plan, {
          confirm: () => Promise.resolve(true),
        }),
      ).rejects.toMatchObject({ code: "rollback-failed" });
      expect(
        await readFile(path.join(repository, "conflict.txt"), "utf8"),
      ).toBe("attacker changed bytes\n");
    },
  );
});

class FailOnePathRunner implements GitCommandRunner {
  private readonly delegate = new NodeGitCommandRunner();

  public constructor(
    private readonly failingPath: string,
    private readonly failRollback = false,
  ) {}

  public run(request: GitCommandRequest): Promise<GitCommandOutput> {
    if (
      ["add", "checkout-index", "update-index"].includes(
        request.arguments[0] ?? "",
      ) &&
      !request.arguments.includes("--index-info") &&
      request.arguments.some((argument) => argument.includes(this.failingPath))
    ) {
      return Promise.reject(new Error("intentional add failure"));
    }
    if (
      this.failRollback &&
      request.arguments[0] === "update-index" &&
      request.arguments.includes("--index-info")
    ) {
      return Promise.reject(new Error("intentional rollback failure"));
    }
    return this.delegate.run(request);
  }

  public runStreaming(
    request: GitCommandRequest,
    onStandardOutputChunk: (chunk: string) => void,
  ): Promise<GitCommandOutput> {
    return this.delegate.runStreaming(request, onStandardOutputChunk);
  }
}

class FailAfterChangingPathRunner implements GitCommandRunner {
  private readonly delegate = new NodeGitCommandRunner();

  public constructor(
    private readonly pathToChange: string,
    private readonly failingPath: string,
  ) {}

  public async run(request: GitCommandRequest): Promise<GitCommandOutput> {
    if (
      request.arguments[0] === "update-index" &&
      !request.arguments.includes("--index-info") &&
      request.arguments.some(
        (argument) =>
          argument === this.failingPath ||
          argument.endsWith(`,${this.failingPath}`),
      )
    ) {
      await writeFile(this.pathToChange, "attacker changed bytes\n");
      throw new Error("intentional add failure after leaf change");
    }
    return this.delegate.run(request);
  }

  public runStreaming(
    request: GitCommandRequest,
    onStandardOutputChunk: (chunk: string) => void,
  ): Promise<GitCommandOutput> {
    return this.delegate.runStreaming(request, onStandardOutputChunk);
  }
}

class ChangedGitDirectoryRunner implements GitCommandRunner {
  private readonly delegate = new NodeGitCommandRunner();

  public run(request: GitCommandRequest): Promise<GitCommandOutput> {
    if (
      request.arguments[0] === "rev-parse" &&
      request.arguments[1] === "--absolute-git-dir"
    ) {
      return Promise.resolve({
        standardOutput: "/tmp/gito-missing-git-dir\n",
        standardError: "",
        exitCode: 0,
      });
    }
    return this.delegate.run(request);
  }

  public runStreaming(
    request: GitCommandRequest,
    onStandardOutputChunk: (chunk: string) => void,
  ): Promise<GitCommandOutput> {
    return this.delegate.runStreaming(request, onStandardOutputChunk);
  }
}

class TruncatedConflictOutputRunner implements GitCommandRunner {
  private readonly delegate = new NodeGitCommandRunner();

  public run(request: GitCommandRequest): Promise<GitCommandOutput> {
    if (
      request.arguments[0] === "status" ||
      (request.arguments[0] === "ls-files" && request.arguments[1] === "-u")
    ) {
      return Promise.resolve({
        standardOutput: "partial",
        standardError: "",
        exitCode: 0,
        standardOutputTruncated: true,
      });
    }
    return this.delegate.run(request);
  }

  public runStreaming(
    request: GitCommandRequest,
    onStandardOutputChunk: (chunk: string) => void,
  ): Promise<GitCommandOutput> {
    return this.delegate.runStreaming(request, onStandardOutputChunk);
  }
}

class ParentSwapRunner implements GitCommandRunner {
  private readonly delegate = new NodeGitCommandRunner();
  private absoluteGitDirectoryCallCount = 0;
  private swapped = false;

  public constructor(
    private readonly parentDirectory: string,
    private readonly outsideDirectory: string,
  ) {}

  public run(request: GitCommandRequest): Promise<GitCommandOutput> {
    const isGitDirectoryRead =
      request.arguments[0] === "rev-parse" &&
      request.arguments[1] === "--absolute-git-dir";
    if (!isGitDirectoryRead) return this.delegate.run(request);
    this.absoluteGitDirectoryCallCount += 1;
    return this.delegate.run(request).then(async (output) => {
      if (this.absoluteGitDirectoryCallCount === 2 && !this.swapped) {
        this.swapped = true;
        await rm(this.parentDirectory, { recursive: true, force: true });
        await symlink(this.outsideDirectory, this.parentDirectory);
      }
      return output;
    });
  }

  public runStreaming(
    request: GitCommandRequest,
    onStandardOutputChunk: (chunk: string) => void,
  ): Promise<GitCommandOutput> {
    return this.delegate.runStreaming(request, onStandardOutputChunk);
  }
}

interface ConflictRepositoryOptions {
  readonly baseContent: string;
  readonly currentContent: string;
  readonly incomingContent: string;
  readonly conflictPath?: string;
}

async function createConflictRepository(
  options: ConflictRepositoryOptions,
): Promise<string> {
  const repository = await createRepository();
  const conflictPath = options.conflictPath ?? "conflict.txt";
  await mkdir(path.dirname(path.join(repository, conflictPath)), {
    recursive: true,
  });
  await writeFile(path.join(repository, conflictPath), options.baseContent);
  await runGit(repository, ["add", "--", conflictPath]);
  await runGit(repository, ["commit", "-m", "add conflict base"]);
  await runGit(repository, ["checkout", "-b", "incoming"]);
  await writeFile(path.join(repository, conflictPath), options.incomingContent);
  await runGit(repository, ["add", "--", conflictPath]);
  await runGit(repository, ["commit", "-m", "incoming change"]);
  await runGit(repository, ["checkout", "main"]);
  await writeFile(path.join(repository, conflictPath), options.currentContent);
  await runGit(repository, ["add", "--", conflictPath]);
  await runGit(repository, ["commit", "-m", "current change"]);
  await runGitAllowFailure(repository, ["merge", "incoming"]);
  return repository;
}

async function createAddAddRepository(): Promise<string> {
  const repository = await createRepository();
  await runGit(repository, ["checkout", "-b", "incoming"]);
  await writeFile(path.join(repository, "new.txt"), "incoming\n");
  await runGit(repository, ["add", "new.txt"]);
  await runGit(repository, ["commit", "-m", "incoming add"]);
  await runGit(repository, ["checkout", "main"]);
  await writeFile(path.join(repository, "new.txt"), "current\n");
  await runGit(repository, ["add", "new.txt"]);
  await runGit(repository, ["commit", "-m", "current add"]);
  await runGitAllowFailure(repository, ["merge", "incoming"]);
  return repository;
}

async function createModifyDeleteRepository(): Promise<string> {
  const repository = await createRepository();
  await writeFile(path.join(repository, "conflict.txt"), "base\n");
  await runGit(repository, ["add", "conflict.txt"]);
  await runGit(repository, ["commit", "-m", "add conflict file"]);
  await runGit(repository, ["checkout", "-b", "incoming"]);
  await runGit(repository, ["rm", "conflict.txt"]);
  await runGit(repository, ["commit", "-m", "incoming delete"]);
  await runGit(repository, ["checkout", "main"]);
  await writeFile(
    path.join(repository, "conflict.txt"),
    "current modification\n",
  );
  await runGit(repository, ["add", "conflict.txt"]);
  await runGit(repository, ["commit", "-m", "current modify"]);
  await runGitAllowFailure(repository, ["merge", "incoming"]);
  return repository;
}

async function createTypeChangeRepository(): Promise<string> {
  const repository = await createRepository();
  await writeFile(path.join(repository, "type.txt"), "base\n");
  await runGit(repository, ["add", "type.txt"]);
  await runGit(repository, ["commit", "-m", "add type base"]);
  await runGit(repository, ["checkout", "-b", "incoming"]);
  await runGit(repository, ["rm", "type.txt"]);
  await mkdir(path.join(repository, "type.txt"));
  await writeFile(path.join(repository, "type.txt", "incoming"), "incoming\n");
  await runGit(repository, ["add", "-A"]);
  await runGit(repository, ["commit", "-m", "incoming type change"]);
  await runGit(repository, ["checkout", "main"]);
  await writeFile(path.join(repository, "type.txt"), "current\n");
  await runGit(repository, ["add", "type.txt"]);
  await runGit(repository, ["commit", "-m", "current type change"]);
  await runGitAllowFailure(repository, ["merge", "incoming"]);
  return repository;
}

async function createRenameRenameRepository(): Promise<string> {
  const repository = await createRepository();
  await writeFile(path.join(repository, "rename.txt"), "base\n");
  await runGit(repository, ["add", "rename.txt"]);
  await runGit(repository, ["commit", "-m", "add rename source"]);
  await runGit(repository, ["checkout", "-b", "incoming"]);
  await runGit(repository, ["mv", "rename.txt", "incoming-name.txt"]);
  await runGit(repository, ["commit", "-m", "incoming rename"]);
  await runGit(repository, ["checkout", "main"]);
  await runGit(repository, ["mv", "rename.txt", "current-name.txt"]);
  await runGit(repository, ["commit", "-m", "current rename"]);
  await runGitAllowFailure(repository, ["merge", "incoming"]);
  return repository;
}

async function createRenameDeleteRepository(): Promise<string> {
  const repository = await createRepository();
  await writeFile(path.join(repository, "rename-delete.txt"), "base\n");
  await runGit(repository, ["add", "rename-delete.txt"]);
  await runGit(repository, ["commit", "-m", "add rename-delete source"]);
  await runGit(repository, ["checkout", "-b", "incoming"]);
  await runGit(repository, ["mv", "rename-delete.txt", "incoming-name.txt"]);
  await runGit(repository, ["commit", "-m", "incoming rename"]);
  await runGit(repository, ["checkout", "main"]);
  await runGit(repository, ["rm", "rename-delete.txt"]);
  await runGit(repository, ["commit", "-m", "current delete"]);
  await runGitAllowFailure(repository, ["merge", "incoming"]);
  return repository;
}

async function createBinaryRepository(): Promise<string> {
  const repository = await createRepository();
  await writeFile(
    path.join(repository, "binary.dat"),
    Buffer.from([0, 1, 2, 3]),
  );
  await runGit(repository, ["add", "binary.dat"]);
  await runGit(repository, ["commit", "-m", "add binary"]);
  await runGit(repository, ["checkout", "-b", "incoming"]);
  await writeFile(
    path.join(repository, "binary.dat"),
    Buffer.from([0, 10, 2, 3]),
  );
  await runGit(repository, ["add", "binary.dat"]);
  await runGit(repository, ["commit", "-m", "incoming binary"]);
  await runGit(repository, ["checkout", "main"]);
  await writeFile(
    path.join(repository, "binary.dat"),
    Buffer.from([0, 20, 2, 3]),
  );
  await runGit(repository, ["add", "binary.dat"]);
  await runGit(repository, ["commit", "-m", "current binary"]);
  await runGitAllowFailure(repository, ["merge", "incoming"]);
  return repository;
}

async function createInvalidEncodingRepository(): Promise<string> {
  const repository = await createRepository();
  await writeFile(
    path.join(repository, "invalid.dat"),
    Buffer.from([0xff, 0xfe, 0x00, 0x01]),
  );
  await runGit(repository, ["add", "invalid.dat"]);
  await runGit(repository, ["commit", "-m", "add invalid encoding"]);
  await runGit(repository, ["checkout", "-b", "incoming"]);
  await writeFile(
    path.join(repository, "invalid.dat"),
    Buffer.from([0xff, 0xfd, 0x00, 0x02]),
  );
  await runGit(repository, ["add", "invalid.dat"]);
  await runGit(repository, ["commit", "-m", "incoming invalid encoding"]);
  await runGit(repository, ["checkout", "main"]);
  await writeFile(
    path.join(repository, "invalid.dat"),
    Buffer.from([0xff, 0xfc, 0x00, 0x03]),
  );
  await runGit(repository, ["add", "invalid.dat"]);
  await runGit(repository, ["commit", "-m", "current invalid encoding"]);
  await runGitAllowFailure(repository, ["merge", "incoming"]);
  return repository;
}

async function createPathConflictRepository(
  conflictPath: string,
): Promise<string> {
  const repository = await createRepository();
  await writeFile(path.join(repository, conflictPath), "base\n");
  await runGit(repository, ["add", "--", conflictPath]);
  await runGit(repository, ["commit", "-m", "add literal path"]);
  await runGit(repository, ["checkout", "-b", "incoming"]);
  await writeFile(path.join(repository, conflictPath), "incoming\n");
  await runGit(repository, ["add", "--", conflictPath]);
  await runGit(repository, ["commit", "-m", "incoming literal path"]);
  await runGit(repository, ["checkout", "main"]);
  await writeFile(path.join(repository, conflictPath), "current\n");
  await runGit(repository, ["add", "--", conflictPath]);
  await runGit(repository, ["commit", "-m", "current literal path"]);
  await runGitAllowFailure(repository, ["merge", "incoming"]);
  return repository;
}

async function createMultiPathWildcardConflictRepository(): Promise<string> {
  const repository = await createRepository();
  await writeFile(path.join(repository, "literal*.txt"), "base literal\n");
  await writeFile(path.join(repository, "literal-other.txt"), "base other\n");
  await runGit(repository, ["add", "--", "literal*.txt", "literal-other.txt"]);
  await runGit(repository, ["commit", "-m", "add wildcard paths"]);
  await runGit(repository, ["checkout", "-b", "incoming"]);
  await writeFile(path.join(repository, "literal*.txt"), "incoming literal\n");
  await writeFile(
    path.join(repository, "literal-other.txt"),
    "incoming other\n",
  );
  await runGit(repository, ["add", "--", "literal*.txt", "literal-other.txt"]);
  await runGit(repository, ["commit", "-m", "incoming wildcard paths"]);
  await runGit(repository, ["checkout", "main"]);
  await writeFile(path.join(repository, "literal*.txt"), "current literal\n");
  await writeFile(
    path.join(repository, "literal-other.txt"),
    "current other\n",
  );
  await runGit(repository, ["add", "--", "literal*.txt", "literal-other.txt"]);
  await runGit(repository, ["commit", "-m", "current wildcard paths"]);
  await runGitAllowFailure(repository, ["merge", "incoming"]);
  return repository;
}

async function createSymlinkConflictRepository(): Promise<string> {
  const repository = await createRepository();
  await symlink("base-target", path.join(repository, "link"));
  await runGit(repository, ["add", "--", "link"]);
  await runGit(repository, ["commit", "-m", "add symlink"]);
  await runGit(repository, ["checkout", "-b", "incoming"]);
  await rm(path.join(repository, "link"));
  await symlink("incoming-target", path.join(repository, "link"));
  await runGit(repository, ["add", "--", "link"]);
  await runGit(repository, ["commit", "-m", "incoming symlink"]);
  await runGit(repository, ["checkout", "main"]);
  await rm(path.join(repository, "link"));
  await symlink("current-target", path.join(repository, "link"));
  await runGit(repository, ["add", "--", "link"]);
  await runGit(repository, ["commit", "-m", "current symlink"]);
  await runGitAllowFailure(repository, ["merge", "incoming"]);
  return repository;
}

async function createSubmoduleConflictRepository(): Promise<string> {
  const repository = await createRepository();
  const nestedRepository = await mkdtemp(path.join("/tmp", "gito-submodule-"));
  fixtureDirectories.push(nestedRepository);
  await runGit(nestedRepository, ["init", "-b", "main"]);
  await runGit(nestedRepository, ["config", "user.name", "Nested Fixture"]);
  await runGit(nestedRepository, [
    "config",
    "user.email",
    "nested@example.test",
  ]);
  await writeFile(path.join(nestedRepository, "nested.txt"), "one\n");
  await runGit(nestedRepository, ["add", "nested.txt"]);
  await runGit(nestedRepository, ["commit", "-m", "nested one"]);
  const baseObjectId = (
    await runGit(nestedRepository, ["rev-parse", "HEAD"])
  ).trim();
  await writeFile(path.join(nestedRepository, "nested.txt"), "two\n");
  await runGit(nestedRepository, ["commit", "-am", "nested two"]);
  const incomingObjectId = (
    await runGit(nestedRepository, ["rev-parse", "HEAD"])
  ).trim();
  await writeFile(path.join(nestedRepository, "nested.txt"), "three\n");
  await runGit(nestedRepository, ["commit", "-am", "nested three"]);
  const currentObjectId = (
    await runGit(nestedRepository, ["rev-parse", "HEAD"])
  ).trim();
  await runGit(repository, ["fetch", nestedRepository, "main"]);
  await runGit(repository, [
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${baseObjectId},submodule`,
  ]);
  await runGit(repository, ["commit", "-m", "add base gitlink"]);
  await runGit(repository, ["checkout", "-b", "incoming"]);
  await runGit(repository, [
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${incomingObjectId},submodule`,
  ]);
  await runGit(repository, ["commit", "-m", "incoming gitlink"]);
  await runGit(repository, ["checkout", "main"]);
  await runGit(repository, [
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${currentObjectId},submodule`,
  ]);
  await runGit(repository, ["commit", "-m", "current gitlink"]);
  await runGitAllowFailure(repository, ["merge", "incoming"]);
  await mkdir(path.join(repository, "submodule"), { recursive: true });
  await writeFile(path.join(repository, "submodule", "working.txt"), "local\n");
  return repository;
}

async function createRebaseRepository(): Promise<string> {
  const repository = await createRepository();
  await runGit(repository, ["checkout", "-b", "feature"]);
  await writeFile(path.join(repository, "conflict.txt"), "feature\n");
  await runGit(repository, ["add", "conflict.txt"]);
  await runGit(repository, ["commit", "-m", "feature change"]);
  await runGit(repository, ["checkout", "main"]);
  await writeFile(path.join(repository, "conflict.txt"), "main\n");
  await runGit(repository, ["add", "conflict.txt"]);
  await runGit(repository, ["commit", "-m", "main change"]);
  await runGit(repository, ["checkout", "feature"]);
  await runGitAllowFailure(repository, ["rebase", "main"]);
  return repository;
}

async function createCherryPickRepository(): Promise<string> {
  const repository = await createRepository();
  await runGit(repository, ["checkout", "-b", "incoming"]);
  await writeFile(path.join(repository, "conflict.txt"), "incoming\n");
  await runGit(repository, ["add", "conflict.txt"]);
  await runGit(repository, ["commit", "-m", "incoming commit"]);
  const incomingCommit = (
    await runGit(repository, ["rev-parse", "HEAD"])
  ).trim();
  await runGit(repository, ["checkout", "main"]);
  await writeFile(path.join(repository, "conflict.txt"), "main\n");
  await runGit(repository, ["add", "conflict.txt"]);
  await runGit(repository, ["commit", "-m", "main commit"]);
  await runGitAllowFailure(repository, ["cherry-pick", incomingCommit]);
  return repository;
}

async function createRevertRepository(): Promise<string> {
  const repository = await createRepository();
  await writeFile(path.join(repository, "conflict.txt"), "first\n");
  await runGit(repository, ["add", "conflict.txt"]);
  await runGit(repository, ["commit", "-m", "first change"]);
  const firstCommit = (await runGit(repository, ["rev-parse", "HEAD"])).trim();
  await writeFile(path.join(repository, "conflict.txt"), "second\n");
  await runGit(repository, ["add", "conflict.txt"]);
  await runGit(repository, ["commit", "-m", "second change"]);
  await runGitAllowFailure(repository, ["revert", firstCommit]);
  return repository;
}

async function createAmRepository(): Promise<string> {
  const repository = await createConflictRepository({
    baseContent: "base\n",
    currentContent: "current\n",
    incomingContent: "incoming\n",
  });
  await runGitAllowFailure(repository, ["merge", "--abort"]);
  await runGit(repository, ["checkout", "incoming"]);
  const patch = await runGit(repository, ["format-patch", "-1", "--stdout"]);
  await runGit(repository, ["checkout", "main"]);
  await writeFile(path.join(repository, "incoming.patch"), patch);
  await runGitAllowFailure(repository, ["am", "incoming.patch"]);
  return repository;
}

async function createTwoFileConflictRepository(): Promise<string> {
  const repository = await createRepository();
  await writeFile(path.join(repository, "conflict.txt"), "base conflict\n");
  await writeFile(path.join(repository, "other.txt"), "base other\n");
  await runGit(repository, ["add", "conflict.txt", "other.txt"]);
  await runGit(repository, ["commit", "-m", "add conflict files"]);
  await runGit(repository, ["checkout", "-b", "incoming"]);
  await writeFile(path.join(repository, "conflict.txt"), "incoming conflict\n");
  await writeFile(path.join(repository, "other.txt"), "incoming other\n");
  await runGit(repository, ["add", "conflict.txt", "other.txt"]);
  await runGit(repository, ["commit", "-m", "incoming conflict files"]);
  await runGit(repository, ["checkout", "main"]);
  await writeFile(path.join(repository, "conflict.txt"), "current conflict\n");
  await writeFile(path.join(repository, "other.txt"), "current other\n");
  await runGit(repository, ["add", "conflict.txt", "other.txt"]);
  await runGit(repository, ["commit", "-m", "current conflict files"]);
  await runGitAllowFailure(repository, ["merge", "incoming"]);
  return repository;
}

async function createRepository(): Promise<string> {
  const rootDirectory = await mkdtemp(path.join("/tmp", "gito-conflicts-"));
  fixtureDirectories.push(rootDirectory);
  await runGit(rootDirectory, ["init", "-b", "main"]);
  await runGit(rootDirectory, ["config", "user.name", "Conflict Fixture"]);
  await runGit(rootDirectory, [
    "config",
    "user.email",
    "conflicts@example.test",
  ]);
  await writeFile(path.join(rootDirectory, "README.md"), "fixture\n");
  await runGit(rootDirectory, ["add", "README.md"]);
  await runGit(rootDirectory, ["commit", "-m", "initial fixture"]);
  return rootDirectory;
}

async function runGit(
  repository: string,
  gitArguments: readonly string[],
): Promise<string> {
  const result = await executeFile("git", [...gitArguments], {
    cwd: repository,
    shell: false,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout;
}

async function runGitAllowFailure(
  repository: string,
  gitArguments: readonly string[],
): Promise<void> {
  try {
    await runGit(repository, gitArguments);
  } catch {
    // Expected for each deliberately interrupted operation.
  }
}
