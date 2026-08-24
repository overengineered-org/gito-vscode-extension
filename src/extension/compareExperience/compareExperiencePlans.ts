import type {
  CompareCommit,
  CompareCommitFile,
  CompareFileChange,
  CompareFileCounts,
  CompareResult,
  CompareTarget,
  ResolvedCompareTarget,
} from "../compare/compareModels.js";
import {
  defaultReviewChecklistItems,
  type ReviewChecklistState,
} from "../compare/reviewChecklist.js";
import {
  parseSearchQuery,
  type SearchClause,
  type SearchQuery,
} from "../compare/searchDsl.js";
import {
  compareExperienceLabels,
  type CompareExperienceSelection,
  type CompareModeQuickPickItem,
  type CompareOpenPlan,
  type CompareReferenceQuickPickItem,
  type CompareSummary,
  type CompareSummaryMetric,
  type CompareSessionActionQuickPickItem,
  type SearchBuilderQuickPickItem,
  type SearchBuilderState,
  type SearchFieldOption,
  type SearchQueryChip,
  type SearchResultQuickPickItem,
  type SerializableCompareSelection,
} from "./compareExperienceModels.js";

/** Stable, keyboard-scannable reference choices. */
export function createCompareReferenceQuickPickItems(
  revisions: readonly string[] = [],
): readonly CompareReferenceQuickPickItem[] {
  const builtInItems: readonly CompareReferenceQuickPickItem[] = [
    {
      label: compareExperienceLabels.current,
      description: "HEAD — the commit checked out now",
      referenceKind: "current",
      target: { kind: "ref", ref: "HEAD" },
    },
    {
      label: compareExperienceLabels.upstream,
      description: "The configured tracking branch",
      referenceKind: "upstream",
      target: { kind: "upstream" },
    },
    {
      label: compareExperienceLabels.working,
      description: "Uncommitted changes on disk",
      referenceKind: "working",
      target: { kind: "working" },
    },
    {
      label: compareExperienceLabels.staged,
      description: "Changes currently in the index",
      referenceKind: "staged",
      target: { kind: "index" },
    },
    {
      label: compareExperienceLabels.revision,
      description: "Enter a branch, tag, or commit SHA",
      referenceKind: "revision",
    },
  ];
  const revisionItems = revisions
    .map((revision) => revision.trim())
    .filter(
      (revision, index, allRevisions) =>
        revision.length > 0 && allRevisions.indexOf(revision) === index,
    )
    .map((revision): CompareReferenceQuickPickItem => ({
      label: revision,
      description: "Git branch, tag, or commit",
      referenceKind: "revision",
      revision,
      target: { kind: "ref", ref: revision },
    }));
  return [...builtInItems, ...revisionItems];
}

export function targetForReferenceItem(
  item: CompareReferenceQuickPickItem,
  enteredRevision?: string,
): CompareTarget | undefined {
  if (item.target !== undefined) return item.target;
  const revision = (enteredRevision ?? item.revision)?.trim();
  return revision === undefined || revision.length === 0
    ? undefined
    : { kind: "ref", ref: revision };
}

export function createCompareModeQuickPickItems(): readonly CompareModeQuickPickItem[] {
  return [
    {
      label: compareExperienceLabels.commonBase,
      description:
        "Compare each side with their shared ancestor; best for diverged branches",
      detail:
        "Only changes made on either side since the merge-base are shown.",
      mode: "common-base",
    },
    {
      label: compareExperienceLabels.direct,
      description: "Compare the two selected endpoints exactly",
      detail: "Every difference between left and right is shown.",
      mode: "direct",
    },
  ];
}

export function describeCompareTarget(
  target: CompareTarget | ResolvedCompareTarget,
): string {
  const unresolvedTarget = "target" in target ? target.target : target;
  switch (unresolvedTarget.kind) {
    case "ref":
      return unresolvedTarget.ref === "HEAD"
        ? compareExperienceLabels.current
        : unresolvedTarget.ref;
    case "upstream":
      return compareExperienceLabels.upstream;
    case "working":
      return compareExperienceLabels.working;
    case "index":
      return compareExperienceLabels.staged;
  }
}

export function describeCompareMode(mode: CompareResult["mode"]): string {
  return mode === "common-base"
    ? "Common base: changes since the shared ancestor"
    : "Direct: exact endpoint-to-endpoint changes";
}

export function createCompareSummary(result: CompareResult): CompareSummary {
  const { fileCounts } = result;
  const metrics: CompareSummaryMetric[] = [
    { id: "ahead", label: "Ahead", value: result.aheadCount },
    { id: "behind", label: "Behind", value: result.behindCount },
    {
      id: "commits",
      label: "Commits",
      value: result.aheadCount + result.behindCount,
    },
    { id: "files", label: "Files", value: fileCounts.total },
    { id: "additions", label: "Additions", value: fileCounts.additions },
    { id: "deletions", label: "Deletions", value: fileCounts.deletions },
    { id: "renames", label: "Renames", value: fileCounts.renamed },
    { id: "binary", label: "Binary", value: fileCounts.binary },
  ];
  if ((fileCounts.submodules ?? 0) > 0) {
    metrics.push({
      id: "submodules",
      label: "Submodules",
      value: fileCounts.submodules ?? 0,
    });
  }
  if ((fileCounts.symlinks ?? 0) > 0) {
    metrics.push({
      id: "symlinks",
      label: "Symlinks",
      value: fileCounts.symlinks ?? 0,
    });
  }
  return {
    title: `${describeCompareTarget(result.left)} ↔ ${describeCompareTarget(result.right)}`,
    explanation: describeCompareMode(result.mode),
    metrics,
    truncated: result.truncated,
  };
}

export function formatCompareSummary(summary: CompareSummary): string {
  const metricText = summary.metrics
    .map((metric) => `${metric.label}: ${metric.value}`)
    .join(" · ");
  return `${summary.title} — ${summary.explanation}\n${metricText}${
    summary.truncated ? " · results capped" : ""
  }`;
}

/**
 * Bounded action hub for an active comparison. These actions are deliberately
 * absent when there is no session, so command-palette entries can use the same
 * session context without exposing dead commands.
 */
export function createCompareSessionActionItems(
  operationActive = false,
  sessionActive = true,
): readonly CompareSessionActionQuickPickItem[] {
  return [
    ...(sessionActive
      ? [
          {
            label: "Open all compared files",
            description: "Open all compared files together",
            action: "open-all" as const,
          },
          {
            label: "Swap comparison sides",
            description: "Reverse left/right and refresh the review",
            action: "swap-sides" as const,
          },
          {
            label: "Review checklist",
            description: "Check review items or edit notes",
            action: "checklist" as const,
          },
          {
            label: "Reset checklist",
            description: "Clear checked items and review notes",
            action: "reset-checklist" as const,
          },
        ]
      : []),
    ...(operationActive
      ? [
          {
            label: "Cancel current operation",
            description: "Stop compare or search work",
            action: "cancel" as const,
          },
        ]
      : []),
    { label: "Done", action: "done" as const },
  ];
}

/** Opens the comparison through VS Code's public changes command. */
export function createCompareOpenPlan(
  result: CompareResult,
  swapped = false,
): CompareOpenPlan {
  const displayResult = swapped ? invertCompareResult(result) : result;
  const summary = createCompareSummary(displayResult);
  const title = `${summary.title} — ${summary.explanation}`;
  const publicChangeEntries = displayResult.multiDiffPlan.resources.flatMap(
    (resource) => {
      const changeResourceUri = displayResult.repositoryRoot.with({
        path: `${trimTrailingSlash(displayResult.repositoryRoot.path)}/${resource.path}`,
        query: "",
        fragment: "",
      });
      const originalUri = resource.originalUri;
      const modifiedUri = resource.modifiedUri;
      if (originalUri === undefined && modifiedUri === undefined) return [];
      return [[changeResourceUri, originalUri, modifiedUri] as const];
    },
  );
  return {
    command: "vscode.changes",
    title,
    arguments: [title, publicChangeEntries],
  };
}

function trimTrailingSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

/** Reverse every directional field for an existing comparison session. */
export function invertCompareResult(result: CompareResult): CompareResult {
  const invertedFiles = result.files.map(invertCompareFileChange);
  const invertedFileCounts = invertCompareFileCounts(result.fileCounts);
  const invertedLeft = result.right;
  const invertedRight = result.left;
  const invertedResources = result.multiDiffPlan.resources.map(
    (resource, resourceIndex) => {
      const invertedFile = invertedFiles[resourceIndex];
      return {
        path: invertedFile?.path ?? resource.path,
        status:
          invertedFile?.status ?? invertCompareFileStatus(resource.status),
        ...(invertedFile?.isSubmodule === true || resource.isSubmodule === true
          ? { isSubmodule: true }
          : {}),
        ...(invertedFile?.isSymlink === true || resource.isSymlink === true
          ? { isSymlink: true }
          : {}),
        ...(resource.modifiedUri === undefined
          ? {}
          : { originalUri: resource.modifiedUri }),
        ...(resource.originalUri === undefined
          ? {}
          : { modifiedUri: resource.originalUri }),
      };
    },
  );
  const title = `${describeCompareTarget(invertedLeft)} ↔ ${describeCompareTarget(invertedRight)} — ${describeCompareMode(result.mode)}`;
  return {
    ...result,
    left: invertedLeft,
    right: invertedRight,
    aheadCount: result.behindCount,
    behindCount: result.aheadCount,
    aheadCommits: result.behindCommits.map(invertCompareCommit),
    behindCommits: result.aheadCommits.map(invertCompareCommit),
    files: invertedFiles,
    fileCounts: invertedFileCounts,
    multiDiffPlan: {
      ...result.multiDiffPlan,
      title,
      resources: invertedResources,
    },
  };
}

function invertCompareCommit(commit: CompareCommit): CompareCommit {
  return {
    ...commit,
    files: commit.files.map(invertCompareCommitFile),
  };
}

function invertCompareCommitFile(file: CompareCommitFile): CompareCommitFile {
  return {
    ...file,
    status: invertCompareFileStatus(file.status),
    additions: file.deletions,
    deletions: file.additions,
    ...(file.previousPath === undefined ? {} : { previousPath: file.path }),
    path: file.previousPath ?? file.path,
  };
}

function invertCompareFileChange(file: CompareFileChange): CompareFileChange {
  const { originalUri, modifiedUri, oldMode, newMode, ...directionalFile } =
    file;
  return {
    ...directionalFile,
    path: file.previousPath ?? file.path,
    ...(file.previousPath === undefined ? {} : { previousPath: file.path }),
    status: invertCompareFileStatus(file.status),
    additions: file.deletions,
    deletions: file.additions,
    ...(newMode === undefined ? {} : { oldMode: newMode }),
    ...(oldMode === undefined ? {} : { newMode: oldMode }),
    ...(modifiedUri === undefined ? {} : { originalUri: modifiedUri }),
    ...(originalUri === undefined ? {} : { modifiedUri: originalUri }),
  };
}

function invertCompareFileStatus(
  status: CompareFileChange["status"],
): CompareFileChange["status"] {
  if (status === "added") return "deleted";
  if (status === "deleted") return "added";
  return status;
}

function invertCompareFileCounts(counts: CompareFileCounts): CompareFileCounts {
  return {
    ...counts,
    added: counts.deleted,
    deleted: counts.added,
    additions: counts.deletions,
    deletions: counts.additions,
  };
}

export function createRecentComparison(
  selection: CompareExperienceSelection,
  savedAt = Date.now(),
  gitDirectoryIdentity = selection.repositoryRoot.fsPath,
): SerializableCompareSelection {
  return {
    version: 2,
    repositoryRoot: selection.repositoryRoot.toString(),
    gitDirectoryIdentity,
    left: selection.left,
    right: selection.right,
    mode: selection.mode,
    savedAt,
  };
}

export const searchFieldOptions: readonly SearchFieldOption[] = [
  { field: "message", label: "Message", description: "Commit subject or body" },
  { field: "author", label: "Author", description: "Name or email" },
  { field: "sha", label: "SHA", description: "Full or short commit ID" },
  { field: "file", label: "File", description: "Changed path" },
  { field: "patch", label: "Patch", description: "Added or removed text" },
  {
    field: "date",
    label: "Date",
    description: "YYYY-MM-DD, with optional comparison",
  },
  { field: "ref", label: "Ref", description: "Branch or tag decoration" },
  { field: "@me", label: "@me", description: "Commits by the current user" },
];

export function createSearchQueryChips(
  query: SearchQuery | SearchBuilderState,
): readonly SearchQueryChip[] {
  return query.clauses.map((clause, index) => ({
    id: `${clause.field}-${index}`,
    field: clause.field,
    ...(clause.value.length === 0 ? {} : { value: clause.value }),
    label:
      clause.field === "@me"
        ? "@me"
        : `${searchFieldLabel(clause.field)}: ${formatSearchClauseValue(clause)}`,
  }));
}

export function createSearchBuilderQuickPickItems(
  state: SearchBuilderState,
): readonly SearchBuilderQuickPickItem[] {
  const fields = searchFieldOptions
    .filter(
      (option) => option.field !== "@me" || state.currentUser !== undefined,
    )
    .map((option): SearchBuilderQuickPickItem => ({
      label: `Add ${option.label}`,
      description: option.description,
      action: "field",
      field: option.field,
    }));
  return [
    ...fields,
    {
      label: `Regex: ${state.regex ? "On" : "Off"}`,
      description: "Treat values as regular expressions",
      action: "toggle-regex",
    },
    {
      label: `Case-sensitive: ${state.matchCase ? "On" : "Off"}`,
      description: "Match letter case exactly",
      action: "toggle-case",
    },
    {
      label: `Match all: ${state.matchAll ? "On" : "Off"}`,
      description: "Require every query chip to match",
      action: "toggle-match-all",
    },
    {
      label: "Run search",
      description:
        createSearchQueryChips(state)
          .map((chip) => chip.label)
          .join(" · ") || "Search all commits",
      action: "run",
    },
    {
      label: "Clear query",
      description: "Remove all query chips and reset options",
      action: "clear",
    },
  ];
}

export function searchBuilderStateToQuery(
  state: SearchBuilderState,
): SearchQuery {
  const source = state.clauses.map(serializeSearchClause).join(" ");
  return parseSearchQuery(source, {
    matchCase: state.matchCase,
    regex: state.regex,
    matchAll: state.matchAll,
    ...(state.currentUser === undefined
      ? {}
      : { currentUser: state.currentUser }),
  });
}

export function appendSearchClause(
  state: SearchBuilderState,
  clause: SearchClause,
): SearchBuilderState {
  return { ...state, clauses: [...state.clauses, clause] };
}

export function toggleSearchBuilderOption(
  state: SearchBuilderState,
  option: "regex" | "matchCase" | "matchAll",
): SearchBuilderState {
  return { ...state, [option]: !state[option] };
}

export function createEmptySearchBuilderState(
  currentUser?: SearchBuilderState["currentUser"],
): SearchBuilderState {
  return {
    clauses: [],
    matchCase: false,
    regex: false,
    matchAll: false,
    ...(currentUser === undefined ? {} : { currentUser }),
  };
}

export function createSearchResultQuickPickItems(page: {
  readonly items: readonly SearchResultQuickPickItem["document"][];
  readonly hasMore: boolean;
}): readonly SearchResultQuickPickItem[] {
  const commitItems = page.items.flatMap((document) =>
    document === undefined
      ? []
      : [
          {
            label: `${document.shortSha}  ${document.subject}`,
            description: `${document.authorName} · ${document.authorDate.slice(0, 10)}`,
            detail: createSearchQueryChipsFromDocument(document),
            action: "commit" as const,
            document,
          },
        ],
  );
  return page.hasMore
    ? [
        ...commitItems,
        {
          label: "Load next page…",
          description: "Search more commits",
          action: "next-page",
        },
      ]
    : commitItems;
}

export function createChecklistView(state: ReviewChecklistState): readonly {
  readonly id: string;
  readonly label: string;
  readonly checked: boolean;
}[] {
  return defaultReviewChecklistItems.map((item) => ({
    id: item.id,
    label: item.label,
    checked: state.checkedItemIds.includes(item.id),
  }));
}

function searchFieldLabel(field: SearchClause["field"]): string {
  return (
    searchFieldOptions.find((option) => option.field === field)?.label ?? field
  );
}

function quoteSearchValue(value: string): string {
  return /\s|["\\]/.test(value)
    ? `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : value;
}

function serializeSearchClause(clause: SearchClause): string {
  if (clause.field === "@me") return "@me";
  return `${clause.field}:${quoteSearchValue(formatSearchClauseValue(clause))}`;
}

function formatSearchClauseValue(clause: SearchClause): string {
  if (clause.field !== "date") return clause.value;
  switch (clause.operator) {
    case "after":
      return `>${clause.value}`;
    case "before":
      return `<${clause.value}`;
    case "on-or-after":
      return `>=${clause.value}`;
    case "on-or-before":
      return `<=${clause.value}`;
    case "equals":
      return `=${clause.value}`;
    case "contains":
      return clause.value;
  }
}

function createSearchQueryChipsFromDocument(document: {
  readonly files: readonly { readonly path: string }[];
  readonly refs: readonly string[];
}): string {
  const paths = document.files
    .slice(0, 2)
    .map((file) => file.path)
    .join(", ");
  const refs = document.refs.slice(0, 2).join(", ");
  return [paths, refs].filter((value) => value.length > 0).join(" · ");
}
