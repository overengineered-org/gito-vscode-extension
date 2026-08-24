import { realpath, stat } from "node:fs/promises";
import { GitRootBindingResolver } from "../../../src/extension/git/gitRootBindingResolver.js";
import type { GitRootBindingIdentity } from "../../../src/extension/git/gitCommandRunner.js";

/** Test-only resolver: validates filesystem swaps without requiring a Git repo. */
export function createHistoryRootBindingResolver(): GitRootBindingResolver {
  return new GitRootBindingResolver(() => Promise.resolve("/usr/bin/git"), {
    resolveRootBinding: async (
      repositoryRoot,
      expectedIdentity,
    ): Promise<GitRootBindingIdentity> => {
      const canonicalPath = await realpath(repositoryRoot);
      const rootStats = await stat(canonicalPath, { bigint: true });
      const directoryIdentity = {
        canonicalPath,
        device: rootStats.dev.toString(),
        inode: rootStats.ino.toString(),
      };
      const identity = {
        ...directoryIdentity,
        gitDirectory: directoryIdentity,
        commonDirectory: directoryIdentity,
      } satisfies GitRootBindingIdentity;
      if (
        expectedIdentity !== undefined &&
        (expectedIdentity.canonicalPath !== identity.canonicalPath ||
          expectedIdentity.device !== identity.device ||
          expectedIdentity.inode !== identity.inode)
      ) {
        throw new Error("Test root binding changed.");
      }
      return identity;
    },
  });
}

export function createRealHistoryRootBindingResolver(): GitRootBindingResolver {
  return new GitRootBindingResolver(() => Promise.resolve("/usr/bin/git"));
}
