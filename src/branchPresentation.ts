import type { BranchAvailability } from "./gitModel.ts";

export interface BranchPresentation {
  readonly colorId?: string;
  readonly description: string;
  readonly iconId: string;
  readonly tooltip: string;
}

export function createBranchPresentation(
  branchAvailability: BranchAvailability,
): BranchPresentation {
  if (branchAvailability.isCurrent) {
    return createCurrentBranchPresentation(branchAvailability);
  }
  if (branchAvailability.location === "remoteTracking") {
    return branchAvailability.availableLocally
      ? {
          description: "Also local",
          iconId: "cloud",
          tooltip: "This remote-tracking branch has a same-named local branch.",
        }
      : {
          colorId: "charts.blue",
          description: "Remote only",
          iconId: "cloud",
          tooltip: "This branch exists on the remote but not locally, based on fetched refs.",
        };
  }
  return branchAvailability.availableRemotely
    ? {
        description: "Also on remote",
        iconId: "git-branch",
        tooltip: "A same-named remote-tracking branch exists. Checkout it to see ahead/behind status.",
      }
    : {
        colorId: "charts.yellow",
        description: "Local only",
        iconId: "device-desktop",
        tooltip: "This branch exists locally but not on any known remote, based on fetched refs.",
      };
}

function createCurrentBranchPresentation(
  branchAvailability: BranchAvailability,
): BranchPresentation {
  const commitsAhead = branchAvailability.reference.ahead ?? 0;
  const commitsBehind = branchAvailability.reference.behind ?? 0;
  switch (branchAvailability.currentSyncStatus) {
    case "synced":
      return {
        colorId: "charts.green",
        description: "Current · Synced",
        iconId: "pass-filled",
        tooltip: "Current branch matches its upstream, based on the latest fetched refs.",
      };
    case "ahead":
      return {
        colorId: "charts.purple",
        description: `Current · ${formatCommitCount(commitsAhead, "ahead")}`,
        iconId: "arrow-up",
        tooltip: `Current branch is ${formatCommitCount(commitsAhead, "ahead of its upstream")}.`,
      };
    case "behind":
      return {
        colorId: "charts.yellow",
        description: `Current · ${formatCommitCount(commitsBehind, "behind")}`,
        iconId: "arrow-down",
        tooltip: `Current branch is ${formatCommitCount(commitsBehind, "behind its upstream")}. Fetch to refresh this status.`,
      };
    case "diverged":
      return {
        colorId: "charts.red",
        description: `Current · ${commitsAhead} ahead · ${commitsBehind} behind`,
        iconId: "warning",
        tooltip: `Current branch has diverged from its upstream: ${formatCommitCount(commitsAhead, "ahead")} and ${formatCommitCount(commitsBehind, "behind")}.`,
      };
    case "notTracking":
      return {
        colorId: "charts.yellow",
        description: "Current · No upstream",
        iconId: "circle-large-outline",
        tooltip: "Current branch does not track a remote branch.",
      };
    case "unknown":
    default:
      return {
        description: "Current · Status unknown",
        iconId: "question",
        tooltip: "Current branch has an upstream, but ahead/behind status is unavailable. Fetch to refresh.",
      };
  }
}

function formatCommitCount(commitCount: number, statusLabel: string): string {
  return `${commitCount} ${commitCount === 1 ? "commit" : "commits"} ${statusLabel}`;
}
