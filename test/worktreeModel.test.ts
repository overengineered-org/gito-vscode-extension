import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  createPortableWorktreeDirectoryName,
  createRepositoryFamilyKey,
  createWorktreeCheckoutPath,
  formatWorktreeBranchName,
  selectRepositoryFamilyRepresentatives,
} from "../src/worktreeModel.ts";

const projectsRoot = resolve("fixtures", "projects");
const userHomePath = resolve("fixtures", "home");
const primaryWorktree = {
  detached: false,
  main: true,
  name: "repository",
  path: join(projectsRoot, "repository"),
  ref: "refs/heads/main",
};
const linkedWorktree = {
  detached: false,
  main: false,
  name: "feature-auth",
  path: join(projectsRoot, ".gito-worktrees", "repository", "Auth"),
  ref: "refs/heads/feat/auth",
};

test("stores linked worktrees outside the primary checkout by default", () => {
  assert.equal(
    createWorktreeCheckoutPath(
      linkedWorktree.path,
      [primaryWorktree, linkedWorktree],
      "",
      "Authentication redesign",
      userHomePath,
    ),
    join(projectsRoot, ".gito-worktrees", "repository", "Authentication-redesign"),
  );
});

test("supports a global storage root without mixing repositories", () => {
  assert.equal(
    createWorktreeCheckoutPath(
      primaryWorktree.path,
      [primaryWorktree],
      "~/Worktrees",
      "Release 2.0",
      userHomePath,
    ),
    join(userHomePath, "Worktrees", "repository", "Release-2.0"),
  );
  assert.throws(
    () =>
      createWorktreeCheckoutPath(
        primaryWorktree.path,
        [primaryWorktree],
        "relative/worktrees",
        "Feature",
        userHomePath,
      ),
    /absolute path or start with '~'/u,
  );
});

test("creates portable readable directory names from display labels", () => {
  assert.equal(createPortableWorktreeDirectoryName("  Payments / API: retry?  "), "Payments-API-retry");
  assert.equal(createPortableWorktreeDirectoryName("..."), "worktree");
  assert.equal(createPortableWorktreeDirectoryName("équipe mobile"), "e-quipe-mobile");
  assert.equal([...createPortableWorktreeDirectoryName("𐐀".repeat(81))].length, 80);
});

test("groups every open checkout under one selected repository family", () => {
  assert.equal(
    createRepositoryFamilyKey(linkedWorktree.path, [primaryWorktree, linkedWorktree]),
    primaryWorktree.path,
  );
  assert.deepEqual(
    selectRepositoryFamilyRepresentatives(
      [
        { repositoryPath: primaryWorktree.path, worktrees: [primaryWorktree, linkedWorktree] },
        { repositoryPath: linkedWorktree.path, worktrees: [primaryWorktree, linkedWorktree] },
        {
          repositoryPath: join(projectsRoot, "other"),
          worktrees: [
            {
              detached: false,
              main: true,
              name: "other",
              path: join(projectsRoot, "other"),
              ref: "refs/heads/main",
            },
          ],
        },
      ],
      linkedWorktree.path,
    ),
    [linkedWorktree.path, join(projectsRoot, "other")],
  );
});

test("shows branch and detached worktree state explicitly", () => {
  assert.equal(formatWorktreeBranchName(linkedWorktree), "feat/auth");
  assert.equal(
    formatWorktreeBranchName({ ...linkedWorktree, detached: true, ref: "" }),
    "Detached HEAD",
  );
});
