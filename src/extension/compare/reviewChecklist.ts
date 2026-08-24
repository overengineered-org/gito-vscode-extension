import type {
  CompareMode,
  CompareTarget,
  ResolvedCompareTarget,
} from "./compareModels.js";

export interface WorkspaceStateStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export interface ReviewChecklistItem {
  readonly id: string;
  readonly label: string;
}

export interface ReviewChecklistState {
  readonly checkedItemIds: readonly string[];
  readonly notes: string;
}

export interface ReviewChecklistIdentity {
  readonly repositoryRootPath: string;
  readonly mode: CompareMode;
  readonly left: CompareTarget | ResolvedCompareTarget;
  readonly right: CompareTarget | ResolvedCompareTarget;
}

export const defaultReviewChecklistItems: readonly ReviewChecklistItem[] = [
  { id: "files-reviewed", label: "Changed files reviewed" },
  { id: "tests-considered", label: "Tests and validation considered" },
  { id: "risk-noted", label: "Risk and follow-up noted" },
  { id: "ready-to-merge", label: "Ready to merge" },
];

/**
 * Review state intentionally depends on WorkspaceState only. It never reads
 * globalState and never writes Git, remotes, or provider data.
 */
export class WorkspaceReviewChecklistStore {
  private readonly storageKey: string;
  private readonly allowedItemIds: ReadonlySet<string>;

  public constructor(
    private readonly workspaceState: WorkspaceStateStore,
    identity: ReviewChecklistIdentity,
    checklistItems: readonly ReviewChecklistItem[] = defaultReviewChecklistItems,
  ) {
    this.storageKey = createReviewChecklistStorageKey(identity);
    this.allowedItemIds = new Set(checklistItems.map((item) => item.id));
  }

  public get key(): string {
    return this.storageKey;
  }

  public read(): ReviewChecklistState {
    const storedState = this.workspaceState.get<Partial<ReviewChecklistState>>(
      this.storageKey,
    );
    const checkedItemIds = Array.isArray(storedState?.checkedItemIds)
      ? storedState.checkedItemIds.filter(
          (itemId): itemId is string =>
            typeof itemId === "string" && this.allowedItemIds.has(itemId),
        )
      : [];
    return {
      checkedItemIds: [...new Set(checkedItemIds)],
      notes: typeof storedState?.notes === "string" ? storedState.notes : "",
    };
  }

  public async setChecked(
    itemId: string,
    checked: boolean,
  ): Promise<ReviewChecklistState> {
    this.assertItemId(itemId);
    const currentState = this.read();
    const nextCheckedItemIds = new Set(currentState.checkedItemIds);
    if (checked) nextCheckedItemIds.add(itemId);
    else nextCheckedItemIds.delete(itemId);
    return this.write({
      ...currentState,
      checkedItemIds: [...nextCheckedItemIds].sort(),
    });
  }

  public async toggle(itemId: string): Promise<ReviewChecklistState> {
    const currentState = this.read();
    return this.setChecked(
      itemId,
      !currentState.checkedItemIds.includes(itemId),
    );
  }

  public async setNotes(notes: string): Promise<ReviewChecklistState> {
    if (typeof notes !== "string")
      throw new TypeError("Review notes must be text.");
    return this.write({ ...this.read(), notes });
  }

  public async clear(): Promise<void> {
    await this.workspaceState.update(this.storageKey, undefined);
  }

  private async write(
    state: ReviewChecklistState,
  ): Promise<ReviewChecklistState> {
    await this.workspaceState.update(this.storageKey, state);
    return state;
  }

  private assertItemId(itemId: string): void {
    if (!this.allowedItemIds.has(itemId)) {
      throw new Error(`Unknown review checklist item '${itemId}'.`);
    }
  }
}

export function createReviewChecklistStorageKey(
  identity: ReviewChecklistIdentity,
): string {
  const left = targetIdentity(identity.left);
  const right = targetIdentity(identity.right);
  return `gito.compare.review.${encodeURIComponent(
    JSON.stringify({
      repositoryRootPath: identity.repositoryRootPath,
      mode: identity.mode,
      left,
      right,
    }),
  )}`;
}

function targetIdentity(
  target: CompareTarget | ResolvedCompareTarget,
): unknown {
  if ("target" in target) {
    return {
      target: targetIdentity(target.target),
      ...(target.commitSha === undefined
        ? {}
        : { commitSha: target.commitSha }),
    };
  }
  return target;
}
