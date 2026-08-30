export const commitGraphActionIds = [
  "openCommit",
  "compareWithHead",
  "copyHash",
  "createBranch",
  "createTag",
  "checkoutDetached",
  "cherryPick",
  "rebaseCurrentBranchOnto",
  "revertCommit",
  "undoLastCommit",
] as const;

export type CommitGraphActionId = (typeof commitGraphActionIds)[number];

export interface CommitGraphActionState {
  readonly description: string;
  readonly disabledReason?: string;
  readonly id: CommitGraphActionId;
  readonly label: string;
  readonly section: "Create" | "Inspect" | "Rewrite";
}

export interface CommitGraphActionContext {
  readonly commitIsHead: boolean;
  readonly gitOperationInProgress: boolean;
  readonly workingTreeClean: boolean;
}

export function createCommitGraphActionStates(
  actionContext: CommitGraphActionContext,
): readonly CommitGraphActionState[] {
  const workingTreeBlock = actionContext.gitOperationInProgress
    ? "Finish the current Git operation first."
    : actionContext.workingTreeClean
      ? undefined
      : "Commit, stash, or discard working changes first.";
  const differentCommitBlock = actionContext.commitIsHead
    ? "Select a commit other than the current HEAD."
    : undefined;
  return [
    actionState("openCommit", "Open Commit Changes", "Inspect this commit in VS Code.", "Inspect"),
    actionState(
      "compareWithHead",
      "Compare with Current Branch",
      "Show commit and file differences without changing Git state.",
      "Inspect",
      differentCommitBlock,
    ),
    actionState("copyHash", "Copy Commit Hash", "Copy the full hash.", "Inspect"),
    actionState(
      "createBranch",
      "Create Branch Here",
      "Create a local branch pointing at this commit.",
      "Create",
    ),
    actionState(
      "createTag",
      "Create Local Tag Here",
      "Create a local lightweight tag pointing at this commit.",
      "Create",
    ),
    actionState(
      "checkoutDetached",
      "Inspect in Detached HEAD",
      "Check out this exact commit without moving a branch.",
      "Create",
      differentCommitBlock ?? workingTreeBlock,
    ),
    actionState(
      "cherryPick",
      "Apply Commit to Current Branch",
      "Cherry-pick this commit onto the current branch.",
      "Rewrite",
      differentCommitBlock ?? workingTreeBlock,
    ),
    actionState(
      "rebaseCurrentBranchOnto",
      "Move Current Branch onto This Commit",
      "Rebase current branch commits onto this commit.",
      "Rewrite",
      differentCommitBlock ?? workingTreeBlock,
    ),
    actionState(
      "revertCommit",
      "Create Reverting Commit",
      "Create a new commit that reverses this commit.",
      "Rewrite",
      workingTreeBlock,
    ),
    actionState(
      "undoLastCommit",
      "Undo Last Commit, Keep Changes",
      "Move HEAD back one commit and keep its changes staged.",
      "Rewrite",
      actionContext.commitIsHead
        ? workingTreeBlock
        : "Only the current HEAD commit can be undone.",
    ),
  ];
}

export function isCommitGraphActionId(candidateActionId: unknown): candidateActionId is CommitGraphActionId {
  return commitGraphActionIds.some((commitGraphActionId) => commitGraphActionId === candidateActionId);
}

function actionState(
  id: CommitGraphActionId,
  label: string,
  description: string,
  section: CommitGraphActionState["section"],
  disabledReason?: string,
): CommitGraphActionState {
  return {
    description,
    ...(disabledReason === undefined ? {} : { disabledReason }),
    id,
    label,
    section,
  };
}
