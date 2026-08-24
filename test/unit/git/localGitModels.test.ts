import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import {
  createLocalGitChange,
  createRepositoryRelativePathResolver,
  getGitStatusLabel,
  normalizeVscodeGitBranch,
  Status,
  toRepositoryRelativePath,
} from "../../../src/extension/git/localGitModels.js";

describe("local Git models", () => {
  it("groups API resource state and derives repository-relative paths", () => {
    withTemporaryRepository((repositoryPath) => {
      const repositoryRoot = createUri(repositoryPath);
      const resourceUri = createUri(join(repositoryPath, "src", "app.ts"));
      expect(
        createLocalGitChange(repositoryRoot, "stagedChanges", {
          uri: resourceUri,
          originalUri: resourceUri,
          renameUri: undefined,
          status: 1,
        }),
      ).toMatchObject({
        group: "stagedChanges",
        relativePath: "src/app.ts",
        statusLabel: "Added",
      });
      expect(toRepositoryRelativePath(repositoryRoot, resourceUri)).toBe(
        "src/app.ts",
      );
    });
  });

  it("normalizes local and remote branch records", () => {
    expect(
      normalizeVscodeGitBranch(
        {
          name: "main",
          type: 0,
          commit: "abc123",
          upstream: { name: "origin/main", remote: "origin" },
          ahead: 1,
          behind: 2,
        },
        "main",
      ),
    ).toEqual({
      name: "main",
      isRemote: false,
      isCurrent: true,
      upstreamBranchName: "origin/main",
      upstreamRemoteName: "origin",
      aheadCount: 1,
      behindCount: 2,
      lastCommit: "abc123",
    });
  });

  it("uses official status values for ignored and untracked labels", () => {
    expect(getGitStatusLabel("untracked", Status.UNTRACKED)).toBe("Untracked");
    expect(getGitStatusLabel("untracked", Status.IGNORED)).toBe("Ignored");
  });

  it("matches the complete zero-based vscode.git Status enum", () => {
    expect({
      INDEX_MODIFIED: Status.INDEX_MODIFIED,
      INDEX_ADDED: Status.INDEX_ADDED,
      INDEX_DELETED: Status.INDEX_DELETED,
      INDEX_RENAMED: Status.INDEX_RENAMED,
      INDEX_COPIED: Status.INDEX_COPIED,
      MODIFIED: Status.MODIFIED,
      DELETED: Status.DELETED,
      UNTRACKED: Status.UNTRACKED,
      IGNORED: Status.IGNORED,
      INTENT_TO_ADD: Status.INTENT_TO_ADD,
      INTENT_TO_RENAME: Status.INTENT_TO_RENAME,
      TYPE_CHANGED: Status.TYPE_CHANGED,
      ADDED_BY_US: Status.ADDED_BY_US,
      ADDED_BY_THEM: Status.ADDED_BY_THEM,
      DELETED_BY_US: Status.DELETED_BY_US,
      DELETED_BY_THEM: Status.DELETED_BY_THEM,
      BOTH_ADDED: Status.BOTH_ADDED,
      BOTH_DELETED: Status.BOTH_DELETED,
      BOTH_MODIFIED: Status.BOTH_MODIFIED,
    }).toEqual({
      INDEX_MODIFIED: 0,
      INDEX_ADDED: 1,
      INDEX_DELETED: 2,
      INDEX_RENAMED: 3,
      INDEX_COPIED: 4,
      MODIFIED: 5,
      DELETED: 6,
      UNTRACKED: 7,
      IGNORED: 8,
      INTENT_TO_ADD: 9,
      INTENT_TO_RENAME: 10,
      TYPE_CHANGED: 11,
      ADDED_BY_US: 12,
      ADDED_BY_THEM: 13,
      DELETED_BY_US: 14,
      DELETED_BY_THEM: 15,
      BOTH_ADDED: 16,
      BOTH_DELETED: 17,
      BOTH_MODIFIED: 18,
    });
  });

  it("rejects resource paths outside the repository", () => {
    withTemporaryRepository((repositoryPath) => {
      expect(() =>
        toRepositoryRelativePath(
          createUri(repositoryPath),
          createUri(join(repositoryPath, "..", "other", ".env")),
        ),
      ).toThrow("outside the selected repository");
    });
  });

  it("resolves a filesystem alias without changing the repository-relative path", () => {
    withTemporaryRepository((repositoryPath, fixturePath) => {
      const canonicalParentPath = join(fixturePath, "private-var");
      const aliasedParentPath = join(fixturePath, "var");
      mkdirSync(canonicalParentPath);
      symlinkSync(canonicalParentPath, aliasedParentPath, "dir");
      const canonicalRepositoryPath = join(canonicalParentPath, "repository");
      mkdirSync(canonicalRepositoryPath);
      const aliasedResourcePath = join(
        aliasedParentPath,
        "repository",
        "change.txt",
      );

      expect(
        toRepositoryRelativePath(
          createUri(canonicalRepositoryPath),
          createUri(aliasedResourcePath),
        ),
      ).toBe("change.txt");
    });
  });

  it("preserves a tracked symlink leaf as a repository-relative path", () => {
    withTemporaryRepository((repositoryPath, fixturePath) => {
      const outsideTargetPath = join(fixturePath, "outside-target.txt");
      const symlinkLeafPath = join(repositoryPath, "tracked-link.txt");
      symlinkSync(outsideTargetPath, symlinkLeafPath);

      expect(
        toRepositoryRelativePath(
          createUri(repositoryPath),
          createUri(symlinkLeafPath),
        ),
      ).toBe("tracked-link.txt");
    });
  });

  it("rejects a resource through a symlinked parent outside the repository", () => {
    withTemporaryRepository((repositoryPath, fixturePath) => {
      const outsideDirectoryPath = join(fixturePath, "outside");
      const symlinkedParentPath = join(repositoryPath, "linked-parent");
      mkdirSync(outsideDirectoryPath);
      symlinkSync(outsideDirectoryPath, symlinkedParentPath, "dir");

      expect(() =>
        toRepositoryRelativePath(
          createUri(repositoryPath),
          createUri(join(symlinkedParentPath, "deleted.txt")),
        ),
      ).toThrow("outside the selected repository");
    });
  });

  it("rejects a resource through a dangling symlinked parent", () => {
    withTemporaryRepository((repositoryPath, fixturePath) => {
      const danglingParentPath = join(repositoryPath, "dangling-parent");
      symlinkSync(join(fixturePath, "missing-outside"), danglingParentPath);

      expect(() =>
        toRepositoryRelativePath(
          createUri(repositoryPath),
          createUri(join(danglingParentPath, "deleted.txt")),
        ),
      ).toThrow();
    });
  });

  it("rejects resource URIs with incompatible scheme or authority", () => {
    withTemporaryRepository((repositoryPath) => {
      expect(() =>
        toRepositoryRelativePath(
          createUri(repositoryPath),
          createUri(join(repositoryPath, "file.txt"), "vscode-remote", "host"),
        ),
      ).toThrow("incompatible URI");
    });
  });

  it("retains deleted nested paths after safely resolving their existing ancestor", () => {
    withTemporaryRepository((repositoryPath) => {
      const nestedDirectoryPath = join(repositoryPath, "nested");
      mkdirSync(nestedDirectoryPath);

      expect(
        toRepositoryRelativePath(
          createUri(repositoryPath),
          createUri(join(nestedDirectoryPath, "deleted", "file.txt")),
        ),
      ).toBe("nested/deleted/file.txt");
    });
  });

  it("caches repeated parent canonicalization within one resolver", () => {
    withTemporaryRepository((repositoryPath) => {
      const nestedDirectoryPath = join(repositoryPath, "nested");
      mkdirSync(nestedDirectoryPath);
      const realpathNativeSpy = vi.spyOn(nodeFs.realpathSync, "native");
      try {
        const resolver = createRepositoryRelativePathResolver(
          createUri(repositoryPath),
        );
        expect(
          resolver.resolve(createUri(join(nestedDirectoryPath, "first.txt"))),
        ).toBe("nested/first.txt");
        expect(
          resolver.resolve(createUri(join(nestedDirectoryPath, "second.txt"))),
        ).toBe("nested/second.txt");
        expect(realpathNativeSpy).toHaveBeenCalledTimes(2);
      } finally {
        realpathNativeSpy.mockRestore();
      }
    });
  });

  it("classifies remote refs by RefType, not by their name", () => {
    expect(
      normalizeVscodeGitBranch(
        { name: "origin/local-looking", type: 0 },
        "origin/local-looking",
      ).isRemote,
    ).toBe(false);
  });

  it("changes identity when a tracked file becomes untracked", () => {
    withTemporaryRepository((repositoryPath) => {
      const repositoryRoot = createUri(repositoryPath);
      const resourceUri = createUri(join(repositoryPath, ".env"));
      const trackedChange = createLocalGitChange(repositoryRoot, "changes", {
        uri: resourceUri,
        originalUri: resourceUri,
        renameUri: undefined,
        status: 6,
      });
      const untrackedChange = createLocalGitChange(
        repositoryRoot,
        "untracked",
        {
          uri: resourceUri,
          originalUri: resourceUri,
          renameUri: undefined,
          status: 8,
        },
      );
      expect(untrackedChange.changeId).not.toBe(trackedChange.changeId);
    });
  });
});

function withTemporaryRepository(
  testBody: (repositoryPath: string, fixturePath: string) => void,
): void {
  const fixturePath = mkdtempSync(join(tmpdir(), "gito-local-git-models-"));
  const repositoryPath = join(fixturePath, "repository");
  mkdirSync(repositoryPath);
  try {
    testBody(repositoryPath, fixturePath);
  } finally {
    rmSync(fixturePath, { force: true, recursive: true });
  }
}

function createUri(
  filePath: string,
  scheme = "file",
  authority = "",
): vscode.Uri {
  return {
    fsPath: filePath,
    path: filePath,
    scheme,
    authority,
    toString: () => `${scheme}://${authority}${filePath}`,
  } as vscode.Uri;
}
