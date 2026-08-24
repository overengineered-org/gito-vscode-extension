import type * as vscode from "vscode";
import {
  defaultDiffPlanOptions,
  type DiffChangeRange,
  type DiffFileOnlyPlan,
  type DiffNavigationEntry,
  type DiffPlanOptions,
  type DiffRepositoryPlan,
  type DiffRepositorySource,
} from "../diff/index.js";
import {
  type DiffExperienceOptions,
  type DiffExperiencePreset,
  type DiffExperienceSelection,
  type DiffExperienceSession,
  type DiffNavigationDirection,
  type DiffNavigationUnit,
  type DiffOpenCommandPlan,
  type RecentDiffComparison,
  type SerializableDiffSource,
} from "./diffExperienceModels.js";

export const defaultDiffExperienceOptions: DiffExperienceOptions = {
  preset: "review",
  contextLines: 3,
  whitespaceMode: "default",
  presentationMode: "line",
  renameDetection: true,
  renameSimilarityPercent: 50,
  maxFiles: defaultDiffPlanOptions.maxFiles,
  maxOutputBytes: defaultDiffPlanOptions.maxOutputBytes,
  maxNavigationChanges: defaultDiffPlanOptions.maxNavigationChanges,
};

export function optionsForDiffPreset(
  preset: DiffExperiencePreset,
  overrides: DiffPlanOptions = {},
): DiffExperienceOptions {
  const presetOptions: DiffPlanOptions =
    preset === "whitespace" ? { whitespaceMode: "ignore-all" } : {};
  return {
    ...defaultDiffExperienceOptions,
    ...presetOptions,
    ...overrides,
    preset,
  };
}

export function createDiffRepositoryOpenPlan(
  repositoryPlan: DiffRepositoryPlan,
  title: string,
  swapped = false,
): DiffOpenCommandPlan {
  const comparableFiles = repositoryPlan.files;
  if (comparableFiles.length === 1) {
    return createDiffFileOpenPlan(
      {
        ...comparableFiles[0]!,
        kind: "file",
        from: repositoryPlan.from,
        to: repositoryPlan.to,
      },
      title,
      swapped,
    );
  }
  const resources = comparableFiles.flatMap((file) => {
    const resource = createNativeResource(file, swapped);
    const repositoryPath = trimTrailingSlash(file.repositoryRoot.path);
    const changeResourceUri = file.repositoryRoot.with({
      path: `${repositoryPath}/${nativeDisplayPath(file, swapped)}`,
      query: "",
      fragment: "",
    });
    return resource.originalUri === undefined &&
      resource.modifiedUri === undefined
      ? []
      : [
          [
            changeResourceUri,
            resource.originalUri,
            resource.modifiedUri,
          ] as const,
        ];
  });
  return {
    command: "vscode.changes",
    title,
    arguments: [title, resources],
  };
}

export function createDiffFileOpenPlan(
  filePlan: DiffFileOnlyPlan,
  title: string,
  swapped = false,
  revealRange?: DiffChangeRange,
): DiffOpenCommandPlan {
  if (filePlan.metadata.isSubmodule) {
    return {
      command: "vscode.open",
      title,
      arguments: createSingleFileArguments(
        filePlan,
        title,
        swapped,
        revealRange,
        true,
      ),
    };
  }
  return {
    command:
      filePlan.originalUri === undefined || filePlan.modifiedUri === undefined
        ? "vscode.open"
        : "vscode.diff",
    title,
    arguments: createSingleFileArguments(filePlan, title, swapped, revealRange),
  };
}

export function createDiffNavigationOpenPlan(
  session: DiffExperienceSession,
  direction: DiffNavigationDirection,
  unit: DiffNavigationUnit,
): DiffOpenCommandPlan | undefined {
  const targetEntry = findNavigationTargetEntry(session, direction, unit);
  const targetIndex = targetEntry?.fileIndex;
  if (targetIndex === undefined || targetEntry === undefined) return undefined;
  const targetFile = session.plan.files[targetIndex];
  if (targetFile === undefined) return undefined;
  const targetTitle = `${nativeDisplayPath(targetFile, session.swapped)} — ${describeSelection(session.selection)}`;
  return createDiffFileOpenPlan(
    {
      ...targetFile,
      kind: "file",
      from: session.plan.from,
      to: session.plan.to,
    },
    targetTitle,
    session.swapped,
    targetEntry.range,
  );
}

export function findNavigationTargetIndex(
  session: DiffExperienceSession,
  direction: DiffNavigationDirection,
  unit: DiffNavigationUnit,
): number | undefined {
  return findNavigationTargetEntry(session, direction, unit)?.fileIndex;
}

export function findNavigationTargetEntry(
  session: DiffExperienceSession,
  direction: DiffNavigationDirection,
  unit: DiffNavigationUnit,
): DiffNavigationEntry | undefined {
  if (session.plan.files.length === 0) return undefined;
  if (unit === "file") {
    const offset = direction === "next" ? 1 : -1;
    const candidateIndex = session.activeFileIndex + offset;
    if (candidateIndex < 0 || candidateIndex >= session.plan.files.length)
      return undefined;
    const targetFile = session.plan.files[candidateIndex];
    const targetEntryId = targetFile?.navigationEntryIds[0];
    return session.plan.navigation.entries.find(
      (entry) => entry.id === targetEntryId,
    );
  }
  const currentEntryIndex = session.plan.navigation.entries.findIndex(
    (entry) => entry.id === session.activeChangeEntryId,
  );
  const startingEntryIndex = currentEntryIndex < 0 ? 0 : currentEntryIndex;
  const offset = direction === "next" ? 1 : -1;
  const candidateEntry =
    session.plan.navigation.entries[startingEntryIndex + offset];
  return candidateEntry;
}

export function describeSelection(selection: DiffExperienceSelection): string {
  return `${describeSource(selection.from)} ↔ ${describeSource(selection.to)}`;
}

export function describeSource(source: DiffRepositorySource): string {
  switch (source.kind) {
    case "working-tree":
      return "Working Tree";
    case "index":
      return "Staged";
    case "revision":
      return source.revision ?? "Commit";
    case "merge-base":
      return `Common base (${source.leftRevision ?? "?"} ↔ ${source.rightRevision ?? "?"})`;
  }
}

export function serializeDiffSource(
  source: DiffRepositorySource,
): SerializableDiffSource {
  return {
    kind: source.kind,
    ...(source.revision === undefined ? {} : { revision: source.revision }),
    ...(source.leftRevision === undefined
      ? {}
      : { leftRevision: source.leftRevision }),
    ...(source.rightRevision === undefined
      ? {}
      : { rightRevision: source.rightRevision }),
  };
}

export function createRecentDiffComparison(
  selection: DiffExperienceSelection,
  savedAt = Date.now(),
): RecentDiffComparison {
  return {
    version: 1,
    repositoryRoot: selection.repositoryRoot.toString(),
    from: serializeDiffSource(selection.from),
    to: serializeDiffSource(selection.to),
    view: selection.view,
    ...(selection.filePath === undefined
      ? {}
      : { filePath: selection.filePath }),
    options: {
      preset: selection.options.preset,
      contextLines: selection.options.contextLines ?? 3,
      whitespaceMode: selection.options.whitespaceMode ?? "default",
      presentationMode: selection.options.presentationMode ?? "line",
    },
    savedAt,
  };
}

export function createNativeResource(
  filePlan: DiffFileOnlyPlan | DiffRepositoryPlan["files"][number],
  swapped = false,
): { readonly originalUri?: vscode.Uri; readonly modifiedUri?: vscode.Uri } {
  const originalUri = swapped ? filePlan.modifiedUri : filePlan.originalUri;
  const modifiedUri = swapped ? filePlan.originalUri : filePlan.modifiedUri;
  return {
    ...(originalUri === undefined ? {} : { originalUri }),
    ...(modifiedUri === undefined ? {} : { modifiedUri }),
  };
}

function nativeDisplayPath(
  filePlan: DiffFileOnlyPlan | DiffRepositoryPlan["files"][number],
  swapped: boolean,
): string {
  if (!swapped) return filePlan.displayPath;
  return filePlan.metadata.oldPath ?? filePlan.displayPath;
}

function trimTrailingSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function createSingleFileArguments(
  filePlan: DiffFileOnlyPlan | DiffRepositoryPlan["files"][number] | undefined,
  title: string,
  swapped: boolean,
  revealRange?: DiffChangeRange,
  openSingleResource = false,
): readonly unknown[] {
  if (filePlan === undefined) return [];
  const resource = createNativeResource(filePlan, swapped);
  if (openSingleResource) {
    const availableUri = resource.modifiedUri ?? resource.originalUri;
    return availableUri === undefined
      ? []
      : [availableUri, { preview: false, preserveFocus: false }];
  }
  if (
    resource.originalUri !== undefined &&
    resource.modifiedUri !== undefined
  ) {
    return [
      resource.originalUri,
      resource.modifiedUri,
      title,
      {
        preview: false,
        preserveFocus: false,
        ...(revealRange === undefined
          ? {}
          : { selection: createRevealSelection(revealRange, swapped) }),
      },
    ];
  }
  const availableUri = resource.modifiedUri ?? resource.originalUri;
  return availableUri === undefined
    ? []
    : [availableUri, { preview: false, preserveFocus: false }];
}

function createRevealSelection(
  changeRange: DiffChangeRange,
  swapped: boolean,
): unknown {
  const lineNumber = Math.max(
    0,
    (swapped ? changeRange.oldStartLine : changeRange.newStartLine) - 1,
  );
  const position = { line: lineNumber, character: 0 };
  // The command accepts the structural TextEditorOptions range shape; keeping
  // this provider-free also works in tests and older hosts without Range exports.
  return { start: position, end: position };
}
