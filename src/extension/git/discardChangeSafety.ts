import type {
  LocalGitChange,
  LocalGitChangesSnapshot,
} from "./localGitModels.js";
import { gitStatus } from "./localGitModels.js";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

export interface DiscardChangeResolution {
  readonly eligibleChanges: readonly LocalGitChange[];
  readonly rejectedChanges: readonly LocalGitChange[];
}

export interface DiscardChangeFileBinding {
  readonly changeIdentity: string;
  readonly path: string;
  readonly exists: boolean;
  readonly kind?: "file" | "directory" | "symlink" | "other";
  readonly device?: string;
  readonly inode?: string;
  readonly size?: string;
  readonly modifiedAtMilliseconds?: string;
  readonly contentDigest?: string;
}

export function buildDiscardConfirmationMessage(
  eligibleChanges: readonly LocalGitChange[],
): string {
  return `Discard these changes? This cannot be undone.\n\n${eligibleChanges
    .map((change) => `• ${change.relativePath}`)
    .join("\n")}`;
}

/** Re-resolves caller selections against the repository's current discardable state. */
export function resolveDiscardChanges(
  currentChangesSnapshot: LocalGitChangesSnapshot,
  requestedChanges: readonly LocalGitChange[],
): DiscardChangeResolution {
  const eligibleChangeByResource = new Map<string, LocalGitChange>();
  for (const currentChange of [
    ...currentChangesSnapshot.changes.filter(
      (change) => change.status !== gitStatus.IGNORED,
    ),
    ...currentChangesSnapshot.untracked.filter(
      (change) => change.status !== gitStatus.IGNORED,
    ),
  ]) {
    eligibleChangeByResource.set(
      getChangeIdentity(currentChange),
      currentChange,
    );
  }

  const eligibleChanges: LocalGitChange[] = [];
  const rejectedChanges: LocalGitChange[] = [];
  const selectedChangeIds = new Set<string>();
  for (const requestedChange of requestedChanges) {
    const requestedChangeId = getChangeIdentity(requestedChange);
    const currentEligibleChange =
      requestedChange.group === "changes" ||
      requestedChange.group === "untracked"
        ? eligibleChangeByResource.get(requestedChangeId)
        : undefined;
    if (currentEligibleChange === undefined) {
      rejectedChanges.push(requestedChange);
      continue;
    }
    if (!selectedChangeIds.has(requestedChangeId)) {
      selectedChangeIds.add(requestedChangeId);
      eligibleChanges.push(currentEligibleChange);
    }
  }
  return { eligibleChanges, rejectedChanges };
}

/** Captures the selected file state so confirmation cannot authorize new bytes. */
export async function captureDiscardChangeFileBindings(
  changes: readonly LocalGitChange[],
): Promise<readonly DiscardChangeFileBinding[]> {
  const bindings: DiscardChangeFileBinding[] = [];
  for (const change of changes) {
    const filePath = change.resourceUri.fsPath;
    try {
      const fileStats = await lstat(filePath, { bigint: true });
      const kind = fileStats.isFile()
        ? "file"
        : fileStats.isDirectory()
          ? "directory"
          : fileStats.isSymbolicLink()
            ? "symlink"
            : "other";
      const contentDigest = fileStats.isFile()
        ? createHash("sha256")
        : undefined;
      let digest: string | undefined;
      if (contentDigest !== undefined) {
        contentDigest.update(await readFile(filePath));
        digest = contentDigest.digest("hex");
      }
      bindings.push({
        changeIdentity: getChangeIdentity(change),
        path: filePath,
        exists: true,
        kind,
        device: String(fileStats.dev),
        inode: String(fileStats.ino),
        size: String(fileStats.size),
        modifiedAtMilliseconds: String(fileStats.mtimeMs),
        ...(digest === undefined ? {} : { contentDigest: digest }),
      });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        bindings.push({
          changeIdentity: getChangeIdentity(change),
          path: filePath,
          exists: false,
        });
        continue;
      }
      throw error;
    }
  }
  return bindings;
}

export function discardChangeFileBindingsMatch(
  expectedBindings: readonly DiscardChangeFileBinding[],
  currentBindings: readonly DiscardChangeFileBinding[],
): boolean {
  if (expectedBindings.length !== currentBindings.length) return false;
  const currentByIdentity = new Map(
    currentBindings.map((binding) => [binding.changeIdentity, binding]),
  );
  return expectedBindings.every((expectedBinding) => {
    const currentBinding = currentByIdentity.get(
      expectedBinding.changeIdentity,
    );
    return (
      currentBinding !== undefined &&
      currentBinding.path === expectedBinding.path &&
      currentBinding.exists === expectedBinding.exists &&
      currentBinding.kind === expectedBinding.kind &&
      currentBinding.device === expectedBinding.device &&
      currentBinding.inode === expectedBinding.inode &&
      currentBinding.size === expectedBinding.size &&
      currentBinding.modifiedAtMilliseconds ===
        expectedBinding.modifiedAtMilliseconds &&
      currentBinding.contentDigest === expectedBinding.contentDigest
    );
  });
}

function getChangeIdentity(change: LocalGitChange): string {
  return (
    change.changeId ??
    `${change.group}\u0000${String(change.status)}\u0000${change.resourceUri.toString()}`
  );
}
