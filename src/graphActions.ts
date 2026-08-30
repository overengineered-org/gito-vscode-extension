import * as vscode from "vscode";

import type { GitApi, GitRepository } from "./gitApi.ts";
import { runGitCommand, type GitCommandContext } from "./gitCommand.ts";
import {
  type CommitGraphActionId,
  type CommitGraphActionState,
  createCommitGraphActionStates,
} from "./graphActionModel.ts";
import { countRepositoryChanges } from "./gitModel.ts";

export class GraphActions {
  public constructor(
    private readonly gitApi: GitApi,
    private readonly diagnostics: vscode.LogOutputChannel,
  ) {}

  public actionStates(
    repository: GitRepository,
    commitHash: string,
  ): readonly CommitGraphActionState[] {
    return createCommitGraphActionStates({
      commitIsHead: repository.state.HEAD?.commit === commitHash,
      gitOperationInProgress:
        repository.state.rebaseCommit !== undefined || repository.state.mergeChanges.length > 0,
      workingTreeClean: countRepositoryChanges(repository.state) === 0,
    });
  }

  public async run(
    actionId: CommitGraphActionId,
    repository: GitRepository,
    commitHash: string,
  ): Promise<string | undefined> {
    await repository.status();
    const currentActionState = this.actionStates(repository, commitHash).find(
      (actionState) => actionState.id === actionId,
    );
    if (currentActionState?.disabledReason !== undefined) {
      throw new Error(currentActionState.disabledReason);
    }
    switch (actionId) {
      case "openCommit":
        await vscode.commands.executeCommand("git.viewCommit", repository.rootUri, commitHash);
        return undefined;
      case "compareWithHead":
        throw new Error("Comparison actions are handled by the graph preview.");
      case "copyHash":
        await vscode.env.clipboard.writeText(commitHash);
        return "Full commit hash copied.";
      case "createBranch":
        return this.createBranchAtCommit(repository, commitHash);
      case "createTag":
        return this.createTagAtCommit(repository, commitHash);
      case "checkoutDetached":
        return this.checkoutCommit(repository, commitHash);
      case "cherryPick":
        return this.runCommitOperation(
          repository,
          commitHash,
          "cherry-pick",
          "Apply Commit",
          "Apply this commit to the current branch?",
          "This creates a new commit. Existing commits are not changed.",
          "Commit applied to the current branch.",
        );
      case "rebaseCurrentBranchOnto":
        return this.runConfirmedGitOperation(
          repository,
          commitHash,
          "Move Current Branch",
          "Move the current branch onto this commit?",
          "This rewrites current-branch commits. Push may require force-with-lease.",
          ["rebase", commitHash],
          "Current branch moved onto the selected commit.",
        );
      case "revertCommit":
        return this.runCommitOperation(
          repository,
          commitHash,
          "revert",
          "Create Reverting Commit",
          "Create a commit that reverses this commit?",
          "The selected commit remains in history.",
          "Reverting commit created.",
        );
      case "undoLastCommit":
        return this.undoLastCommit(repository);
    }
  }

  private async createBranchAtCommit(
    repository: GitRepository,
    commitHash: string,
  ): Promise<string | undefined> {
    const branchName = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      placeHolder: "feat/my-feature",
      prompt: `Create a local branch at ${commitHash.slice(0, 8)}.`,
      title: "Git'o: Create Branch Here",
      validateInput: (candidateBranchName) =>
        candidateBranchName.trim() === "" ? "Enter a branch name." : undefined,
    });
    if (branchName === undefined) {
      return undefined;
    }
    await repository.createBranch(branchName.trim(), false, commitHash);
    await repository.status();
    return `Branch '${branchName.trim()}' created.`;
  }

  private async createTagAtCommit(
    repository: GitRepository,
    commitHash: string,
  ): Promise<string | undefined> {
    const tagName = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      placeHolder: "v1.2.0",
      prompt: `Create a local tag at ${commitHash.slice(0, 8)}. It is not pushed automatically.`,
      title: "Git'o: Create Local Tag Here",
      validateInput: (candidateTagName) =>
        candidateTagName.trim() === "" ? "Enter a tag name." : undefined,
    });
    if (tagName === undefined) {
      return undefined;
    }
    const trimmedTagName = tagName.trim();
    await repository.tag(trimmedTagName, "", commitHash);
    await repository.status();
    return `Local tag '${trimmedTagName}' created.`;
  }

  private async checkoutCommit(
    repository: GitRepository,
    commitHash: string,
  ): Promise<string | undefined> {
    if (
      (await vscode.window.showWarningMessage(
        `Inspect ${commitHash.slice(0, 8)} in detached HEAD?`,
        { modal: true, detail: "No branch moves. Create or switch to a branch when finished." },
        "Inspect Commit",
      )) !== "Inspect Commit"
    ) {
      return undefined;
    }
    await repository.checkout(commitHash);
    await repository.status();
    return `Checked out ${commitHash.slice(0, 8)} in detached HEAD.`;
  }

  private async undoLastCommit(repository: GitRepository): Promise<string | undefined> {
    if (
      (await vscode.window.showWarningMessage(
        "Undo the last commit and keep its changes staged?",
        { modal: true, detail: "The commit is removed locally. Files and staged changes are kept." },
        "Undo Last Commit",
      )) !== "Undo Last Commit"
    ) {
      return undefined;
    }
    await vscode.commands.executeCommand("git.undoCommit", repository.rootUri);
    await repository.status();
    return "Last commit undone; its changes remain staged.";
  }

  private async runCommitOperation(
    repository: GitRepository,
    commitHash: string,
    gitOperation: "cherry-pick" | "revert",
    confirmationLabel: string,
    confirmationMessage: string,
    confirmationDetail: string,
    completionMessage: string,
  ): Promise<string | undefined> {
    const selectedCommit = await repository.getCommit(commitHash);
    const mainlineParentNumber = selectedCommit.parents.length > 1
      ? await this.selectMainlineParent(selectedCommit.parents, gitOperation)
      : undefined;
    if (selectedCommit.parents.length > 1 && mainlineParentNumber === undefined) {
      return undefined;
    }
    const gitArguments: string[] = [gitOperation];
    if (mainlineParentNumber !== undefined) {
      gitArguments.push("--mainline", String(mainlineParentNumber));
    }
    if (gitOperation === "revert") {
      gitArguments.push("--no-edit");
    }
    gitArguments.push(commitHash);
    return this.runConfirmedGitOperation(
      repository,
      commitHash,
      confirmationLabel,
      confirmationMessage,
      confirmationDetail,
      gitArguments,
      completionMessage,
    );
  }

  private async selectMainlineParent(
    parentCommitHashes: readonly string[],
    gitOperation: "cherry-pick" | "revert",
  ): Promise<number | undefined> {
    const selectedParent = await vscode.window.showQuickPick(
      parentCommitHashes.map((parentCommitHash, parentIndex) => ({
        description: parentCommitHash.slice(0, 8),
        detail:
          parentIndex === 0
            ? "Usually the branch this merge was made on"
            : "Usually a branch merged into the first parent",
        label: `Parent ${parentIndex + 1}`,
        parentNumber: parentIndex + 1,
      })),
      {
        ignoreFocusOut: true,
        placeHolder: "Choose the history this merge should be compared against",
        title:
          gitOperation === "revert"
            ? "Git'o: Revert Merge Commit"
            : "Git'o: Apply Merge Commit",
      },
    );
    return selectedParent?.parentNumber;
  }

  private async runConfirmedGitOperation(
    repository: GitRepository,
    commitHash: string,
    confirmationLabel: string,
    confirmationMessage: string,
    confirmationDetail: string,
    gitArguments: readonly string[],
    completionMessage: string,
  ): Promise<string | undefined> {
    if (
      (await vscode.window.showWarningMessage(
        `${confirmationMessage} (${commitHash.slice(0, 8)})`,
        { modal: true, detail: confirmationDetail },
        confirmationLabel,
      )) !== confirmationLabel
    ) {
      return undefined;
    }
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Git'o: ${confirmationLabel}`,
        },
        () => runGitCommand(this.gitCommandContext(repository), gitArguments, 120_000),
      );
      await repository.status();
      return completionMessage;
    } catch (gitOperationFailure) {
      this.diagnostics.error(`${confirmationLabel} failed.`, gitOperationFailure);
      try {
        await repository.status();
      } catch (repositoryRefreshFailure) {
        this.diagnostics.warn("Repository refresh after failed graph action failed.", repositoryRefreshFailure);
      }
      throw gitOperationFailure;
    }
  }

  private gitCommandContext(repository: GitRepository): GitCommandContext {
    return {
      environment: this.gitApi.git.env,
      executablePath: this.gitApi.git.path,
      repositoryPath: repository.rootUri.fsPath,
    };
  }
}
