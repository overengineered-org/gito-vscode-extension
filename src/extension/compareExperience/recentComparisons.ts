import type {
  CompareExperienceSelection,
  CompareExperienceWorkspaceState,
  SerializableCompareSelection,
} from "./compareExperienceModels.js";
import { createRecentComparison } from "./compareExperiencePlans.js";
import { compareExperienceStorageKeys } from "./compareExperienceModels.js";

/** Workspace-local history. It never writes Git or global state. */
export class RecentComparisonsStore {
  public constructor(
    private readonly workspaceState: CompareExperienceWorkspaceState,
    private readonly maximumEntries = 10,
    private readonly repositoryIdentity?: string,
  ) {
    if (!Number.isInteger(maximumEntries) || maximumEntries < 1) {
      throw new RangeError("maximumEntries must be a positive integer.");
    }
  }

  public read(): readonly SerializableCompareSelection[] {
    const storedEntries = this.workspaceState.get<unknown>(
      compareExperienceStorageKeys.recentComparisons,
    );
    if (!Array.isArray(storedEntries)) return [];
    const normalizedEntries = storedEntries
      .filter(isSerializableCompareSelection)
      .sort((left, right) => right.savedAt - left.savedAt)
      .slice(0, this.maximumEntries);
    const visibleEntries = normalizedEntries.filter(
      (entry) =>
        this.repositoryIdentity === undefined ||
        entry.gitDirectoryIdentity === this.repositoryIdentity,
    );
    if (
      this.repositoryIdentity !== undefined &&
      visibleEntries.length !== normalizedEntries.length
    ) {
      void this.workspaceState.update(
        compareExperienceStorageKeys.recentComparisons,
        visibleEntries.length === 0 ? undefined : visibleEntries,
      );
    }
    return visibleEntries;
  }

  public async remember(
    selection: CompareExperienceSelection,
    savedAt = Date.now(),
    gitDirectoryIdentity = this.repositoryIdentity ??
      selection.repositoryRoot.fsPath,
  ): Promise<readonly SerializableCompareSelection[]> {
    const comparison = createRecentComparison(
      selection,
      savedAt,
      gitDirectoryIdentity,
    );
    const identity = comparisonIdentity(comparison);
    const nextEntries = [
      comparison,
      ...this.readAll().filter(
        (entry) => comparisonIdentity(entry) !== identity,
      ),
    ].slice(0, this.maximumEntries);
    await this.workspaceState.update(
      compareExperienceStorageKeys.recentComparisons,
      nextEntries,
    );
    return this.repositoryIdentity === undefined
      ? nextEntries
      : nextEntries.filter(
          (entry) => entry.gitDirectoryIdentity === this.repositoryIdentity,
        );
  }

  public async clear(): Promise<void> {
    await this.workspaceState.update(
      compareExperienceStorageKeys.recentComparisons,
      undefined,
    );
  }

  /** Remove entries whose Git directory no longer belongs to the active repo. */
  public async purgeExcept(
    gitDirectoryIdentity: string,
  ): Promise<readonly SerializableCompareSelection[]> {
    const retainedEntries = this.readAll().filter(
      (entry) => entry.gitDirectoryIdentity === gitDirectoryIdentity,
    );
    await this.workspaceState.update(
      compareExperienceStorageKeys.recentComparisons,
      retainedEntries.length === 0 ? undefined : retainedEntries,
    );
    return retainedEntries;
  }

  /** Remove only entries whose visible path is reused by another Git repo. */
  public async purgeStaleRepositoryPath(
    repositoryRoot: string,
    gitDirectoryIdentity: string,
  ): Promise<readonly SerializableCompareSelection[]> {
    const retainedEntries = this.readAll().filter(
      (entry) =>
        entry.repositoryRoot !== repositoryRoot ||
        entry.gitDirectoryIdentity === gitDirectoryIdentity,
    );
    await this.workspaceState.update(
      compareExperienceStorageKeys.recentComparisons,
      retainedEntries.length === 0 ? undefined : retainedEntries,
    );
    return retainedEntries;
  }

  public async forget(
    comparisonToForget: SerializableCompareSelection,
  ): Promise<readonly SerializableCompareSelection[]> {
    const retainedEntries = this.readAll().filter(
      (entry) =>
        comparisonIdentity(entry) !== comparisonIdentity(comparisonToForget),
    );
    await this.workspaceState.update(
      compareExperienceStorageKeys.recentComparisons,
      retainedEntries.length === 0 ? undefined : retainedEntries,
    );
    return retainedEntries;
  }

  private readAll(): readonly SerializableCompareSelection[] {
    const storedEntries = this.workspaceState.get<unknown>(
      compareExperienceStorageKeys.recentComparisons,
    );
    if (!Array.isArray(storedEntries)) return [];
    return storedEntries
      .filter(isSerializableCompareSelection)
      .sort((left, right) => right.savedAt - left.savedAt)
      .slice(0, this.maximumEntries);
  }
}

function comparisonIdentity(comparison: SerializableCompareSelection): string {
  return JSON.stringify({
    repositoryRoot: comparison.repositoryRoot,
    gitDirectoryIdentity: comparison.gitDirectoryIdentity,
    left: comparison.left,
    right: comparison.right,
    mode: comparison.mode,
  });
}

function isSerializableCompareSelection(
  value: unknown,
): value is SerializableCompareSelection {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SerializableCompareSelection>;
  if (
    candidate.version !== 2 ||
    typeof candidate.repositoryRoot !== "string" ||
    typeof candidate.gitDirectoryIdentity !== "string" ||
    (candidate.mode !== "common-base" && candidate.mode !== "direct") ||
    typeof candidate.savedAt !== "number"
  ) {
    return false;
  }
  return isCompareTarget(candidate.left) && isCompareTarget(candidate.right);
}

function isCompareTarget(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CompareExperienceSelection["left"]>;
  if (candidate.kind === "ref") return typeof candidate.ref === "string";
  return (
    candidate.kind === "upstream" ||
    candidate.kind === "working" ||
    candidate.kind === "index"
  );
}
