import * as vscode from "vscode";
import { isAbortError } from "../git/gitCommandRunner.js";
import { formatGitErrorForUser } from "../git/gitErrorFormatting.js";
import type {
  GitOperationPreview,
  GitOperationResult,
} from "../operations/index.js";
import {
  buildOperationRiskReadout,
  buildOperationsMenuItems,
  boundConfirmationText,
  formatOperationConfirmationSummary,
  formatOperationPreview,
  formatOperationResult,
} from "./operationsExperienceView.js";
import {
  operationsExperienceCommandIds,
  type OperationsExperienceAction,
  type OperationsExperienceDependencies,
  type OperationsExperienceQuickPickItem,
  type OperationsExperienceStateReader,
  type OperationsExperienceUi,
  type OperationsStateBanner,
} from "./operationsExperienceModels.js";

type PreviewFactory = (
  cancellationSignal: AbortSignal,
) => Promise<GitOperationPreview>;

interface OperationChoice {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly detail: string;
}

interface OperationRunOptions {
  readonly progressTitle: string;
  readonly readOnly?: boolean;
  readonly extraPreviewText?: string;
}

const confirmLabel = "Confirm operation";

/** Native, progressive, confirmation-first Git Operations Center. */
export class OperationsExperienceController {
  private readonly ui: OperationsExperienceUi;
  private readonly stateReader: OperationsExperienceStateReader | undefined;

  public constructor(
    private readonly dependencies: OperationsExperienceDependencies,
  ) {
    this.ui = dependencies.ui ?? createVscodeOperationsExperienceUi();
    this.stateReader = dependencies.stateReader;
  }

  public async open(): Promise<void> {
    if (!this.ui.isWorkspaceTrusted()) {
      await this.ui.showWarningMessage(
        "Operations Center is disabled in an untrusted workspace. Trust this workspace before running local Git operations.",
        { modal: true },
        "Manage Workspace Trust",
        "Cancel",
      );
      return;
    }
    try {
      const repositoryRoot =
        await this.dependencies.repositoryProvider.getRepositoryRoot();
      if (repositoryRoot === undefined) {
        await this.ui.showInformationMessage(
          "Open or select a Git repository before using Operations Center.",
        );
        return;
      }
      const stateBanner = await this.readStateBanner(repositoryRoot);
      const selectedItem = await this.ui.showQuickPick(
        buildOperationsMenuItems(stateBanner),
        {
          title: "Git'o Operations Center",
          placeHolder:
            stateBanner === undefined
              ? "Choose a task. Every change previews first."
              : `${stateBanner.summary} · choose a next step`,
          ignoreFocusOut: true,
          matchOnDescription: true,
          matchOnDetail: true,
        },
      );
      if (selectedItem === undefined || Array.isArray(selectedItem)) return;
      const selectedExperienceItem =
        selectedItem as OperationsExperienceQuickPickItem;
      await this.runSelectedAction(
        repositoryRoot,
        selectedExperienceItem.action,
        stateBanner,
      );
    } catch (error: unknown) {
      await this.reportError(error);
    }
  }

  private async readStateBanner(
    repositoryRoot: string,
  ): Promise<OperationsStateBanner | undefined> {
    if (this.stateReader === undefined) return undefined;
    return this.stateReader.read(repositoryRoot);
  }

  private async runSelectedAction(
    repositoryRoot: string,
    action: OperationsExperienceAction,
    stateBanner: OperationsStateBanner | undefined,
  ): Promise<void> {
    switch (action) {
      case "stash":
        return this.openStash(repositoryRoot);
      case "tags":
        return this.openTags(repositoryRoot);
      case "history":
        return this.openHistory(repositoryRoot);
      case "rebase":
        return this.openRebase(repositoryRoot);
      case "branches":
        return this.openBranches(repositoryRoot);
      case "remotes":
        return this.openRemotes(repositoryRoot);
      case "network":
        return this.openNetwork(repositoryRoot);
      case "patch":
        return this.openPatch(repositoryRoot);
      case "bisect":
        return this.openBisect(repositoryRoot);
      case "reflog":
        return this.openReflog(repositoryRoot);
      case "clean":
        return this.openClean(repositoryRoot);
      case "continue":
        return this.runActiveOperationAction(
          repositoryRoot,
          "continue",
          stateBanner,
        );
      case "skip":
        return this.runActiveOperationAction(
          repositoryRoot,
          "skip",
          stateBanner,
        );
      case "abort":
        return this.runActiveOperationAction(
          repositoryRoot,
          "abort",
          stateBanner,
        );
    }
  }

  private async openStash(repositoryRoot: string): Promise<void> {
    const choice = await this.pickSubtask("Stash", [
      choiceItem(
        "create",
        "Create stash",
        "Save worktree changes",
        "Optional message; untracked files included by default.",
      ),
      choiceItem(
        "list",
        "List stashes",
        "Read current stash refs",
        "Read-only; no mutation.",
      ),
      choiceItem(
        "inspect",
        "Inspect stash",
        "Show exact files and patch",
        "Read-only; no mutation.",
      ),
      choiceItem(
        "apply",
        "Apply stash",
        "Apply and keep the entry",
        "Worktree changes; conflict risk.",
      ),
      choiceItem(
        "pop",
        "Pop stash",
        "Apply and remove the entry",
        "Worktree changes plus stash deletion.",
      ),
      choiceItem(
        "drop",
        "Drop stash",
        "Delete one stash entry",
        "Irreversible stash deletion.",
      ),
      choiceItem(
        "branch",
        "Branch from stash",
        "Create a branch and apply the entry",
        "Creates a ref and changes worktree state.",
      ),
    ]);
    if (choice === undefined) return;
    if (choice.id === "create") {
      const message = await this.input(
        "Stash message",
        "Optional message; leave empty for Git default",
        "work in progress",
      );
      if (message === undefined) return;
      await this.runOperation(
        repositoryRoot,
        (signal) =>
          this.dependencies.operations.previewStashCreate({
            repositoryRoot,
            expectedRepositoryRoot: repositoryRoot,
            ...(message.length === 0 ? {} : { message }),
            includeUntracked: true,
            cancellationSignal: signal,
          }),
        { progressTitle: "Preparing stash preview" },
      );
      return;
    }
    if (choice.id === "list") {
      await this.runOperation(
        repositoryRoot,
        (signal) =>
          this.dependencies.operations.previewStashList({
            repositoryRoot,
            expectedRepositoryRoot: repositoryRoot,
            cancellationSignal: signal,
          }),
        { progressTitle: "Reading stashes", readOnly: true },
      );
      return;
    }
    const stashReference = await this.input(
      "Stash reference",
      "Exact stash ref, for example stash@{0}",
      "stash@{0}",
    );
    if (stashReference === undefined) return;
    if (choice.id === "inspect") {
      await this.runOperation(
        repositoryRoot,
        (signal) =>
          this.dependencies.operations.previewStashInspect({
            repositoryRoot,
            expectedRepositoryRoot: repositoryRoot,
            stashReference,
            cancellationSignal: signal,
          }),
        { progressTitle: "Preparing stash inspection", readOnly: true },
      );
      return;
    }
    if (choice.id === "apply" || choice.id === "pop" || choice.id === "drop") {
      const previewMethod =
        choice.id === "apply"
          ? "previewStashApply"
          : choice.id === "pop"
            ? "previewStashPop"
            : "previewStashDrop";
      await this.runOperation(
        repositoryRoot,
        (signal) =>
          this.dependencies.operations[previewMethod]({
            repositoryRoot,
            expectedRepositoryRoot: repositoryRoot,
            stashReference,
            cancellationSignal: signal,
          }),
        { progressTitle: `Preparing stash ${choice.id} preview` },
      );
      return;
    }
    const branchName = await this.input(
      "New branch name",
      "Exact branch ref to create from the stash",
      "feature/from-stash",
    );
    if (branchName === undefined) return;
    await this.runOperation(
      repositoryRoot,
      (signal) =>
        this.dependencies.operations.previewStashBranch({
          repositoryRoot,
          expectedRepositoryRoot: repositoryRoot,
          stashReference,
          branchName,
          cancellationSignal: signal,
        }),
      { progressTitle: "Preparing stash branch preview" },
    );
  }

  private async openTags(repositoryRoot: string): Promise<void> {
    const choice = await this.pickSubtask("Tags", [
      choiceItem(
        "create",
        "Create tag",
        "Create a local tag at a commit",
        "Annotated message and exact target are optional.",
      ),
      choiceItem(
        "delete",
        "Delete tag",
        "Delete one local tag",
        "Irreversible local ref deletion; reflog recovery may not exist.",
      ),
      choiceItem(
        "push",
        "Push tag",
        "Publish one tag to a remote",
        "Remote ref changes require confirmation.",
      ),
    ]);
    if (choice === undefined) return;
    const tagName = await this.input("Tag name", "Exact tag ref", "v1.0.0");
    if (tagName === undefined) return;
    if (choice.id === "create") {
      const target = await this.input(
        "Target commit",
        "Commit/ref; leave empty for current HEAD",
        "HEAD",
      );
      if (target === undefined) return;
      const annotatedMessage = await this.input(
        "Annotated message",
        "Leave empty for a lightweight tag",
        "Release note",
      );
      if (annotatedMessage === undefined) return;
      await this.runOperation(
        repositoryRoot,
        (signal) =>
          this.dependencies.operations.previewTagCreate({
            repositoryRoot,
            expectedRepositoryRoot: repositoryRoot,
            tagName,
            ...(target.length === 0 ? {} : { target }),
            ...(annotatedMessage.length === 0 ? {} : { annotatedMessage }),
            cancellationSignal: signal,
          }),
        { progressTitle: "Preparing tag preview" },
      );
      return;
    }
    if (choice.id === "delete") {
      await this.runOperation(
        repositoryRoot,
        (signal) =>
          this.dependencies.operations.previewTagDelete({
            repositoryRoot,
            expectedRepositoryRoot: repositoryRoot,
            tagName,
            cancellationSignal: signal,
          }),
        { progressTitle: "Preparing tag deletion preview" },
      );
      return;
    }
    const remoteName = await this.input(
      "Remote name",
      "Remote receiving this exact tag",
      "origin",
    );
    if (remoteName === undefined) return;
    await this.runOperation(
      repositoryRoot,
      (signal) =>
        this.dependencies.operations.previewTagPush({
          repositoryRoot,
          expectedRepositoryRoot: repositoryRoot,
          tagName,
          remoteName,
          cancellationSignal: signal,
        }),
      { progressTitle: "Preparing tag push preview" },
    );
  }

  private async openHistory(repositoryRoot: string): Promise<void> {
    const choice = await this.pickSubtask("Change history", [
      choiceItem(
        "merge",
        "Merge",
        "Merge an exact ref into current branch",
        "Conflicts can leave an explicit operation state.",
      ),
      choiceItem(
        "cherry-pick",
        "Cherry-pick",
        "Apply one exact commit",
        "Creates a new commit; conflicts are inspectable.",
      ),
      choiceItem(
        "revert",
        "Revert",
        "Create a commit that reverses one exact commit",
        "Safe history correction; exact commit shown.",
      ),
      choiceItem(
        "reset",
        "Reset",
        "Move HEAD to an exact ref",
        "Mode controls index/worktree impact; hard is high impact.",
      ),
    ]);
    if (choice === undefined) return;
    const commitish = await this.input(
      "Commit or ref",
      "Exact commit/ref",
      "HEAD~1",
    );
    if (commitish === undefined) return;
    if (
      choice.id === "merge" ||
      choice.id === "cherry-pick" ||
      choice.id === "revert"
    ) {
      const mergeMode =
        choice.id === "merge"
          ? await this.pickValue("Merge mode", [
              choiceItem(
                "default",
                "Configured default",
                "Use Git's configured fast-forward policy",
                "Exact policy shown in preview.",
              ),
              choiceItem(
                "ff",
                "Fast-forward",
                "Allow fast-forward when possible",
                "No merge commit when fast-forward is possible.",
              ),
              choiceItem(
                "no-ff",
                "No fast-forward",
                "Always create a merge commit",
                "Preserves an explicit merge node.",
              ),
              choiceItem(
                "ff-only",
                "Fast-forward only",
                "Refuse divergent history",
                "Fails without mutating on divergence.",
              ),
            ])
          : undefined;
      if (choice.id === "merge" && mergeMode === undefined) return;
      const previewMethod =
        choice.id === "merge"
          ? "previewMerge"
          : choice.id === "cherry-pick"
            ? "previewCherryPick"
            : "previewRevert";
      await this.runOperation(
        repositoryRoot,
        (signal) =>
          this.dependencies.operations[previewMethod]({
            repositoryRoot,
            expectedRepositoryRoot: repositoryRoot,
            commitish,
            ...(mergeMode === undefined
              ? {}
              : {
                  mode: mergeMode.id as "default" | "ff" | "no-ff" | "ff-only",
                }),
            cancellationSignal: signal,
          }),
        { progressTitle: `Preparing ${choice.id} preview` },
      );
      return;
    }
    const mode = await this.pickValue("Reset mode", [
      choiceItem(
        "soft",
        "Soft",
        "Move HEAD; keep index and worktree",
        "Lowest impact reset.",
      ),
      choiceItem(
        "mixed",
        "Mixed",
        "Move HEAD; reset index",
        "Working files stay on disk.",
      ),
      choiceItem(
        "hard",
        "Hard",
        "Move HEAD and discard tracked changes",
        "High impact; recovery via reflog only.",
      ),
      choiceItem(
        "merge",
        "Merge",
        "Move HEAD while preserving local changes",
        "Git may refuse when unsafe.",
      ),
      choiceItem(
        "keep",
        "Keep",
        "Move HEAD while keeping local changes",
        "Git may refuse when unsafe.",
      ),
    ]);
    if (mode === undefined) return;
    await this.runOperation(
      repositoryRoot,
      (signal) =>
        this.dependencies.operations.previewReset({
          repositoryRoot,
          expectedRepositoryRoot: repositoryRoot,
          commitish,
          mode: mode.id as "soft" | "mixed" | "hard" | "merge" | "keep",
          cancellationSignal: signal,
        }),
      { progressTitle: "Preparing reset preview" },
    );
  }

  private async openRebase(repositoryRoot: string): Promise<void> {
    const choice = await this.pickSubtask("Rebase", [
      choiceItem(
        "start",
        "Start rebase",
        "Rebase current branch onto an exact upstream",
        "Can create conflicts; continue, skip, or abort stays visible.",
      ),
      choiceItem(
        "continue",
        "Continue",
        "Advance an active rebase",
        "Requires resolved and staged conflicts.",
      ),
      choiceItem(
        "skip",
        "Skip step",
        "Discard the active rebase commit",
        "Irreversible for the skipped step.",
      ),
      choiceItem(
        "abort",
        "Abort",
        "Restore pre-rebase state",
        "Leaves unrelated files only when Git allows.",
      ),
    ]);
    if (choice === undefined) return;
    if (choice.id !== "start") {
      const previewMethod =
        choice.id === "continue"
          ? "previewRebaseContinue"
          : choice.id === "skip"
            ? "previewRebaseSkip"
            : "previewRebaseAbort";
      await this.runOperation(
        repositoryRoot,
        (signal) =>
          this.dependencies.operations[previewMethod]({
            repositoryRoot,
            expectedRepositoryRoot: repositoryRoot,
            cancellationSignal: signal,
          }),
        { progressTitle: `Preparing rebase ${choice.id} preview` },
      );
      return;
    }
    const upstream = await this.input(
      "Upstream ref",
      "Exact upstream ref",
      "origin/main",
    );
    if (upstream === undefined) return;
    const onto = await this.input(
      "Onto ref",
      "Optional exact base; leave empty for upstream",
      "",
    );
    if (onto === undefined) return;
    await this.runOperation(
      repositoryRoot,
      (signal) =>
        this.dependencies.operations.previewRebaseStart({
          repositoryRoot,
          expectedRepositoryRoot: repositoryRoot,
          upstream,
          ...(onto.length === 0 ? {} : { onto }),
          cancellationSignal: signal,
        }),
      { progressTitle: "Preparing rebase preview" },
    );
  }

  private async openBranches(repositoryRoot: string): Promise<void> {
    const choice = await this.pickSubtask("Branches", [
      choiceItem(
        "rename",
        "Rename branch",
        "Rename an exact local branch ref",
        "Read back old-ref absence and new-ref presence.",
      ),
      choiceItem(
        "upstream",
        "Set or unset upstream",
        "Change branch tracking configuration",
        "Remote and branch names are exact.",
      ),
    ]);
    if (choice === undefined) return;
    if (choice.id === "rename") {
      const oldBranchName = await this.input(
        "Current branch name",
        "Leave empty for the checked-out branch",
        "feature/old-name",
      );
      if (oldBranchName === undefined) return;
      const newBranchName = await this.input(
        "New branch name",
        "Exact new local branch ref",
        "feature/new-name",
      );
      if (newBranchName === undefined) return;
      await this.runOperation(
        repositoryRoot,
        (signal) =>
          this.dependencies.operations.previewBranchRename({
            repositoryRoot,
            expectedRepositoryRoot: repositoryRoot,
            ...(oldBranchName.length === 0 ? {} : { oldBranchName }),
            newBranchName,
            cancellationSignal: signal,
          }),
        { progressTitle: "Preparing branch rename preview" },
      );
      return;
    }
    const setUpstream = await this.pickValue("Upstream action", [
      choiceItem(
        "set",
        "Set upstream",
        "Track a remote branch",
        "Creates exact upstream configuration.",
      ),
      choiceItem(
        "unset",
        "Unset upstream",
        "Remove tracking configuration",
        "Local branch remains.",
      ),
    ]);
    if (setUpstream === undefined) return;
    const branchName = await this.input(
      "Local branch",
      "Exact local branch ref",
      "main",
    );
    if (branchName === undefined) return;
    const remoteName = await this.input(
      "Remote name",
      "Exact remote name",
      "origin",
    );
    if (remoteName === undefined) return;
    await this.runOperation(
      repositoryRoot,
      (signal) =>
        this.dependencies.operations.previewBranchUpstream({
          repositoryRoot,
          expectedRepositoryRoot: repositoryRoot,
          remoteName,
          branchName,
          setUpstream: setUpstream.id === "set",
          cancellationSignal: signal,
        }),
      { progressTitle: "Preparing upstream preview" },
    );
  }

  private async openRemotes(repositoryRoot: string): Promise<void> {
    const choice = await this.pickSubtask("Remotes", [
      choiceItem(
        "add",
        "Add remote",
        "Register a remote URL",
        "Credentials stay redacted in the preview and readback.",
      ),
      choiceItem(
        "rename",
        "Rename remote",
        "Rename a remote and its refs",
        "Read back old-ref absence and new remote presence.",
      ),
      choiceItem(
        "remove",
        "Remove remote",
        "Delete local remote configuration",
        "Remote-tracking refs are removed locally.",
      ),
      choiceItem(
        "prune",
        "Prune remote",
        "Remove stale remote-tracking refs",
        "Exact remote only; recovery depends on ref reflog.",
      ),
    ]);
    if (choice === undefined) return;
    const remoteName = await this.input(
      "Remote name",
      "Exact remote ref",
      "origin",
    );
    if (remoteName === undefined) return;
    if (choice.id === "add") {
      const remoteUrl = await this.input(
        "Remote URL",
        "Exact URL; credentials are redacted in UI",
        "https://example.test/repo.git",
      );
      if (remoteUrl === undefined) return;
      await this.runOperation(
        repositoryRoot,
        (signal) =>
          this.dependencies.operations.previewRemoteAdd({
            repositoryRoot,
            expectedRepositoryRoot: repositoryRoot,
            remoteName,
            remoteUrl,
            cancellationSignal: signal,
          }),
        { progressTitle: "Preparing remote add preview" },
      );
      return;
    }
    if (choice.id === "rename") {
      const newRemoteName = await this.input(
        "New remote name",
        "Exact new remote ref",
        "upstream",
      );
      if (newRemoteName === undefined) return;
      await this.runOperation(
        repositoryRoot,
        (signal) =>
          this.dependencies.operations.previewRemoteRename({
            repositoryRoot,
            expectedRepositoryRoot: repositoryRoot,
            remoteName,
            newRemoteName,
            cancellationSignal: signal,
          }),
        { progressTitle: "Preparing remote rename preview" },
      );
      return;
    }
    const previewMethod =
      choice.id === "remove" ? "previewRemoteRemove" : "previewRemotePrune";
    await this.runOperation(
      repositoryRoot,
      (signal) =>
        this.dependencies.operations[previewMethod]({
          repositoryRoot,
          expectedRepositoryRoot: repositoryRoot,
          remoteName,
          cancellationSignal: signal,
        }),
      { progressTitle: `Preparing remote ${choice.id} preview` },
    );
  }

  private async openNetwork(repositoryRoot: string): Promise<void> {
    const choice = await this.pickSubtask("Fetch, pull, push", [
      choiceItem(
        "fetch",
        "Fetch",
        "Update local remote-tracking refs",
        "Prune is optional; no working-tree changes expected.",
      ),
      choiceItem(
        "pull",
        "Pull",
        "Integrate upstream into current branch",
        "Merge/rebase mode is explicit; conflicts remain inspectable.",
      ),
      choiceItem(
        "push",
        "Push",
        "Publish exact local refs",
        "Force and delete modes are high impact.",
      ),
    ]);
    if (choice === undefined) return;
    if (choice.id === "fetch") {
      const remoteName = await this.input(
        "Remote name",
        "Leave empty to use all remotes",
        "origin",
      );
      if (remoteName === undefined) return;
      const pruneChoice = await this.pickValue("Prune stale refs?", [
        choiceItem(
          "yes",
          "Prune",
          "Remove stale remote-tracking refs",
          "High impact on local refs.",
        ),
        choiceItem("no", "Keep", "Do not prune", "Fetch only."),
      ]);
      if (pruneChoice === undefined) return;
      const prune = pruneChoice.id === "yes";
      await this.runOperation(
        repositoryRoot,
        (signal) =>
          this.dependencies.operations.previewFetch({
            repositoryRoot,
            expectedRepositoryRoot: repositoryRoot,
            ...(remoteName.length === 0 ? { all: true } : { remoteName }),
            prune,
            cancellationSignal: signal,
          }),
        { progressTitle: "Preparing fetch preview" },
      );
      return;
    }
    if (choice.id === "pull") {
      const mode = await this.pickValue("Pull integration", [
        choiceItem(
          "merge",
          "Merge",
          "Integrate with a merge",
          "Creates a merge commit when needed.",
        ),
        choiceItem(
          "rebase",
          "Rebase",
          "Replay local commits",
          "Can create conflicts; abort remains available.",
        ),
        choiceItem(
          "ff-only",
          "Fast-forward only",
          "Refuse divergent history",
          "Safest history mode.",
        ),
      ]);
      if (mode === undefined) return;
      await this.runOperation(
        repositoryRoot,
        (signal) =>
          this.dependencies.operations.previewPull({
            repositoryRoot,
            expectedRepositoryRoot: repositoryRoot,
            mode: mode.id as "merge" | "rebase" | "ff-only",
            cancellationSignal: signal,
          }),
        { progressTitle: "Preparing pull preview" },
      );
      return;
    }
    const mode = await this.pickValue("Push mode", [
      choiceItem(
        "normal",
        "Normal",
        "Update remote branch",
        "Remote ref must accept a fast-forward.",
      ),
      choiceItem(
        "set-upstream",
        "Set upstream",
        "Push and configure tracking",
        "Changes local branch configuration.",
      ),
      choiceItem(
        "force-with-lease",
        "Force with lease",
        "Rewrite remote only if unchanged",
        "High impact; lease protects concurrent updates.",
      ),
      choiceItem(
        "force",
        "Force with lease",
        "Rewrite remote only if the pinned remote OID is unchanged",
        "Git'o uses an exact OID lease; concurrent remote updates are refused.",
      ),
    ]);
    if (mode === undefined) return;
    const remoteName = await this.input(
      "Remote name",
      "Leave empty for configured remote",
      "origin",
    );
    if (remoteName === undefined) return;
    const branchName = await this.input(
      "Branch name",
      "Leave empty for current branch",
      "main",
    );
    if (branchName === undefined) return;
    await this.runOperation(
      repositoryRoot,
      (signal) =>
        this.dependencies.operations.previewPush({
          repositoryRoot,
          expectedRepositoryRoot: repositoryRoot,
          mode: mode.id as
            "normal" | "set-upstream" | "force-with-lease" | "force",
          ...(remoteName.length === 0 ? {} : { remoteName }),
          ...(branchName.length === 0 ? {} : { branchName }),
          cancellationSignal: signal,
        }),
      { progressTitle: "Preparing push preview" },
    );
  }

  private async openPatch(repositoryRoot: string): Promise<void> {
    const choice = await this.pickSubtask("Patches", [
      choiceItem(
        "create",
        "Create patch",
        "Export exact changes as patch text",
        "Read-only; repository remains unchanged.",
      ),
      choiceItem(
        "apply",
        "Apply patch",
        "Check or apply explicit patch text",
        "Patch text is shown in the confirmation readout.",
      ),
    ]);
    if (choice === undefined) return;
    if (choice.id === "create") {
      const scope = await this.pickValue("Patch scope", [
        choiceItem(
          "working-tree",
          "Working tree",
          "Unstaged changes",
          "Read-only diff.",
        ),
        choiceItem(
          "staged",
          "Staged",
          "Index changes",
          "Read-only cached diff.",
        ),
        choiceItem("both", "All", "HEAD to worktree", "Read-only full diff."),
      ]);
      if (scope === undefined) return;
      await this.runOperation(
        repositoryRoot,
        (signal) =>
          this.dependencies.operations.previewPatchCreate({
            repositoryRoot,
            expectedRepositoryRoot: repositoryRoot,
            scope: scope.id as "working-tree" | "staged" | "both",
            cancellationSignal: signal,
          }),
        { progressTitle: "Creating patch preview", readOnly: true },
      );
      return;
    }
    const patchText = await this.input(
      "Patch text",
      "Paste exact patch text",
      "diff --git …",
    );
    if (patchText === undefined) return;
    const patchAction = await this.pickValue("Patch action", [
      choiceItem(
        "check",
        "Check only",
        "Verify applicability without mutation",
        "Read-only.",
      ),
      choiceItem(
        "apply",
        "Apply",
        "Apply to worktree",
        "Changes files; confirm exact patch.",
      ),
    ]);
    if (patchAction === undefined) return;
    const checkOnly = patchAction.id === "check";
    await this.runOperation(
      repositoryRoot,
      (signal) =>
        this.dependencies.operations.previewPatchApply({
          repositoryRoot,
          expectedRepositoryRoot: repositoryRoot,
          patchText,
          checkOnly,
          cancellationSignal: signal,
        }),
      {
        progressTitle: checkOnly
          ? "Checking patch"
          : "Preparing patch apply preview",
        readOnly: checkOnly,
      },
    );
  }

  private async openBisect(repositoryRoot: string): Promise<void> {
    const choice = await this.pickSubtask("Bisect", [
      choiceItem(
        "start",
        "Start",
        "Start a binary-search session",
        "Bad and good commits are exact; next checkout is explicit.",
      ),
      choiceItem(
        "good",
        "Mark good",
        "Mark current candidate good",
        "Advances bisect state.",
      ),
      choiceItem(
        "bad",
        "Mark bad",
        "Mark current candidate bad",
        "Advances bisect state.",
      ),
      choiceItem(
        "skip",
        "Skip candidate",
        "Skip an untestable candidate",
        "Advances without marking quality.",
      ),
      choiceItem(
        "reset",
        "Reset bisect",
        "End session and restore starting branch",
        "Recovery through the recorded bisect state.",
      ),
    ]);
    if (choice === undefined) return;
    if (choice.id === "start") {
      const badCommit = await this.input(
        "Known bad commit",
        "Exact bad commit; leave empty for current HEAD",
        "HEAD",
      );
      if (badCommit === undefined) return;
      const goodCommitText = await this.input(
        "Known good commits",
        "Comma-separated exact good commits",
        "HEAD~10",
      );
      if (goodCommitText === undefined) return;
      const goodCommits = goodCommitText
        .split(",")
        .map((commit) => commit.trim())
        .filter((commit) => commit.length > 0);
      if (goodCommits.length === 0) {
        await this.ui.showErrorMessage(
          "At least one known good commit is required.",
        );
        return;
      }
      await this.runOperation(
        repositoryRoot,
        (signal) =>
          this.dependencies.operations.previewBisectStart({
            repositoryRoot,
            expectedRepositoryRoot: repositoryRoot,
            ...(badCommit.length === 0 ? {} : { badCommit }),
            goodCommits,
            cancellationSignal: signal,
          }),
        { progressTitle: "Preparing bisect start preview" },
      );
      return;
    }
    const commitish =
      choice.id === "reset"
        ? await this.input(
            "Restore ref",
            "Optional exact ref; leave empty for Git default",
            "",
          )
        : await this.input(
            "Candidate commit",
            "Optional exact commit; leave empty for current candidate",
            "HEAD",
          );
    if (commitish === undefined) return;
    const previewMethod =
      choice.id === "good"
        ? "previewBisectGood"
        : choice.id === "bad"
          ? "previewBisectBad"
          : choice.id === "skip"
            ? "previewBisectSkip"
            : "previewBisectReset";
    await this.runOperation(
      repositoryRoot,
      (signal) =>
        this.dependencies.operations[previewMethod]({
          repositoryRoot,
          expectedRepositoryRoot: repositoryRoot,
          ...(commitish.length === 0 ? {} : { commitish }),
          cancellationSignal: signal,
        }),
      { progressTitle: `Preparing bisect ${choice.id} preview` },
    );
  }

  private async openReflog(repositoryRoot: string): Promise<void> {
    const choice = await this.pickSubtask("Reflog and recovery", [
      choiceItem(
        "list",
        "Inspect reflog",
        "Read exact prior HEAD refs",
        "Read-only; no mutation.",
      ),
      choiceItem(
        "recover",
        "Recover commit",
        "Reset HEAD to a reflog target",
        "Mode controls index/worktree impact; preview shows recovery route.",
      ),
    ]);
    if (choice === undefined) return;
    if (choice.id === "list") {
      const refName = await this.input(
        "Reflog ref",
        "Leave empty for HEAD",
        "HEAD",
      );
      if (refName === undefined) return;
      const limitText = await this.input("Entry limit", "1 to 10000", "100");
      if (limitText === undefined) return;
      const limit = Number.parseInt(limitText, 10);
      if (!Number.isInteger(limit)) {
        await this.ui.showErrorMessage("Entry limit must be a whole number.");
        return;
      }
      await this.runOperation(
        repositoryRoot,
        (signal) =>
          this.dependencies.operations.previewReflogList({
            repositoryRoot,
            expectedRepositoryRoot: repositoryRoot,
            ...(refName.length === 0 ? {} : { refName }),
            limit,
            cancellationSignal: signal,
          }),
        { progressTitle: "Reading reflog", readOnly: true },
      );
      return;
    }
    const target = await this.input(
      "Recovery target",
      "Exact commit or reflog selector",
      "HEAD@{1}",
    );
    if (target === undefined) return;
    const mode = await this.pickValue("Recovery reset mode", [
      choiceItem("soft", "Soft", "Move HEAD only", "Index and worktree stay."),
      choiceItem(
        "mixed",
        "Mixed",
        "Move HEAD and reset index",
        "Files stay on disk.",
      ),
      choiceItem(
        "hard",
        "Hard",
        "Move HEAD and tracked files",
        "High impact; reflog is the recovery route.",
      ),
    ]);
    if (mode === undefined) return;
    await this.runOperation(
      repositoryRoot,
      (signal) =>
        this.dependencies.operations.previewReflogRecover({
          repositoryRoot,
          expectedRepositoryRoot: repositoryRoot,
          target,
          mode: mode.id as "soft" | "mixed" | "hard",
          cancellationSignal: signal,
        }),
      { progressTitle: "Preparing reflog recovery preview" },
    );
  }

  private async openClean(repositoryRoot: string): Promise<void> {
    const directoryChoice = await this.pickValue(
      "Include untracked directories?",
      [
        choiceItem(
          "yes",
          "Include directories",
          "Show directory candidates",
          "Directory deletion is irreversible.",
        ),
        choiceItem(
          "no",
          "Files only",
          "Leave directories intact",
          "Narrower preview.",
        ),
      ],
    );
    if (directoryChoice === undefined) return;
    const includeDirectories = directoryChoice.id === "yes";
    const ignoredChoice = await this.pickValue("Include ignored files?", [
      choiceItem(
        "yes",
        "Include ignored",
        "Show ignored candidates",
        "High impact; exact files shown.",
      ),
      choiceItem(
        "no",
        "Tracked rules only",
        "Do not include ignored",
        "Safer candidate set.",
      ),
    ]);
    if (ignoredChoice === undefined) return;
    const includeIgnored = ignoredChoice.id === "yes";
    const preview = await this.preparePreview(
      (signal) =>
        this.dependencies.operations.previewClean({
          repositoryRoot,
          expectedRepositoryRoot: repositoryRoot,
          includeDirectories,
          includeIgnored,
          cancellationSignal: signal,
        }),
      "Preparing clean candidate preview",
    );
    if (preview === undefined) return;
    const candidateResult = await this.executeReadOnly(
      repositoryRoot,
      preview,
      "Reading clean candidates",
    );
    if (candidateResult === undefined) return;
    const candidateOutput = candidateResult.standardOutput.trim();
    const candidatePreview = formatOperationPreview(
      preview,
      candidateOutput.length === 0 ? "No candidates." : candidateOutput,
    );
    await this.ui.showPreviewDocument({
      title: "Git'o clean candidate preview",
      content: candidatePreview,
    });
    const selected = await this.ui.showWarningMessage(
      boundConfirmationText(
        `${formatOperationConfirmationSummary(preview)}\n\nPreview is read-only. Continue to a fresh clean execution preview?`,
      ),
      { modal: true },
      "Review removal",
      "Cancel",
    );
    if (selected !== "Review removal") return;
    await this.runOperation(
      repositoryRoot,
      (signal) =>
        this.dependencies.operations.previewCleanExecute({
          repositoryRoot,
          expectedRepositoryRoot: repositoryRoot,
          includeDirectories,
          includeIgnored,
          ...(preview.cleanCandidates === undefined
            ? {}
            : { candidatePaths: preview.cleanCandidates }),
          cancellationSignal: signal,
        }),
      { progressTitle: "Preparing clean removal preview" },
    );
  }

  private async runActiveOperationAction(
    repositoryRoot: string,
    action: "continue" | "skip" | "abort",
    stateBanner: OperationsStateBanner | undefined,
  ): Promise<void> {
    const activeOperation = stateBanner?.operation;
    if (activeOperation === undefined) {
      await this.ui.showInformationMessage(
        "No paused Git operation is active. Refresh Operations Center state.",
      );
      return;
    }
    if (action === "skip" && activeOperation !== "rebase") {
      await this.ui.showInformationMessage(
        "Skip is valid only for an active rebase.",
      );
      return;
    }
    const previewMethod =
      activeOperation === "rebase"
        ? action === "continue"
          ? "previewRebaseContinue"
          : action === "skip"
            ? "previewRebaseSkip"
            : "previewRebaseAbort"
        : (`${activeOperation}.${action}` as
            | "merge.continue"
            | "merge.abort"
            | "cherry-pick.continue"
            | "cherry-pick.abort"
            | "revert.continue"
            | "revert.abort");
    const previewServiceMethod =
      previewMethod === "merge.continue"
        ? "previewMergeContinue"
        : previewMethod === "merge.abort"
          ? "previewMergeAbort"
          : previewMethod === "cherry-pick.continue"
            ? "previewCherryPickContinue"
            : previewMethod === "cherry-pick.abort"
              ? "previewCherryPickAbort"
              : previewMethod === "revert.continue"
                ? "previewRevertContinue"
                : previewMethod === "revert.abort"
                  ? "previewRevertAbort"
                  : previewMethod;
    await this.runOperation(
      repositoryRoot,
      (signal) =>
        this.dependencies.operations[previewServiceMethod]({
          repositoryRoot,
          expectedRepositoryRoot: repositoryRoot,
          cancellationSignal: signal,
        }),
      {
        progressTitle: `Preparing ${capitalizeWords(activeOperation)} ${action} preview`,
      },
    );
  }

  private async runOperation(
    repositoryRoot: string,
    previewFactory: PreviewFactory,
    options: OperationRunOptions,
  ): Promise<GitOperationResult | undefined> {
    const preview = await this.preparePreview(
      previewFactory,
      options.progressTitle,
    );
    if (preview === undefined) return undefined;
    if (options.readOnly === true || !preview.destructive)
      return this.executeReadOnly(
        repositoryRoot,
        preview,
        options.progressTitle,
      );
    await this.ui.showPreviewDocument({
      title: `Git'o ${preview.operation} exact preview`,
      content: formatOperationPreview(preview, options.extraPreviewText),
    });
    const riskReadout = buildOperationRiskReadout(preview);
    const confirmationText = boundConfirmationText(
      `${formatOperationConfirmationSummary(preview)}\n\nImpact: ${riskReadout.impact}`,
    );
    const selectedLabel = await this.ui.showWarningMessage(
      confirmationText,
      { modal: true },
      confirmLabel,
      "Cancel",
    );
    if (selectedLabel !== confirmLabel) return undefined;
    const result = await this.executeAfterFreshRepositoryCheck(
      repositoryRoot,
      preview,
      options.progressTitle,
    );
    await this.ui.showInformationMessage(formatOperationResult(result));
    return result;
  }

  private async preparePreview(
    previewFactory: PreviewFactory,
    progressTitle: string,
  ): Promise<GitOperationPreview | undefined> {
    return this.ui.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: progressTitle,
        cancellable: true,
      },
      async (_progress, cancellationToken) => {
        const cancellation = cancellationSignalFromToken(cancellationToken);
        try {
          return await previewFactory(cancellation.signal);
        } catch (error: unknown) {
          if (isAbortError(error)) return undefined;
          throw error;
        } finally {
          cancellation.dispose();
        }
      },
    );
  }

  private async executeReadOnly(
    repositoryRoot: string,
    preview: GitOperationPreview,
    progressTitle: string,
  ): Promise<GitOperationResult | undefined> {
    try {
      const result = await this.executeAfterFreshRepositoryCheck(
        repositoryRoot,
        preview,
        progressTitle,
      );
      if (result !== undefined)
        await this.ui.showInformationMessage(formatOperationResult(result));
      return result;
    } catch (error: unknown) {
      if (isAbortError(error)) return undefined;
      throw error;
    }
  }

  private async executeAfterFreshRepositoryCheck(
    repositoryRoot: string,
    preview: GitOperationPreview,
    progressTitle: string,
  ): Promise<GitOperationResult> {
    const currentlySelectedRoot =
      await this.dependencies.repositoryProvider.getRepositoryRoot();
    if (
      currentlySelectedRoot !== repositoryRoot ||
      currentlySelectedRoot !== preview.repositoryRoot
    ) {
      throw new Error(
        "Repository selection became stale after preview; no Git command was run. Reopen Operations Center.",
      );
    }
    return this.ui.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Running ${progressTitle.replace("Preparing ", "")}`,
        cancellable: true,
      },
      async (_progress, cancellationToken) => {
        const cancellation = cancellationSignalFromToken(cancellationToken);
        try {
          const executeWithCurrentCancellation =
            (): Promise<GitOperationResult> =>
              this.dependencies.operations.execute(
                preview,
                this.dependencies.operations.createConfirmation(preview),
                cancellation.signal,
              );
          return await this.dependencies.workspaceTrustGuard.runTrustedMutation(
            `execute ${preview.operation}`,
            executeWithCurrentCancellation,
          );
        } finally {
          cancellation.dispose();
        }
      },
    );
  }

  private async pickSubtask(
    title: string,
    choices: readonly OperationChoice[],
  ): Promise<OperationChoice | undefined> {
    return this.pickValue(title, choices);
  }

  private async pickValue(
    title: string,
    choices: readonly OperationChoice[],
  ): Promise<OperationChoice | undefined> {
    const selectedItem = await this.ui.showQuickPick(choices, {
      title,
      placeHolder: "Choose one; Escape cancels.",
      ignoreFocusOut: true,
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (selectedItem === undefined || Array.isArray(selectedItem))
      return undefined;
    return selectedItem as OperationChoice;
  }

  private async input(
    title: string,
    prompt: string,
    placeHolder: string,
  ): Promise<string | undefined> {
    return this.ui.showInputBox({
      title,
      prompt,
      placeHolder,
      ignoreFocusOut: true,
    });
  }

  private async reportError(error: unknown): Promise<void> {
    if (isAbortError(error)) return;
    const message = formatGitErrorForUser(error, "Operations Center failed.");
    await this.ui.showErrorMessage(message);
  }
}

export function registerOperationsExperienceCommands(
  commandRegistry: {
    registerCommand: (
      commandIdentifier: string,
      handler: (...argumentsPassed: readonly unknown[]) => unknown,
    ) => vscode.Disposable;
  },
  controller: OperationsExperienceController,
): readonly vscode.Disposable[] {
  return [
    commandRegistry.registerCommand(operationsExperienceCommandIds.open, () =>
      controller.open(),
    ),
  ];
}

export function createVscodeOperationsExperienceUi(): OperationsExperienceUi {
  return {
    isWorkspaceTrusted: () => vscode.workspace.isTrusted,
    showQuickPick: (items, options) =>
      Promise.resolve(vscode.window.showQuickPick(items, options)),
    showInputBox: (options) =>
      Promise.resolve(vscode.window.showInputBox(options)),
    showWarningMessage: (message, options, ...items) =>
      Promise.resolve(
        options === undefined
          ? vscode.window.showWarningMessage(message, ...items)
          : vscode.window.showWarningMessage(message, options, ...items),
      ),
    showInformationMessage: (message, options, ...items) =>
      Promise.resolve(
        options === undefined
          ? vscode.window.showInformationMessage(message, ...items)
          : vscode.window.showInformationMessage(message, options, ...items),
      ),
    showErrorMessage: (message) =>
      Promise.resolve(vscode.window.showErrorMessage(message)),
    showPreviewDocument: async ({ title, content }) => {
      const document = await vscode.workspace.openTextDocument({
        content,
        language: "text",
      });
      await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: true,
      });
      void title;
    },
    withProgress: (options, task) =>
      Promise.resolve(vscode.window.withProgress(options, task)),
    executeCommand: (commandIdentifier, ...argumentsPassed) =>
      Promise.resolve(
        vscode.commands.executeCommand(commandIdentifier, ...argumentsPassed),
      ),
  };
}

function choiceItem(
  id: string,
  label: string,
  description: string,
  detail: string,
): OperationChoice {
  return { id, label, description, detail };
}

function capitalizeWords(value: string): string {
  if (value === "cherry-pick") return "Cherry-pick";
  return value
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function cancellationSignalFromToken(
  cancellationToken: vscode.CancellationToken,
): { readonly signal: AbortSignal; dispose(): void } {
  const cancellationController = new AbortController();
  const cancellationSubscription = cancellationToken.onCancellationRequested(
    () => cancellationController.abort(),
  );
  if (cancellationToken.isCancellationRequested) cancellationController.abort();
  return {
    signal: cancellationController.signal,
    dispose: () => {
      cancellationSubscription.dispose();
      cancellationController.abort();
    },
  };
}
