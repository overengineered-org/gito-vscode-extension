export interface NativeGitAction {
  readonly availabilityRequirement:
    | "always"
    | "amendableCommit"
    | "stagedChanges"
    | "uncommittedChanges";
  readonly command: string;
  readonly description: string;
  readonly iconId: string;
  readonly label: string;
  readonly section: "Commit" | "Publish" | "Rewrite remote history";
}

export interface GitActionAvailability {
  readonly hasCommitMessage: boolean;
  readonly hasHeadCommit: boolean;
  readonly hasStagedChanges: boolean;
  readonly hasUncommittedChanges: boolean;
}

export const defaultCommitAction: NativeGitAction = {
  availabilityRequirement: "uncommittedChanges",
  command: "git.commit",
  description: "Commit using VS Code's current staging settings",
  iconId: "check",
  label: "Commit",
  section: "Commit",
};

export const nativeGitActions: readonly NativeGitAction[] = [
  defaultCommitAction,
  {
    availabilityRequirement: "stagedChanges",
    command: "git.commitStaged",
    description: "Commit staged changes only",
    iconId: "check-all",
    label: "Commit Staged",
    section: "Commit",
  },
  {
    availabilityRequirement: "uncommittedChanges",
    command: "git.commitAll",
    description: "Stage and commit every change",
    iconId: "files",
    label: "Commit All",
    section: "Commit",
  },
  {
    availabilityRequirement: "amendableCommit",
    command: "git.commitAmend",
    description: "Replace the latest local commit",
    iconId: "git-commit",
    label: "Amend Last Commit",
    section: "Commit",
  },
  {
    availabilityRequirement: "always",
    command: "git.push",
    description: "Push the current branch to its upstream",
    iconId: "repo-push",
    label: "Push Current Branch",
    section: "Publish",
  },
  {
    availabilityRequirement: "always",
    command: "git.pushTo",
    description: "Choose the remote and branch",
    iconId: "cloud-upload",
    label: "Push To…",
    section: "Publish",
  },
  {
    availabilityRequirement: "always",
    command: "git.pushWithTags",
    description: "Push the current branch and reachable annotated tags",
    iconId: "tag",
    label: "Push with Annotated Tags",
    section: "Publish",
  },
  {
    availabilityRequirement: "always",
    command: "git.pushTags",
    description: "Push every local tag",
    iconId: "tags",
    label: "Push All Tags",
    section: "Publish",
  },
  {
    availabilityRequirement: "always",
    command: "git.pushForce",
    description: "VS Code confirmation and force-push safety settings apply",
    iconId: "warning",
    label: "Force Push Current Branch…",
    section: "Rewrite remote history",
  },
  {
    availabilityRequirement: "always",
    command: "git.pushToForce",
    description: "Choose a target; VS Code force-push safety settings apply",
    iconId: "warning",
    label: "Force Push To…",
    section: "Rewrite remote history",
  },
] as const;

export function listAvailableNativeGitActions(
  gitActionAvailability: GitActionAvailability,
): readonly NativeGitAction[] {
  return nativeGitActions.filter((nativeGitAction) => {
    switch (nativeGitAction.availabilityRequirement) {
      case "always":
        return true;
      case "amendableCommit":
        return gitActionAvailability.hasCommitMessage && gitActionAvailability.hasHeadCommit;
      case "stagedChanges":
        return gitActionAvailability.hasCommitMessage && gitActionAvailability.hasStagedChanges;
      case "uncommittedChanges":
        return (
          gitActionAvailability.hasCommitMessage &&
          gitActionAvailability.hasUncommittedChanges
        );
    }
  });
}
