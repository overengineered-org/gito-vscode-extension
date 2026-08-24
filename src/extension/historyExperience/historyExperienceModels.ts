import type * as vscode from "vscode";
import type {
  BlameLine,
  FileHistoryPage,
  GitRevisionResource,
  HistoryCommit,
  HistoryQuery,
  HistoryQueryResult,
  HistoryRepositoryRoot,
  LineHistoryEntry,
  ContributorsSnapshot,
  RevisionNavigationPlan,
} from "../history/index.js";

export type { HistoryRepositoryRoot } from "../history/index.js";

/** Commands owned by the native history experience. */
export const historyExperienceCommandIds = {
  toggleBlame: "gito.history.toggleBlame",
  openFileHistory: "gito.history.openFileHistory",
  openLineHistory: "gito.history.openLineHistory",
  openContributors: "gito.history.openContributors",
  search: "gito.history.search",
  previousRevision: "gito.history.previousRevision",
  nextRevision: "gito.history.nextRevision",
  openCommit: "gito.history.openCommit",
} as const;

export interface HistoryExperienceSettings {
  /** Master switch. All decoration/lens work is off unless explicitly enabled. */
  readonly enabled: boolean;
  /** Current-line blame decoration and status item. */
  readonly blameEnabled: boolean;
  /** Recent-change CodeLens. */
  readonly codeLensEnabled: boolean;
  /** Maximum approximate UTF-16 bytes inspected from an editor. */
  readonly maxFileSizeBytes: number;
  /** Maximum entries retained in the in-memory history cache. */
  readonly cacheEntryLimit: number;
}

export const defaultHistoryExperienceSettings: HistoryExperienceSettings = {
  enabled: false,
  blameEnabled: false,
  codeLensEnabled: false,
  maxFileSizeBytes: 1_000_000,
  cacheEntryLimit: 64,
};

export const historyExperienceSettingKeys = {
  enabled: "history.enabled",
  blameEnabled: "history.blame.enabled",
  codeLensEnabled: "history.codeLens.enabled",
  maxFileSizeBytes: "history.maxFileSizeBytes",
  cacheEntryLimit: "history.cacheEntryLimit",
} as const;

export interface HistoryExperienceRepositoryContext {
  readonly documentUri: vscode.Uri;
  readonly activeEditorUri?: vscode.Uri;
}

export interface HistoryExperienceRepositoryProvider {
  resolveRepositoryRoot(
    context: HistoryExperienceRepositoryContext,
  ): Promise<HistoryRepositoryRoot | undefined>;
  /** Optional canonical-root check for command arguments and revision URIs. */
  isRepositoryRootAuthorized?(
    repositoryRoot: HistoryRepositoryRoot,
    documentUri?: vscode.Uri,
  ): Promise<boolean>;
  /** Opaque token changes when the selected repository closes/reopens. */
  getRepositoryIdentity?(
    repositoryRoot: HistoryRepositoryRoot,
  ): Promise<string | undefined>;
  watchRepositoryChanges?(onRepositoryChanged: () => void): vscode.Disposable;
  /** Fires for index/worktree/HEAD changes while a repository remains open. */
  watchRepositoryStateChanges?(
    onRepositoryStateChanged: (repositoryRoot: HistoryRepositoryRoot) => void,
  ): vscode.Disposable;
}

export interface HistoryExperienceHistoryService {
  /** Atomically validates a revision and returns its pinned canonical resource. */
  getRevisionResource?(
    repositoryRoot: HistoryRepositoryRoot,
    revisionSha: string,
    filePath: string,
    cancellationSignal?: AbortSignal,
  ): Promise<GitRevisionResource | undefined>;
  hasRevision?(
    repositoryRoot: HistoryRepositoryRoot,
    revisionSha: string,
    cancellationSignal?: AbortSignal,
  ): Promise<boolean>;
  getBlame(
    repositoryRoot: HistoryRepositoryRoot,
    filePath: string,
    options?: {
      readonly revision?: string;
      readonly range?: { readonly startLine: number; readonly endLine: number };
      readonly cancellationSignal?: AbortSignal;
    },
  ): Promise<readonly BlameLine[]>;
  listFileHistory(
    repositoryRoot: HistoryRepositoryRoot,
    filePath: string,
    options?: {
      readonly revision?: string;
      readonly maxEntries?: number;
      readonly cancellationSignal?: AbortSignal;
    },
  ): Promise<FileHistoryPage>;
  listLineHistory(
    repositoryRoot: HistoryRepositoryRoot,
    filePath: string,
    lineNumber: number,
    options?: {
      readonly revision?: string;
      readonly maxEntries?: number;
      readonly cancellationSignal?: AbortSignal;
    },
  ): Promise<readonly LineHistoryEntry[]>;
  aggregateContributors(
    repositoryRoot: HistoryRepositoryRoot,
    options?: {
      readonly revision?: string;
      readonly maxEntries?: number;
      readonly cancellationSignal?: AbortSignal;
    },
  ): Promise<ContributorsSnapshot>;
  search(
    repositoryRoot: HistoryRepositoryRoot,
    query: HistoryQuery,
    cancellationSignal?: AbortSignal,
  ): Promise<HistoryQueryResult>;
  getRevisionNavigation(
    repositoryRoot: HistoryRepositoryRoot,
    revisionSha: string,
    filePath: string,
    parentSha?: string,
    cancellationSignal?: AbortSignal,
  ): Promise<RevisionNavigationPlan>;
}

export interface HistoryExperienceDependencies {
  readonly historyService: HistoryExperienceHistoryService;
  readonly repositoryProvider: HistoryExperienceRepositoryProvider;
  readonly readSettings?: () => Partial<HistoryExperienceSettings>;
}

export interface HistoryRevisionCommandArguments {
  readonly repositoryRoot?: HistoryRepositoryRoot;
  readonly revisionSha: string;
  readonly filePath: string;
  readonly parentSha?: string;
}

export interface HistoryCommitCommandArguments {
  readonly repositoryRoot?: HistoryRepositoryRoot;
  readonly commit: HistoryCommit;
  readonly filePath?: string;
  readonly revisionFilePath?: string;
}

export interface HistoryFileCommandArguments {
  readonly repositoryRoot?: HistoryRepositoryRoot;
  readonly filePath: string;
}

export interface HistoryLineCommandArguments {
  readonly repositoryRoot?: HistoryRepositoryRoot;
  readonly filePath: string;
  readonly lineNumber: number;
  readonly revision?: string;
}

export interface HistoryQueryChip {
  readonly field: HistoryQuery["terms"][number]["field"];
  readonly value: string;
  readonly label: string;
}

export interface HistoryExperienceCommandRegistry {
  registerCommand(
    commandIdentifier: string,
    handler: (...argumentsPassed: readonly unknown[]) => unknown,
  ): vscode.Disposable;
}
