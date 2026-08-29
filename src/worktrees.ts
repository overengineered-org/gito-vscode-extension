import { homedir } from "node:os";

import * as vscode from "vscode";

import type { GitRepository, GitWorktree } from "./gitApi.ts";
import { createWorktreeCheckoutPath } from "./worktreeModel.ts";

const worktreeLabelsStorageKey = "gito.worktreeLabels";

interface WorktreeLabels {
  readonly [worktreePath: string]: string;
}

export class Worktrees implements vscode.Disposable {
  private readonly changedEmitter = new vscode.EventEmitter<void>();

  public readonly onDidChange = this.changedEmitter.event;

  public constructor(
    private readonly globalState: vscode.Memento,
    private readonly diagnostics: vscode.LogOutputChannel,
  ) {}

  public dispose(): void {
    this.changedEmitter.dispose();
  }

  public getDisplayName(worktree: GitWorktree): string {
    return (
      this.globalState.get<WorktreeLabels>(worktreeLabelsStorageKey, {})[worktree.path] ??
      worktree.name
    );
  }

  public async promptToCreateFeatureWorktree(repository: GitRepository): Promise<void> {
    const branchName = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      placeHolder: "feat/my-feature",
      prompt: "New branch created from the current HEAD",
      title: "Git'o: Create Feature Worktree",
      validateInput: (candidateBranchName) =>
        candidateBranchName.trim() === "" ? "Enter a branch name." : undefined,
    });
    if (branchName === undefined) {
      return;
    }
    const defaultDisplayName = branchName.split("/").filter(Boolean).at(-1) ?? branchName;
    const displayName = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      prompt: "Local label shown in Git'o. It can differ from the branch name.",
      title: "Git'o: Name Worktree",
      value: defaultDisplayName,
      validateInput: (candidateDisplayName) =>
        candidateDisplayName.trim() === "" ? "Enter a worktree name." : undefined,
    });
    if (displayName === undefined) {
      return;
    }
    const createdWorktreePath = await this.createFeatureWorktree(repository, {
      branchName: branchName.trim(),
      displayName: displayName.trim(),
    });
    if (createdWorktreePath === undefined) {
      return;
    }
    const openWorktreeChoice = "Open in New Window";
    if (
      (await vscode.window.showInformationMessage(
        `Git'o created '${displayName.trim()}'.`,
        openWorktreeChoice,
      )) === openWorktreeChoice
    ) {
      await this.openWorktree(createdWorktreePath, true);
    }
  }

  public async createFeatureWorktree(
    repository: GitRepository,
    featureWorktree: { readonly branchName: string; readonly displayName: string },
  ): Promise<string | undefined> {
    const branchName = featureWorktree.branchName.trim();
    const displayName = featureWorktree.displayName.trim();
    if (branchName === "" || displayName === "") {
      void vscode.window.showErrorMessage("Git'o needs both a branch name and worktree name.");
      return undefined;
    }
    const currentCommitish = repository.state.HEAD?.name ?? "HEAD";
    const configuredStorageRoot = vscode.workspace
      .getConfiguration("gito.worktrees")
      .get("storageRoot", "");
    let worktreePath: string;
    try {
      worktreePath = createWorktreeCheckoutPath(
        repository.rootUri.fsPath,
        repository.state.worktrees,
        configuredStorageRoot,
        displayName,
        homedir(),
      );
    } catch (invalidStorageConfiguration) {
      const storageConfigurationMessage =
        invalidStorageConfiguration instanceof Error
          ? invalidStorageConfiguration.message
          : "Git'o worktree storage is invalid.";
      void vscode.window.showErrorMessage(storageConfigurationMessage);
      return undefined;
    }
    try {
      const createdWorktreePath = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Creating worktree '${displayName}'…`,
        },
        () =>
          repository.createWorktree({
            branch: branchName,
            commitish: currentCommitish,
            path: worktreePath,
          }),
      );
      await this.setDisplayName(createdWorktreePath, displayName);
      return createdWorktreePath;
    } catch (worktreeCreationFailure) {
      this.diagnostics.error("Worktree creation failed.", worktreeCreationFailure);
      void vscode.window.showErrorMessage(
        `Git'o could not create '${displayName}'. Check the Git output, branch name, and destination path.`,
      );
      return undefined;
    }
  }

  public async promptToRenameWorktree(worktree: GitWorktree): Promise<void> {
    const displayName = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      prompt: "This changes only Git'o's local label, not the branch or folder.",
      title: "Git'o: Rename Worktree Label",
      value: this.getDisplayName(worktree),
      validateInput: (candidateDisplayName) =>
        candidateDisplayName.trim() === "" ? "Enter a worktree name." : undefined,
    });
    if (displayName !== undefined) {
      await this.setDisplayName(worktree.path, displayName.trim());
    }
  }

  public async setDisplayName(worktreePath: string, displayName: string): Promise<void> {
    const trimmedDisplayName = displayName.trim();
    if (trimmedDisplayName === "") {
      throw new Error("Git'o worktree names cannot be empty.");
    }
    const worktreeLabels = this.globalState.get<WorktreeLabels>(worktreeLabelsStorageKey, {});
    await this.globalState.update(worktreeLabelsStorageKey, {
      ...worktreeLabels,
      [worktreePath]: trimmedDisplayName,
    });
    this.changedEmitter.fire();
  }

  public async openWorktree(worktreePath: string, openInNewWindow: boolean): Promise<void> {
    await vscode.commands.executeCommand(
      "vscode.openFolder",
      vscode.Uri.file(worktreePath),
      openInNewWindow,
    );
  }
}
