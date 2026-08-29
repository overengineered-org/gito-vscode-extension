import type { BranchAvailability } from "./gitModel.ts";
import { gitThemeColorIds } from "./gitTheme.ts";

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
          colorId: gitThemeColorIds.remoteOnly,
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
        colorId: gitThemeColorIds.localOnly,
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
  const upstreamReferenceName = formatUpstreamReferenceName(
    branchAvailability.reference.upstream,
  );
  switch (branchAvailability.currentSyncStatus) {
    case "synced":
      return {
        colorId: gitThemeColorIds.clean,
        description: `Current · Synced with ${upstreamReferenceName}`,
        iconId: "pass-filled",
        tooltip: `Current branch matches ${upstreamReferenceName}, based on the latest fetched refs.`,
      };
    case "ahead":
      return {
        colorId: gitThemeColorIds.ahead,
        description: `Current · ${formatCommitCount(commitsAhead, `ahead of ${upstreamReferenceName}`)}`,
        iconId: "arrow-up",
        tooltip: `Current branch is ${formatCommitCount(commitsAhead, `ahead of ${upstreamReferenceName}`)}.`,
      };
    case "behind":
      return {
        colorId: gitThemeColorIds.behind,
        description: `Current · ${formatCommitCount(commitsBehind, `behind ${upstreamReferenceName}`)}`,
        iconId: "arrow-down",
        tooltip: `Current branch is ${formatCommitCount(commitsBehind, `behind ${upstreamReferenceName}`)}. Fetch to refresh this status.`,
      };
    case "diverged":
      return {
        colorId: gitThemeColorIds.diverged,
        description: `Current · ${commitsAhead} ahead · ${commitsBehind} behind ${upstreamReferenceName}`,
        iconId: "warning",
        tooltip: `Current branch has diverged from ${upstreamReferenceName}: ${formatCommitCount(commitsAhead, "ahead")} and ${formatCommitCount(commitsBehind, "behind")}.`,
      };
    case "notTracking":
      return {
        colorId: gitThemeColorIds.localOnly,
        description: "Current · No upstream",
        iconId: "circle-large-outline",
        tooltip: "Current branch does not track a remote branch.",
      };
    case "unknown":
    default:
      return {
        description: `Current · Status against ${upstreamReferenceName} unknown`,
        iconId: "question",
        tooltip: `Ahead/behind status against ${upstreamReferenceName} is unavailable. Fetch to refresh.`,
      };
  }
}

function formatUpstreamReferenceName(
  upstreamReference: BranchAvailability["reference"]["upstream"],
): string {
  if (upstreamReference === undefined) {
    return "upstream";
  }
  return upstreamReference.name.startsWith(`${upstreamReference.remote}/`)
    ? upstreamReference.name
    : `${upstreamReference.remote}/${upstreamReference.name}`;
}

function formatCommitCount(commitCount: number, statusLabel: string): string {
  return `${commitCount} ${commitCount === 1 ? "commit" : "commits"} ${statusLabel}`;
}
