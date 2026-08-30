import * as vscode from "vscode";
import { isAbsolute, relative } from "node:path";

import type { GitApi, GitRepository } from "./gitApi.ts";
import { isRepositoryInWorkspaceContext } from "./gitModel.ts";
import { canonicalizePath, pathsIdentifySameLocation } from "./pathIdentity.ts";

export class WorkspaceRepositories implements vscode.Disposable {
  private readonly changedEmitter = new vscode.EventEmitter<void>();
  private readonly gitApiSubscriptions: readonly vscode.Disposable[];
  private readonly repositorySubscriptions = new Map<GitRepository, vscode.Disposable>();
  private selectedRepositoryPath: string | undefined;

  public readonly onDidChange = this.changedEmitter.event;

  public constructor(private readonly gitApi: GitApi) {
    this.gitApiSubscriptions = [
      gitApi.onDidOpenRepository(() => this.synchronize()),
      gitApi.onDidCloseRepository(() => this.synchronize()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.synchronize()),
    ];
    this.synchronize(false);
  }

  public get repositories(): readonly GitRepository[] {
    const workspaceFolderPaths =
      vscode.workspace.workspaceFolders?.map((workspaceFolder) => workspaceFolder.uri.fsPath) ?? [];
    return this.gitApi.repositories.filter((repository) =>
      isRepositoryInWorkspaceContext(repository.rootUri.fsPath, workspaceFolderPaths),
    );
  }

  public get selectedRepository(): GitRepository | undefined {
    const workspaceRepositories = this.repositories;
    return (
      workspaceRepositories.find(
        (repository) =>
          this.selectedRepositoryPath !== undefined &&
          pathsIdentifySameLocation(repository.rootUri.fsPath, this.selectedRepositoryPath),
      ) ??
      workspaceRepositories.find((repository) => repository.ui.selected) ??
      workspaceRepositories[0]
    );
  }

  public findRepository(repositoryPath: string): GitRepository | undefined {
    return this.repositories.find((repository) =>
      pathsIdentifySameLocation(repository.rootUri.fsPath, repositoryPath),
    );
  }

  public findRepositoryContaining(filePath: string): GitRepository | undefined {
    return this.repositories
      .filter((repository) => {
        const relativeFilePath = relative(
          canonicalizePath(repository.rootUri.fsPath),
          canonicalizePath(filePath),
        );
        return relativeFilePath !== "" && !relativeFilePath.startsWith("..") && !isAbsolute(relativeFilePath);
      })
      .toSorted(
        (firstRepository, secondRepository) =>
          secondRepository.rootUri.fsPath.length - firstRepository.rootUri.fsPath.length,
      )[0];
  }

  public selectRepository(repositoryPath: string): void {
    if (
      (this.selectedRepositoryPath !== undefined &&
        pathsIdentifySameLocation(repositoryPath, this.selectedRepositoryPath)) ||
      !this.repositories.some((repository) =>
        pathsIdentifySameLocation(repository.rootUri.fsPath, repositoryPath),
      )
    ) {
      return;
    }
    this.selectedRepositoryPath = repositoryPath;
    this.changedEmitter.fire();
  }

  public dispose(): void {
    this.gitApiSubscriptions.forEach((gitApiSubscription) => gitApiSubscription.dispose());
    this.repositorySubscriptions.forEach((repositorySubscription) =>
      repositorySubscription.dispose(),
    );
    this.changedEmitter.dispose();
  }

  private synchronize(emitChange = true): void {
    const workspaceRepositories = new Set(this.repositories);
    if (
      this.selectedRepositoryPath !== undefined &&
      ![...workspaceRepositories].some(
        (repository) =>
          this.selectedRepositoryPath !== undefined &&
          pathsIdentifySameLocation(repository.rootUri.fsPath, this.selectedRepositoryPath),
      )
    ) {
      this.selectedRepositoryPath = undefined;
    }
    for (const [repository, repositorySubscription] of this.repositorySubscriptions) {
      if (!workspaceRepositories.has(repository)) {
        repositorySubscription.dispose();
        this.repositorySubscriptions.delete(repository);
      }
    }
    for (const repository of workspaceRepositories) {
      if (!this.repositorySubscriptions.has(repository)) {
        this.repositorySubscriptions.set(
          repository,
          vscode.Disposable.from(
            repository.state.onDidChange(() => this.changedEmitter.fire()),
            repository.ui.onDidChange(() => this.changedEmitter.fire()),
          ),
        );
      }
    }
    if (emitChange) {
      this.changedEmitter.fire();
    }
  }
}
