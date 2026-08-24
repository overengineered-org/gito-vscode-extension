import {
  mkdtemp,
  mkdir,
  rename,
  rm,
  realpath,
  symlink,
  writeFile,
  stat,
} from "node:fs/promises";
import { symlinkSync, unlinkSync } from "node:fs";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => {
  class TestFileSystemError extends Error {
    public static FileNotADirectory(): TestFileSystemError {
      return new TestFileSystemError("Not a directory");
    }

    public static NoPermissions(message: string): TestFileSystemError {
      return new TestFileSystemError(message);
    }
  }
  class TestUri {
    public constructor(
      public readonly scheme: string,
      public readonly path: string,
      public readonly query: string,
    ) {}

    public static file(filePath: string): TestUri {
      return new TestUri("file", filePath, "");
    }

    public get fsPath(): string {
      return this.path;
    }

    public static parse(uriText: string): TestUri {
      const parsedUri = new URL(uriText);
      return new TestUri(
        parsedUri.protocol.slice(0, -1),
        parsedUri.pathname,
        parsedUri.search.slice(1),
      );
    }
  }
  return {
    FileSystemError: TestFileSystemError,
    FileType: { File: 1 },
    Uri: TestUri,
  };
});

import {
  createDiffSymlinkUriProvider,
  GitDiffRequestError,
} from "../../../src/extension/diff/gitDiffService.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const temporaryDirectory = temporaryDirectories.pop();
    if (temporaryDirectory !== undefined)
      await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

describe("safe diff symlink URI provider", () => {
  it("exposes only registered link text and invalidates it per session", async () => {
    const temporaryDirectory = await mkdtemp(
      nodePath.join("/tmp", "gito-symlink-provider-"),
    );
    temporaryDirectories.push(temporaryDirectory);
    await writeFile(nodePath.join(temporaryDirectory, "target"), "target\n");
    const linkPath = nodePath.join(temporaryDirectory, "link");
    await symlink("target", linkPath);
    const provider = createDiffSymlinkUriProvider();

    const linkUri = provider.symlink(linkPath, temporaryDirectory);
    expect(linkUri.query).not.toContain(linkPath);
    await expect(
      provider.provideTextDocumentContent(linkUri, {} as never),
    ).resolves.toBe("target");
    const emptyUri = provider.empty("/repo/added.txt", "original");

    provider.beginSession();
    await expect(
      provider.provideTextDocumentContent(linkUri, {} as never),
    ).resolves.toBe("target");
    await expect(
      provider.provideTextDocumentContent(emptyUri, {} as never),
    ).resolves.toBe("");
    provider.dispose();
  });

  it("retains bounded prior epochs and evicts their registrations at the cap", async () => {
    const temporaryDirectory = await mkdtemp(
      nodePath.join("/tmp", "gito-symlink-provider-epochs-"),
    );
    temporaryDirectories.push(temporaryDirectory);
    await writeFile(nodePath.join(temporaryDirectory, "target"), "target\n");
    const linkPath = nodePath.join(temporaryDirectory, "link");
    await symlink("target", linkPath);
    const provider = createDiffSymlinkUriProvider({
      maxRegistrationsPerSession: 1,
      maxRetainedSessions: 2,
    });

    const firstUri = provider.symlink(linkPath, temporaryDirectory);
    expect(() => provider.empty("/repo/added.txt", "original")).toThrow(
      GitDiffRequestError,
    );
    expect(() => provider.symlink(linkPath, temporaryDirectory)).toThrow(
      GitDiffRequestError,
    );
    provider.beginSession();
    const secondUri = provider.symlink(linkPath, temporaryDirectory);
    await expect(
      provider.provideTextDocumentContent(firstUri, {} as never),
    ).resolves.toBe("target");
    await expect(
      provider.provideTextDocumentContent(secondUri, {} as never),
    ).resolves.toBe("target");
    provider.beginSession();
    await expect(
      provider.provideTextDocumentContent(firstUri, {} as never),
    ).resolves.toBe("[symlink target unavailable]");
    await expect(
      provider.provideTextDocumentContent(secondUri, {} as never),
    ).resolves.toBe("target");
    provider.dispose();
  });

  it("creates opaque empty-side URIs backed by the same session provider", async () => {
    const provider = createDiffSymlinkUriProvider();
    const emptyUri = provider.empty("/repo/added.txt", "original");

    expect(emptyUri.path).toBe("/snapshot");
    expect(emptyUri.query).not.toContain("/repo/added.txt");
    await expect(
      provider.provideTextDocumentContent(emptyUri, {} as never),
    ).resolves.toBe("");
    provider.dispose();
  });

  it("serves immutable regular-file snapshots with exact binary bytes", async () => {
    const repositoryDirectory = await mkdtemp(
      nodePath.join("/tmp", "gito-working-content-provider-"),
    );
    temporaryDirectories.push(repositoryDirectory);
    const filePath = nodePath.join(repositoryDirectory, "snapshot.bin");
    const originalBytes = Uint8Array.from([0, 1, 127, 128, 254, 255]);
    await writeFile(filePath, originalBytes);
    const provider = createDiffSymlinkUriProvider();

    const snapshotUri = await provider.workingContent(
      filePath,
      repositoryDirectory,
    );
    await writeFile(filePath, Uint8Array.from([9, 9, 9]));

    expect(snapshotUri.scheme).toBe("file");
    expect(provider.readSnapshotBytes(snapshotUri)).toEqual(originalBytes);
    await expect(provider.readFile(snapshotUri)).resolves.toEqual(
      originalBytes,
    );
    await expect(provider.stat(snapshotUri)).resolves.toEqual({
      type: 1,
      ctime: 0,
      mtime: 0,
      size: originalBytes.byteLength,
    });
    expect(() =>
      provider.writeFile(snapshotUri, originalBytes, {
        create: false,
        overwrite: false,
      }),
    ).toThrow("read-only");
    const nativeSnapshotPath = snapshotUri.fsPath;
    provider.dispose();
    await expect(stat(nativeSnapshotPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("requires the pinned repository root identity for snapshots", async () => {
    const repositoryDirectory = await mkdtemp(
      nodePath.join("/tmp", "gito-working-content-provider-identity-"),
    );
    temporaryDirectories.push(repositoryDirectory);
    const filePath = nodePath.join(repositoryDirectory, "snapshot.txt");
    await writeFile(filePath, "content\n");
    const provider = createDiffSymlinkUriProvider();

    await expect(
      provider.workingContent(filePath, repositoryDirectory, undefined, {
        canonicalPath: repositoryDirectory,
        device: 0n,
        inode: 0n,
      }),
    ).rejects.toBeInstanceOf(GitDiffRequestError);

    const canonicalRepositoryDirectory = await realpath(repositoryDirectory);
    const repositoryStats = await stat(canonicalRepositoryDirectory, {
      bigint: true,
    });
    const snapshotUri = await provider.workingContent(
      filePath,
      repositoryDirectory,
      undefined,
      {
        canonicalPath: canonicalRepositoryDirectory,
        device: repositoryStats.dev,
        inode: repositoryStats.ino,
      },
    );
    expect(provider.readSnapshotBytes(snapshotUri)).toEqual(
      Uint8Array.from(Buffer.from("content\n")),
    );
    provider.dispose();
  });

  it("cancels before reserving a snapshot registration", async () => {
    const repositoryDirectory = await mkdtemp(
      nodePath.join("/tmp", "gito-working-content-provider-cancel-"),
    );
    temporaryDirectories.push(repositoryDirectory);
    const filePath = nodePath.join(repositoryDirectory, "snapshot.txt");
    await writeFile(filePath, "content\n");
    const provider = createDiffSymlinkUriProvider({
      maxRegistrationsPerSession: 1,
    });
    const cancellationController = new AbortController();
    cancellationController.abort();

    await expect(
      provider.workingContent(
        filePath,
        repositoryDirectory,
        cancellationController.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      provider.workingContent(filePath, repositoryDirectory),
    ).resolves.toBeDefined();
    provider.dispose();
  });

  it("cancels after reading but before inserting a snapshot registration", async () => {
    const repositoryDirectory = await mkdtemp(
      nodePath.join("/tmp", "gito-working-content-provider-cancel-read-"),
    );
    temporaryDirectories.push(repositoryDirectory);
    const filePath = nodePath.join(repositoryDirectory, "snapshot.txt");
    await writeFile(filePath, "content\n");
    const provider = createDiffSymlinkUriProvider({
      maxRegistrationsPerSession: 1,
    });
    let cancellationChecks = 0;
    const cancellationSignal = {
      get aborted(): boolean {
        cancellationChecks += 1;
        return cancellationChecks >= 7;
      },
    } as AbortSignal;

    await expect(
      provider.workingContent(
        filePath,
        repositoryDirectory,
        cancellationSignal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      provider.workingContent(filePath, repositoryDirectory),
    ).resolves.toBeDefined();
    provider.dispose();
  });

  it("keeps one in-flight snapshot bound to its session across a new epoch", async () => {
    const repositoryDirectory = await mkdtemp(
      nodePath.join("/tmp", "gito-working-content-provider-session-"),
    );
    temporaryDirectories.push(repositoryDirectory);
    const filePath = nodePath.join(repositoryDirectory, "snapshot.txt");
    await writeFile(filePath, Buffer.alloc(256 * 1024, 0x61));
    const provider = createDiffSymlinkUriProvider({
      maxRegistrationsPerSession: 1,
      maxRetainedSessions: 2,
    });

    const snapshotPromise = provider.workingContent(
      filePath,
      repositoryDirectory,
    );
    provider.beginSession();
    const snapshotUri = await snapshotPromise;

    const snapshotContent = provider.readSnapshotBytes(snapshotUri);
    expect(snapshotContent.byteLength).toBe(256 * 1024);
    provider.dispose();
  });

  it("keeps snapshots safe after parent and leaf retargets", async () => {
    const repositoryDirectory = await mkdtemp(
      nodePath.join("/tmp", "gito-working-content-provider-retarget-"),
    );
    const replacementDirectory = await mkdtemp(
      nodePath.join("/tmp", "gito-working-content-provider-replacement-"),
    );
    temporaryDirectories.push(repositoryDirectory, replacementDirectory);
    const filePath = nodePath.join(repositoryDirectory, "snapshot.txt");
    await writeFile(filePath, "before\n");
    const provider = createDiffSymlinkUriProvider();
    const snapshotUri = await provider.workingContent(
      filePath,
      repositoryDirectory,
    );

    await rm(filePath);
    await writeFile(
      nodePath.join(replacementDirectory, "snapshot.txt"),
      "outside\n",
    );
    await symlink(
      nodePath.join(replacementDirectory, "snapshot.txt"),
      filePath,
    );

    expect(provider.readSnapshotBytes(snapshotUri)).toEqual(
      Uint8Array.from(Buffer.from("before\n")),
    );
    provider.dispose();
  });

  it("bounds snapshot registrations and clears them on disposal", async () => {
    const repositoryDirectory = await mkdtemp(
      nodePath.join("/tmp", "gito-working-content-provider-cap-"),
    );
    temporaryDirectories.push(repositoryDirectory);
    const filePath = nodePath.join(repositoryDirectory, "snapshot.txt");
    await writeFile(filePath, "content\n");
    const provider = createDiffSymlinkUriProvider({
      maxRegistrationsPerSession: 1,
      maxWorkingContentBytes: 4,
    });

    await expect(
      provider.workingContent(filePath, repositoryDirectory),
    ).rejects.toBeInstanceOf(GitDiffRequestError);
    provider.dispose();
  });

  it("enforces one byte budget across sessions and in-flight reads", async () => {
    const repositoryDirectory = await mkdtemp(
      nodePath.join("/tmp", "gito-working-content-provider-budget-"),
    );
    temporaryDirectories.push(repositoryDirectory);
    const firstFilePath = nodePath.join(repositoryDirectory, "first.txt");
    const secondFilePath = nodePath.join(repositoryDirectory, "second.txt");
    await writeFile(firstFilePath, "1234");
    await writeFile(secondFilePath, "5678");
    const provider = createDiffSymlinkUriProvider({
      maxRegistrationsPerSession: 2,
      maxRetainedSessions: 2,
      maxWorkingContentBytes: 8,
      maxTotalWorkingContentBytes: 8,
    });

    const firstSnapshotPromise = provider.workingContent(
      firstFilePath,
      repositoryDirectory,
    );
    await expect(
      provider.workingContent(secondFilePath, repositoryDirectory),
    ).rejects.toBeInstanceOf(GitDiffRequestError);
    const firstSnapshot = await firstSnapshotPromise;

    provider.beginSession();
    await expect(
      provider.workingContent(secondFilePath, repositoryDirectory),
    ).rejects.toBeInstanceOf(GitDiffRequestError);
    provider.beginSession();
    const secondSnapshot = await provider.workingContent(
      secondFilePath,
      repositoryDirectory,
    );
    expect(firstSnapshot.fsPath).not.toBe(secondSnapshot.fsPath);
    expect(() => provider.readSnapshotBytes(firstSnapshot)).toThrow(
      GitDiffRequestError,
    );
    provider.dispose();
  });

  it("rejects paths outside the registered repository root", async () => {
    const provider = createDiffSymlinkUriProvider();
    const unavailableUri = provider.symlink("/outside/link", "/repo");

    await expect(
      provider.provideTextDocumentContent(unavailableUri, {} as never),
    ).resolves.toBe("[symlink target unavailable]");
    provider.dispose();
  });

  it("rejects a link reached through a parent symlink outside the repository", async () => {
    const repositoryDirectory = await mkdtemp(
      nodePath.join("/tmp", "gito-symlink-provider-repository-"),
    );
    const outsideDirectory = await mkdtemp(
      nodePath.join("/tmp", "gito-symlink-provider-outside-"),
    );
    temporaryDirectories.push(repositoryDirectory, outsideDirectory);
    await mkdir(nodePath.join(outsideDirectory, "links"));
    const outsideLinkPath = nodePath.join(outsideDirectory, "links", "link");
    await symlink("target", outsideLinkPath);
    await symlink(
      nodePath.join(outsideDirectory, "links"),
      nodePath.join(repositoryDirectory, "links"),
    );
    const provider = createDiffSymlinkUriProvider();

    const unavailableUri = provider.symlink(
      nodePath.join(repositoryDirectory, "links", "link"),
      repositoryDirectory,
    );

    await expect(
      provider.provideTextDocumentContent(unavailableUri, {} as never),
    ).resolves.toBe("[symlink target unavailable]");
    provider.dispose();
  });

  it("rejects a link inode replaced during content read", async () => {
    const temporaryDirectory = await mkdtemp(
      nodePath.join("/tmp", "gito-symlink-provider-replacement-"),
    );
    temporaryDirectories.push(temporaryDirectory);
    await writeFile(nodePath.join(temporaryDirectory, "target"), "target\n");
    const linkPath = nodePath.join(temporaryDirectory, "link");
    await symlink("target", linkPath);
    const provider = createDiffSymlinkUriProvider();
    const linkUri = provider.symlink(linkPath, temporaryDirectory);

    const contentPromise = provider.provideTextDocumentContent(
      linkUri,
      {} as never,
    );
    unlinkSync(linkPath);
    symlinkSync("replacement-target", linkPath);

    await expect(contentPromise).resolves.toBe("[symlink target unavailable]");
    provider.dispose();
  });

  it("rejects a repository root inode replaced at the same canonical path", async () => {
    const temporaryDirectory = await mkdtemp(
      nodePath.join("/tmp", "gito-symlink-provider-root-replacement-"),
    );
    temporaryDirectories.push(temporaryDirectory);
    const repositoryDirectory = nodePath.join(temporaryDirectory, "repository");
    await mkdir(repositoryDirectory);
    await writeFile(nodePath.join(repositoryDirectory, "target"), "target\n");
    const linkPath = nodePath.join(repositoryDirectory, "link");
    await symlink("target", linkPath);
    const provider = createDiffSymlinkUriProvider();
    const linkUri = provider.symlink(linkPath, repositoryDirectory);
    const movedRepositoryDirectory = `${repositoryDirectory}-moved`;
    await rename(repositoryDirectory, movedRepositoryDirectory);
    await mkdir(repositoryDirectory);
    await writeFile(nodePath.join(repositoryDirectory, "target"), "new\n");
    await symlink("target", nodePath.join(repositoryDirectory, "link"));

    await expect(
      provider.provideTextDocumentContent(linkUri, {} as never),
    ).resolves.toBe("[symlink target unavailable]");
    provider.dispose();
  });
});
