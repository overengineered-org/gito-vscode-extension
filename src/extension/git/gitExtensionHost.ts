import * as vscode from "vscode";
import {
  registerLocalGitCommands,
  type LocalGitCommandRegistry,
} from "../commands/localGitCommands.js";
import { RepositoryDiscovery } from "../repositories/repositoryDiscovery.js";
import { NodeGitCommandRunner } from "./gitCommandRunner.js";
import { GitHistoryService } from "./gitHistoryService.js";
import { GitRootBindingResolver } from "./gitRootBindingResolver.js";
import {
  GitWorktreeService,
  resolveBundledGitExecutablePath,
} from "./gitWorktreeService.js";
import { LocalGitRepositoryService } from "./localGitRepositoryService.js";
import type { WorkspaceTrustGuard } from "../security/workspaceTrustGuard.js";

/** Composition root for the local Git lane. */
export class LocalGitExtensionHost {
  public readonly repositoryDiscovery: RepositoryDiscovery;
  public readonly gitExecutablePathResolver = resolveBundledGitExecutablePath;
  public readonly gitRootBindingResolver: GitRootBindingResolver;
  public readonly gitCommandRunner: NodeGitCommandRunner;
  public readonly repositoryService: LocalGitRepositoryService;
  public readonly historyService: GitHistoryService;
  public readonly worktreeService: GitWorktreeService;

  public constructor(
    private readonly workspaceTrustGuard: Pick<
      WorkspaceTrustGuard,
      "isWorkspaceTrusted" | "assertTrusted"
    >,
  ) {
    this.repositoryDiscovery = new RepositoryDiscovery();
    this.gitRootBindingResolver = new GitRootBindingResolver(
      this.gitExecutablePathResolver,
    );
    this.gitCommandRunner = new NodeGitCommandRunner({
      gitExecutablePathResolver: this.gitExecutablePathResolver,
    });
    this.repositoryService = new LocalGitRepositoryService(
      this.repositoryDiscovery,
      this.workspaceTrustGuard,
      undefined,
      undefined,
      this.gitRootBindingResolver.resolve.bind(this.gitRootBindingResolver),
    );
    this.historyService = new GitHistoryService(
      this.gitCommandRunner,
      this.gitRootBindingResolver,
    );
    this.worktreeService = new GitWorktreeService(
      this.gitCommandRunner,
      this.workspaceTrustGuard,
      undefined,
      undefined,
      this.repositoryDiscovery,
      undefined,
      undefined,
      this.gitExecutablePathResolver,
    );
  }

  public dispose(): void {
    this.repositoryDiscovery.dispose();
  }

  public registerCommands(
    commandRegistry: LocalGitCommandRegistry = vscode.commands,
  ): readonly vscode.Disposable[] {
    return registerLocalGitCommands(commandRegistry, {
      repositoryService: this.repositoryService,
      historyService: this.historyService,
      worktreeService: this.worktreeService,
      smartCommitEnabled: () =>
        vscode.workspace
          .getConfiguration("gito")
          .get<boolean>("smartCommit", false),
    });
  }
}
