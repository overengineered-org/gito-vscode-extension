import * as vscode from "vscode";
import { BranchesSurface } from "./branchesSurface.js";
import { ChangesSurface } from "./changesSurface.js";
import { CommitsSurface } from "./commitsSurface.js";
import { PullRequestsSurface } from "./pullRequestsSurface.js";
import { reportSurfaceError, runSurfaceCommand } from "./surfaceUtilities.js";
import type {
  GitoSurfaceServices,
  SurfaceCommandRegistry,
} from "./surfaceTypes.js";
import { surfaceCommandIds } from "./surfaceTypes.js";
import { WorktreesSurface } from "./worktreesSurface.js";

/** Composition root for the native sidebar surfaces. */
export class GitoSurfaceHost {
  public readonly changesSurface: ChangesSurface;
  public readonly pullRequestsSurface: PullRequestsSurface;
  public readonly commitsSurface: CommitsSurface;
  public readonly branchesSurface: BranchesSurface;
  public readonly worktreesSurface: WorktreesSurface;

  public constructor(services: GitoSurfaceServices) {
    this.changesSurface = new ChangesSurface(services);
    this.pullRequestsSurface = new PullRequestsSurface(services);
    this.commitsSurface = new CommitsSurface(services);
    this.branchesSurface = new BranchesSurface(services);
    this.worktreesSurface = new WorktreesSurface(services);
  }

  public registerCommands(
    commandRegistry: SurfaceCommandRegistry = vscode.commands,
  ): readonly vscode.Disposable[] {
    return [
      this.registerSurfaceCommand(
        commandRegistry,
        surfaceCommandIds.openChanges,
        () => this.changesSurface.open(),
      ),
      this.registerSurfaceCommand(
        commandRegistry,
        surfaceCommandIds.openPullRequests,
        () => this.pullRequestsSurface.open(),
      ),
      this.registerSurfaceCommand(
        commandRegistry,
        surfaceCommandIds.openCommits,
        () => this.commitsSurface.open(),
      ),
      this.registerSurfaceCommand(
        commandRegistry,
        surfaceCommandIds.openBranches,
        () => this.branchesSurface.open(),
      ),
      this.registerSurfaceCommand(
        commandRegistry,
        surfaceCommandIds.openWorktrees,
        () => this.worktreesSurface.open(),
      ),
    ];
  }

  private registerSurfaceCommand(
    commandRegistry: SurfaceCommandRegistry,
    commandIdentifier: string,
    operation: () => Promise<void>,
  ): vscode.Disposable {
    return commandRegistry.registerCommand(commandIdentifier, () =>
      runSurfaceCommand(operation),
    );
  }
}

export { reportSurfaceError };
