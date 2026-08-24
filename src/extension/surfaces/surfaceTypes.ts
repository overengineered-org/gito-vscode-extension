import * as vscode from "vscode";
import type { GitHistoryService } from "../git/gitHistoryService.js";
import type { GitWorktreeService } from "../git/gitWorktreeService.js";
import type { LocalGitRepositoryService } from "../git/localGitRepositoryService.js";
import type { RepositoryDiscovery } from "../repositories/repositoryDiscovery.js";
import type { RepositoryHomeFocusTarget } from "../../protocol/repositoryHomeProtocol.js";

/** Small seams keep native VS Code surfaces straightforward to unit test. */
export interface SurfaceCommandExecutor {
  executeCommand(
    commandIdentifier: string,
    ...argumentsPassed: readonly unknown[]
  ): Promise<unknown>;
}

export interface SurfaceCommandRegistry {
  registerCommand(
    commandIdentifier: string,
    handler: (...argumentsPassed: readonly unknown[]) => unknown,
  ): vscode.Disposable;
}

export interface GitoSurfaceServices {
  readonly repositoryService: LocalGitRepositoryService;
  readonly historyService: GitHistoryService;
  readonly worktreeService: GitWorktreeService;
  readonly repositoryDiscovery?: RepositoryDiscovery;
  readonly commandExecutor: SurfaceCommandExecutor;
  /** Opens Home and optionally focuses a typed destination. */
  readonly openHome?: (
    focusTarget?: RepositoryHomeFocusTarget,
  ) => Promise<void> | void;
}

export const surfaceCommandIds = {
  openChanges: "gito.openChanges",
  openPullRequests: "gito.openPullRequests",
  openCommits: "gito.openCommits",
  openBranches: "gito.openBranches",
  openWorktrees: "gito.openWorktrees",
} as const;
