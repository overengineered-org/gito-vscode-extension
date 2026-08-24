import * as vscode from "vscode";
import { localGitCommandIds } from "../commands/localGitCommands.js";
import {
  localGitHistoryPageSize,
  type CommitHistoryPage,
} from "../git/gitHistoryService.js";
import type {
  LocalGitCommitDetails,
  LocalGitCommitFileChange,
  LocalGitCommitSummary,
} from "../git/localGitModels.js";
import {
  executeSurfaceCommand,
  formatDate,
  formatCount,
  withSurfaceProgress,
} from "./surfaceUtilities.js";
import type { GitoSurfaceServices } from "./surfaceTypes.js";

type CommitBrowserAction = "search" | "loadMore";

interface CommitQuickPickItem extends vscode.QuickPickItem {
  readonly commit?: LocalGitCommitSummary;
  readonly browserAction?: CommitBrowserAction;
}

interface CommitDetailsQuickPickItem extends vscode.QuickPickItem {
  readonly action?: "copySha" | "copyMessage" | "openProviderUrl" | "back";
  readonly fileChange?: LocalGitCommitFileChange;
}

/** Paged native history browser. Every page is exactly GitHistoryService's 100 commits. */
export class CommitsSurface {
  public constructor(private readonly services: GitoSurfaceServices) {}

  public async open(): Promise<void> {
    const repositoryRoot =
      await this.services.repositoryService.getRepositoryRoot();
    const firstPage = await this.loadPage(repositoryRoot, 0);
    await this.browsePages(repositoryRoot, firstPage);
  }

  private async loadPage(
    repositoryRoot: vscode.Uri,
    pageIndex: number,
  ): Promise<CommitHistoryPage> {
    return withSurfaceProgress(
      `Git'o: Loading commits · page ${pageIndex + 1}`,
      (cancellationSignal) =>
        this.services.historyService.listCommitHistory(
          repositoryRoot,
          pageIndex,
          cancellationSignal,
        ),
    );
  }

  private async browsePages(
    repositoryRoot: vscode.Uri,
    firstPage: CommitHistoryPage,
  ): Promise<void> {
    let loadedCommits = [...firstPage.commits];
    let currentPage = firstPage;
    for (;;) {
      if (loadedCommits.length === 0) {
        await vscode.window.showInformationMessage(
          "This repository has no commits.",
        );
        return;
      }
      const selectedItem = await vscode.window.showQuickPick(
        this.createCommitItems(loadedCommits, currentPage.hasMore),
        {
          title: `Commits · ${formatCount(loadedCommits.length, "loaded commit")}`,
          placeHolder: "Select a commit to inspect",
          matchOnDescription: true,
        },
      );
      if (selectedItem === undefined) return;
      if (selectedItem.browserAction === "search") {
        const searchedCommits =
          await this.searchRepositoryCommits(repositoryRoot);
        if (searchedCommits === undefined) continue;
        if (searchedCommits.length === 0) {
          await vscode.window.showInformationMessage(
            "No repository commits matched that search.",
          );
          continue;
        }
        const searchedItem = await vscode.window.showQuickPick(
          this.createCommitItems(searchedCommits, false),
          {
            title: "Commits · Search results",
            placeHolder: "Select a matching commit",
            matchOnDescription: true,
          },
        );
        if (searchedItem?.commit !== undefined) {
          await this.showCommitDetails(repositoryRoot, searchedItem.commit);
        }
        continue;
      }
      if (selectedItem.browserAction === "loadMore") {
        currentPage = await this.loadPage(
          repositoryRoot,
          currentPage.pageIndex + 1,
        );
        loadedCommits = [...loadedCommits, ...currentPage.commits];
        continue;
      }
      if (selectedItem.commit !== undefined) {
        await this.showCommitDetails(repositoryRoot, selectedItem.commit);
      }
    }
  }

  private createCommitItems(
    commits: readonly LocalGitCommitSummary[],
    hasMore: boolean,
  ): readonly CommitQuickPickItem[] {
    const items: CommitQuickPickItem[] = commits.map((commit) => ({
      label: `${commit.shortSha}  ${commit.subject}`,
      description: `${commit.authorName} · ${formatDate(commit.commitDate)}`,
      ...(commit.refs.length > 0 ? { detail: commit.refs.join(", ") } : {}),
      commit,
    }));
    items.push({
      label: "Search loaded commits…",
      iconPath: new vscode.ThemeIcon("search"),
      browserAction: "search",
    });
    if (hasMore) {
      items.push({
        label: `Load next ${localGitHistoryPageSize} commits…`,
        iconPath: new vscode.ThemeIcon("arrow-down"),
        browserAction: "loadMore",
      });
    }
    return items;
  }

  private async searchRepositoryCommits(
    repositoryRoot: vscode.Uri,
  ): Promise<readonly LocalGitCommitSummary[] | undefined> {
    const searchText = await vscode.window.showInputBox({
      title: "Commits · Search",
      prompt: "Search repository commits by SHA, subject, or author",
      placeHolder: "e.g. fix parser, a1b2c3, or author@example.com",
    });
    if (searchText === undefined) return undefined;
    return withSurfaceProgress(
      "Git'o: Searching repository commits",
      (cancellationSignal) =>
        this.services.historyService.searchHistory(
          repositoryRoot,
          searchText,
          cancellationSignal,
        ),
    );
  }

  private async showCommitDetails(
    repositoryRoot: vscode.Uri,
    commit: LocalGitCommitSummary,
  ): Promise<void> {
    const details = await withSurfaceProgress(
      `Git'o: Loading ${commit.shortSha}`,
      (cancellationSignal) =>
        this.services.historyService.getCommitDetails(
          repositoryRoot,
          commit.commitSha,
          cancellationSignal,
        ),
    );
    const providerUrl = await this.getProviderCommitUrl(
      repositoryRoot,
      details,
    );
    const selectedItem = await vscode.window.showQuickPick(
      this.createDetailsItems(details, providerUrl),
      {
        title: `${details.shortSha}  ${details.subject}`,
        placeHolder: "Choose a commit action or changed file",
        matchOnDescription: true,
      },
    );
    if (selectedItem === undefined || selectedItem.action === "back") return;
    if (selectedItem.action === "copySha") {
      await executeSurfaceCommand(
        this.services,
        localGitCommandIds.copyCommitSha,
        details.commitSha,
      );
      return;
    }
    if (selectedItem.action === "copyMessage") {
      await executeSurfaceCommand(
        this.services,
        localGitCommandIds.copyCommitMessage,
        details.body || details.subject,
      );
      return;
    }
    if (
      selectedItem.action === "openProviderUrl" &&
      providerUrl !== undefined
    ) {
      await vscode.env.openExternal(vscode.Uri.parse(providerUrl));
      return;
    }
    if (selectedItem.fileChange !== undefined) {
      await executeSurfaceCommand(
        this.services,
        localGitCommandIds.openCommitFileDiff,
        {
          repositoryRoot,
          commitSha: details.commitSha,
          filePath: selectedItem.fileChange.path,
        },
      );
    }
  }

  private createDetailsItems(
    details: LocalGitCommitDetails,
    providerUrl: string | undefined,
  ): readonly CommitDetailsQuickPickItem[] {
    const items: CommitDetailsQuickPickItem[] = [
      {
        label: `$(copy) Copy commit SHA · ${details.shortSha}`,
        action: "copySha",
      },
      {
        label: "$(copy) Copy commit message",
        detail: details.body || details.subject,
        action: "copyMessage",
      },
      {
        label: "$(arrow-left) Back to commits",
        action: "back",
      },
      {
        label: "Changed files",
        kind: vscode.QuickPickItemKind.Separator,
      },
    ];
    if (providerUrl !== undefined) {
      items.splice(2, 0, {
        label: "$(link-external) Open provider commit",
        description: providerUrl,
        action: "openProviderUrl",
      });
    }
    for (const fileChange of details.files) {
      items.push({
        label:
          fileChange.previousPath === undefined
            ? fileChange.path
            : `${fileChange.previousPath} → ${fileChange.path}`,
        description: `+${fileChange.additions} · -${fileChange.deletions} · ${fileChange.changeType}`,
        fileChange,
      });
    }
    if (details.files.length === 0) {
      items.push({
        label: "No changed files in this commit",
        kind: vscode.QuickPickItemKind.Separator,
      });
    }
    return items;
  }

  private async getProviderCommitUrl(
    repositoryRoot: vscode.Uri,
    commit: LocalGitCommitSummary,
  ): Promise<string | undefined> {
    if (this.services.repositoryDiscovery === undefined) return undefined;
    try {
      const repository =
        await this.services.repositoryDiscovery.selectRepository({
          selectedRepositoryRoot: repositoryRoot,
        });
      const remoteUrls = this.services.historyService.getRemoteUrls(repository);
      return this.services.historyService.getCanonicalCommitUrl(
        remoteUrls,
        commit.commitSha,
      );
    } catch {
      // Provider links are optional; local commit details remain usable.
      return undefined;
    }
  }
}
