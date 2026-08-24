import * as vscode from "vscode";
import { localGitCommandIds } from "../commands/localGitCommands.js";
import type { LocalGitBranch } from "../git/localGitModels.js";
import type { VscodeGitRepository } from "../git/vscodeGitApi.js";
import {
  executeSurfaceCommand,
  formatCount,
  withSurfaceProgress,
} from "./surfaceUtilities.js";
import type { GitoSurfaceServices } from "./surfaceTypes.js";

type BranchAction =
  "create" | "refresh" | "checkout" | "publish" | "delete" | "forceDelete";

interface BranchSelectionContext {
  readonly selectedRepositoryRoot: vscode.Uri;
  readonly expectedRepository?: VscodeGitRepository;
}

interface BranchQuickPickItem extends vscode.QuickPickItem {
  readonly branch?: LocalGitBranch;
  readonly action?: BranchAction;
}

/** Grouped branch browser using LocalGitRepositoryService for all mutations. */
export class BranchesSurface {
  public constructor(private readonly services: GitoSurfaceServices) {}

  public async open(): Promise<void> {
    const repositoryServiceWithSelection = this.services
      .repositoryService as unknown as {
      readonly getRepositoryRoot: () => Promise<vscode.Uri>;
      readonly getRepositorySelectionContext?: () => Promise<BranchSelectionContext>;
    };
    const selectionContext =
      typeof repositoryServiceWithSelection.getRepositorySelectionContext ===
      "function"
        ? await repositoryServiceWithSelection.getRepositorySelectionContext()
        : {
            selectedRepositoryRoot:
              await repositoryServiceWithSelection.getRepositoryRoot(),
          };
    const branches = await withSurfaceProgress("Git'o: Loading branches", () =>
      this.services.repositoryService.listBranches(selectionContext),
    );
    if (branches.length === 0) {
      await vscode.window.showInformationMessage("No branches are available.");
      return;
    }
    const selectedItem = await vscode.window.showQuickPick(
      this.createBranchItems(branches),
      {
        title: `Branches · ${formatCount(branches.length, "branch")}`,
        placeHolder: "Select a branch or branch action",
        matchOnDescription: true,
      },
    );
    if (selectedItem === undefined) return;
    if (selectedItem.action !== undefined) {
      await this.runTopLevelAction(selectedItem.action, selectionContext);
      return;
    }
    if (selectedItem.branch !== undefined) {
      await this.showBranchActions(selectedItem.branch, selectionContext);
    }
  }

  private createBranchItems(
    branches: readonly LocalGitBranch[],
  ): readonly BranchQuickPickItem[] {
    const currentBranch = branches.find((branch) => branch.isCurrent);
    const localBranches = branches.filter(
      (branch) => !branch.isRemote && !branch.isCurrent,
    );
    const remoteBranches = branches.filter((branch) => branch.isRemote);
    const items: BranchQuickPickItem[] = [
      { label: "Create branch…", action: "create" },
      { label: "Refresh branches", action: "refresh" },
    ];
    this.addBranchGroup(
      items,
      "Current",
      currentBranch === undefined ? [] : [currentBranch],
    );
    this.addBranchGroup(items, "Local", localBranches);
    this.addBranchGroup(items, "Remote", remoteBranches);
    return items;
  }

  private addBranchGroup(
    targetItems: BranchQuickPickItem[],
    groupLabel: string,
    branches: readonly LocalGitBranch[],
  ): void {
    targetItems.push({
      label: `${groupLabel} · ${branches.length}`,
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const branch of branches) {
      const aheadBehind = this.formatAheadBehind(branch);
      const upstream =
        branch.upstreamBranchName === undefined
          ? "No upstream"
          : `upstream ${branch.upstreamBranchName}`;
      targetItems.push({
        label: `${branch.isCurrent ? "$(check) " : ""}${branch.name}`,
        description: [upstream, aheadBehind].filter(Boolean).join(" · "),
        ...(branch.lastCommit === undefined
          ? {}
          : { detail: `HEAD ${branch.lastCommit.slice(0, 7)}` }),
        branch,
      });
    }
  }

  private formatAheadBehind(branch: LocalGitBranch): string {
    const counts: string[] = [];
    if (branch.aheadCount > 0) counts.push(`↑${branch.aheadCount}`);
    if (branch.behindCount > 0) counts.push(`↓${branch.behindCount}`);
    return counts.length === 0 ? "in sync" : counts.join(" ");
  }

  private async runTopLevelAction(
    action: BranchAction,
    selectionContext: BranchSelectionContext,
  ): Promise<void> {
    const commandByAction: Partial<Record<"create" | "refresh", string>> = {
      create: localGitCommandIds.createBranch,
    };
    if (action === "refresh") {
      await this.open();
      return;
    }
    const commandIdentifier = commandByAction[action as "create"];
    if (commandIdentifier === undefined) return;
    await withSurfaceProgress("Git'o: Creating branch", () =>
      executeSurfaceCommand(this.services, commandIdentifier, {
        repositoryRoot: selectionContext.selectedRepositoryRoot,
        ...(selectionContext.expectedRepository === undefined
          ? {}
          : { expectedRepository: selectionContext.expectedRepository }),
      }).then(() => undefined),
    );
  }

  private async showBranchActions(
    branch: LocalGitBranch,
    selectionContext: BranchSelectionContext,
  ): Promise<void> {
    const actions: readonly BranchQuickPickItem[] = [
      ...(branch.isCurrent
        ? []
        : [
            {
              label: branch.isRemote
                ? "Checkout tracking branch"
                : "Checkout branch",
              action: "checkout" as const,
            },
          ]),
      ...(branch.isCurrent
        ? [{ label: "Publish current branch", action: "publish" as const }]
        : []),
      ...(branch.isRemote
        ? []
        : [
            { label: "Delete branch", action: "delete" as const },
            { label: "Force-delete branch", action: "forceDelete" as const },
          ]),
    ];
    const selectedAction = await vscode.window.showQuickPick(actions, {
      title: `${branch.name} · Branch actions`,
      placeHolder: "Choose a branch action",
    });
    if (selectedAction?.action === undefined) return;
    const commandByAction: Partial<
      Record<Exclude<BranchAction, "create" | "refresh">, string>
    > = {
      checkout: localGitCommandIds.checkoutBranch,
      publish: localGitCommandIds.publishBranch,
      delete: localGitCommandIds.deleteBranch,
      forceDelete: localGitCommandIds.forceDeleteBranch,
    };
    const commandIdentifier =
      commandByAction[
        selectedAction.action as Exclude<BranchAction, "create" | "refresh">
      ];
    if (commandIdentifier === undefined) return;
    await withSurfaceProgress(`Git'o: ${selectedAction.label}`, () =>
      executeSurfaceCommand(this.services, commandIdentifier, {
        repositoryRoot: selectionContext.selectedRepositoryRoot,
        branchName: branch.name,
        isRemote: branch.isRemote,
        expectedBranchName: branch.name,
        ...(branch.lastCommit === undefined
          ? {}
          : { expectedBranchCommit: branch.lastCommit }),
        ...(selectionContext.expectedRepository === undefined
          ? {}
          : { expectedRepository: selectionContext.expectedRepository }),
      }).then(() => undefined),
    );
  }
}
