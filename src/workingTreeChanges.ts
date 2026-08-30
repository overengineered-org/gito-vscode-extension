import { basename, dirname, relative } from "node:path";

import * as vscode from "vscode";

import type { GitChange, GitRepository } from "./gitApi.ts";
import type { WorkspaceRepositories } from "./workspaceRepositories.ts";

export type ChangeGroupKind = "conflicts" | "staged" | "unstaged";
export type ChangeAction = "discard" | "stage" | "unstage";

export interface ChangeGroup {
  readonly changes: readonly GitChange[];
  readonly groupKind: ChangeGroupKind;
  readonly repository: GitRepository;
}

export interface WorkingTreeChange {
  readonly change: GitChange;
  readonly changeCount: number;
  readonly changePosition: number;
  readonly groupKind: ChangeGroupKind;
  readonly repository: GitRepository;
}

export interface WorkingTreeChangePresentation {
  readonly description: string;
  readonly fileName: string;
}

export class WorkingTreeChanges {
  public constructor(private readonly workspaceRepositories: WorkspaceRepositories) {}

  public getGroups(
    repository: GitRepository | undefined = this.workspaceRepositories.selectedRepository,
  ): ChangeGroup[] {
    return repository === undefined ? [] : createChangeGroups(repository);
  }

  public getChanges(changeGroup: ChangeGroup): WorkingTreeChange[] {
    return changeGroup.changes.map((change, changeIndex) => ({
      change,
      changeCount: changeGroup.changes.length,
      changePosition: changeIndex + 1,
      groupKind: changeGroup.groupKind,
      repository: changeGroup.repository,
    }));
  }

  public async runChangeAction(
    changeAction: ChangeAction,
    workingTreeChange: WorkingTreeChange,
  ): Promise<void> {
    if (changeAction === "stage") {
      await workingTreeChange.repository.add([workingTreeChange.change.uri.fsPath]);
      return;
    }
    if (changeAction === "unstage") {
      await workingTreeChange.repository.revert([workingTreeChange.change.uri.fsPath]);
      return;
    }
    const discardConfirmation = await vscode.window.showWarningMessage(
      `Discard changes in '${basename(workingTreeChange.change.uri.fsPath)}'?`,
      { modal: true },
      "Discard Changes",
    );
    if (discardConfirmation === "Discard Changes") {
      await workingTreeChange.repository.clean([workingTreeChange.change.uri.fsPath]);
    }
  }

  public async runGroupAction(
    changeAction: "stage" | "unstage",
    changeGroup: ChangeGroup,
  ): Promise<void> {
    const changePaths = changeGroup.changes.map((change) => change.uri.fsPath);
    await (changeAction === "stage"
      ? changeGroup.repository.add(changePaths)
      : changeGroup.repository.revert(changePaths));
  }
}

export function changeGroupLabel(changeGroupKind: ChangeGroupKind): string {
  return {
    conflicts: "Resolve Conflicts",
    staged: "Staged Changes",
    unstaged: "Changes",
  }[changeGroupKind];
}

export function createWorkingTreeChangePresentation(
  workingTreeChange: WorkingTreeChange,
): WorkingTreeChangePresentation {
  const relativeChangePath = relative(
    workingTreeChange.repository.rootUri.fsPath,
    workingTreeChange.change.uri.fsPath,
  );
  const parentDirectory = dirname(relativeChangePath);
  const changeStatus =
    workingTreeChange.groupKind === "conflicts"
      ? "Needs your choice"
      : statusLabel(workingTreeChange.change.status);
  return {
    description: `${parentDirectory === "." ? "" : parentDirectory} ${changeStatus}`.trim(),
    fileName: basename(relativeChangePath),
  };
}

function createChangeGroups(repository: GitRepository): ChangeGroup[] {
  const groups: readonly [ChangeGroupKind, readonly GitChange[]][] = [
    ["conflicts", repository.state.mergeChanges],
    ["staged", repository.state.indexChanges],
    [
      "unstaged",
      [...repository.state.workingTreeChanges, ...repository.state.untrackedChanges].toSorted(
        compareChangePaths,
      ),
    ],
  ];
  return groups.flatMap(([groupKind, changes]) =>
    changes.length === 0 ? [] : [{ changes, groupKind, repository }],
  );
}

function compareChangePaths(firstChange: GitChange, secondChange: GitChange): number {
  return firstChange.uri.fsPath.localeCompare(secondChange.uri.fsPath);
}

function statusLabel(status: number): string {
  return statusLabels[status] ?? "?";
}

const statusLabels = [
  "M",
  "A",
  "D",
  "R",
  "C",
  "M",
  "D",
  "U",
  "I",
  "A",
  "R",
  "T",
  "AU",
  "UA",
  "DU",
  "UD",
  "AA",
  "DD",
  "UU",
] as const;
