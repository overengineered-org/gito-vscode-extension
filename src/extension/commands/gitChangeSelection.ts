import type {
  LocalGitChange,
  LocalGitChangesSnapshot,
} from "../git/localGitModels.js";
import { gitStatus } from "../git/localGitModels.js";

export type LocalGitChangeAction = "stage" | "unstage" | "discard";

export function getCommandEligibleChanges(
  changesSnapshot: LocalGitChangesSnapshot,
  changeAction: LocalGitChangeAction,
): readonly LocalGitChange[] {
  if (changeAction === "stage") {
    return [
      ...changesSnapshot.mergeChanges.filter(
        (change) => change.status !== gitStatus.IGNORED,
      ),
      ...changesSnapshot.changes.filter(
        (change) => change.status !== gitStatus.IGNORED,
      ),
      ...changesSnapshot.untracked.filter(
        (change) => change.status !== gitStatus.IGNORED,
      ),
    ];
  }
  if (changeAction === "unstage") return changesSnapshot.stagedChanges;
  return [
    ...changesSnapshot.changes.filter(
      (change) => change.status !== gitStatus.IGNORED,
    ),
    ...changesSnapshot.untracked.filter(
      (change) => change.status !== gitStatus.IGNORED,
    ),
  ];
}
