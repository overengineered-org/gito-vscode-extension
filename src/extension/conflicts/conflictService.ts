import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import * as vscode from "vscode";
import type {
  GitCommandRunner,
  GitCommandRequest,
  GitRootBindingIdentity,
} from "../git/gitCommandRunner.js";
import {
  classifyConflictEntry,
  operationLabel,
  parseConflictStatusRecords,
  parseUnmergedIndexEntries,
  type ParsedConflictStatusRecord,
  type ParsedUnmergedIndexEntry,
} from "./conflictParser.js";
import {
  conflictSideExplanations,
  conflictSideLabels,
  type ConflictApplyResult,
  type ConflictBlobVersion,
  type ConflictConfirmation,
  type ConflictFileState,
  type ConflictOperationKind,
  type ConflictOperationResult,
  type ConflictOperationState,
  type ConflictResolutionAction,
  type ConflictResolutionPlan,
  type ConflictResolutionRequest,
  type ConflictRepositorySnapshot,
  type ConflictRollbackFileSnapshot,
  type ConflictRollbackPlan,
  type ConflictSide,
  type MergeEditorCommand,
} from "./conflictModels.js";
import { conflictOperationSideLabels } from "./conflictModels.js";
import { redactGitErrorMessage } from "../git/gitErrorFormatting.js";

const MAX_CACHED_CONFLICT_BYTES = 4 * 1024 * 1024;
const MAX_OPERATION_METADATA_BYTES = 64 * 1024;
const MAX_REFERENCE_OUTPUT_BYTES = 4096;
const MAX_CONFLICT_STATUS_OUTPUT_BYTES = 8 * 1024 * 1024;
const mutationQueues = new Map<string, Promise<void>>();

interface MutationIdentityExpectation {
  readonly repositoryRoot?: string | undefined;
  readonly gitDirectory?: string | undefined;
  readonly rootBinding?: GitRootBindingIdentity | undefined;
}

export class ConflictOperationError extends Error {
  public constructor(
    public readonly code:
      | "confirmation-required"
      | "cancelled"
      | "stale-state"
      | "invalid-plan"
      | "manual-resolution-required"
      | "rollback-failed"
      | "operation-unavailable",
    message: string,
  ) {
    super(message);
    this.name = "ConflictOperationError";
  }
}

export interface ConflictInspectionOptions {
  readonly cancellationSignal?: AbortSignal | undefined;
}

export interface ConflictWorkspaceTrustGuard {
  isWorkspaceTrusted(): boolean;
  assertTrusted(operationName: string): void;
}

/**
 * Safe local-Git conflict operations. Inspection and previews are read-only;
 * every write requires an explicit confirmation callback and a fresh snapshot.
 */
export class ConflictService {
  public constructor(
    private readonly gitCommandRunner: GitCommandRunner,
    private readonly workspaceTrustGuard: ConflictWorkspaceTrustGuard,
  ) {}

  private assertWorkspaceTrusted(operationName: string): void {
    const guardedOperationName = `conflict ${operationName}`;
    if (this.workspaceTrustGuard.isWorkspaceTrusted() !== true) {
      throw new ConflictOperationError(
        "operation-unavailable",
        `Cannot ${guardedOperationName} in an untrusted workspace. Trust the workspace and try again.`,
      );
    }
    this.workspaceTrustGuard.assertTrusted(guardedOperationName);
  }

  public async inspect(
    repositoryRoot: string,
    options: ConflictInspectionOptions = {},
  ): Promise<ConflictRepositorySnapshot> {
    const canonicalRepositoryRoot = await this.assertCanonicalRepository(
      repositoryRoot,
      options.cancellationSignal,
    );
    const commandOptions = options.cancellationSignal;
    const [
      headResult,
      branchResult,
      gitDirectoryResult,
      commonDirectoryResult,
      statusResult,
      indexResult,
    ] = await Promise.all([
      this.run(
        canonicalRepositoryRoot,
        ["rev-parse", "HEAD"],
        commandOptions,
        true,
        MAX_REFERENCE_OUTPUT_BYTES,
      ),
      this.run(
        canonicalRepositoryRoot,
        ["symbolic-ref", "--short", "-q", "HEAD"],
        commandOptions,
        true,
        MAX_REFERENCE_OUTPUT_BYTES,
      ).catch(() => ({ standardOutput: "", standardError: "", exitCode: 1 })),
      this.run(
        canonicalRepositoryRoot,
        ["rev-parse", "--absolute-git-dir"],
        commandOptions,
        true,
        MAX_REFERENCE_OUTPUT_BYTES,
      ),
      this.run(
        canonicalRepositoryRoot,
        ["rev-parse", "--git-common-dir"],
        commandOptions,
        true,
        MAX_REFERENCE_OUTPUT_BYTES,
      ),
      this.run(
        canonicalRepositoryRoot,
        ["status", "--porcelain=v2", "-z", "--untracked-files=no"],
        commandOptions,
        true,
        MAX_CONFLICT_STATUS_OUTPUT_BYTES,
      ),
      this.run(
        canonicalRepositoryRoot,
        ["ls-files", "-u", "-z"],
        commandOptions,
        true,
        MAX_CONFLICT_STATUS_OUTPUT_BYTES,
      ),
    ]);

    assertCompleteGitOutput(headResult, "Git HEAD");
    assertCompleteGitOutput(branchResult, "Git branch");
    assertCompleteGitOutput(gitDirectoryResult, "Git directory");
    assertCompleteGitOutput(commonDirectoryResult, "Git common directory");
    assertCompleteGitOutput(statusResult, "Git status");
    assertCompleteGitOutput(indexResult, "Git index conflict state");

    const gitDirectory = await canonicalGitDirectory(
      gitDirectoryResult.standardOutput.trim(),
    );
    const repositoryRootIdentity = await filesystemIdentity(
      canonicalRepositoryRoot,
    );
    const gitDirectoryIdentity = await filesystemIdentity(gitDirectory);
    const commonDirectory = await canonicalGitPath(
      canonicalRepositoryRoot,
      commonDirectoryResult.standardOutput.trim(),
    );
    const repositoryRootBinding = await captureGitRootBinding(
      canonicalRepositoryRoot,
      gitDirectory,
      commonDirectory,
      commandOptions,
    );
    const detectedOperation = await detectOperation(
      gitDirectory,
      canonicalRepositoryRoot,
      this.gitCommandRunner,
      commandOptions,
      normalizeOptionalText(headResult.standardOutput),
      normalizeOptionalText(branchResult.standardOutput),
    );
    const operation =
      detectedOperation === undefined
        ? undefined
        : {
            ...detectedOperation,
            metadataFingerprint: await fingerprintOperationMetadata(
              detectedOperation,
              commandOptions,
            ),
          };
    const statusRecords = parseConflictStatusRecords(
      statusResult.standardOutput,
    );
    const indexEntries = parseUnmergedIndexEntries(indexResult.standardOutput);
    const files = await this.buildFileStates(
      canonicalRepositoryRoot,
      statusRecords,
      indexEntries,
      commandOptions,
    );
    const fingerprint = fingerprintSnapshot(
      gitDirectory,
      repositoryRootIdentity,
      gitDirectoryIdentity,
      repositoryRootBinding,
      headResult.standardOutput.trim(),
      branchResult.standardOutput.trim(),
      statusResult.standardOutput,
      indexResult.standardOutput,
      operation,
      files,
    );
    const hasUnmergedEntries = indexEntries.length > 0;
    const canContinue = operation !== undefined && !hasUnmergedEntries;
    return {
      repositoryRoot: canonicalRepositoryRoot,
      gitDirectory,
      repositoryRootIdentity,
      gitDirectoryIdentity,
      repositoryRootBinding,
      fingerprint,
      headCommit: normalizeOptionalText(headResult.standardOutput),
      currentBranchName: normalizeOptionalText(branchResult.standardOutput),
      operation,
      files,
      hasUnmergedEntries,
      canContinue,
      continueReason:
        operation === undefined
          ? "No merge, rebase, patch apply, cherry-pick, or revert is in progress."
          : hasUnmergedEntries
            ? "Resolve and stage every conflict before continuing."
            : undefined,
      canAbort: operation !== undefined,
      abortReason:
        operation === undefined
          ? "No merge, rebase, patch apply, cherry-pick, or revert is in progress."
          : undefined,
    };
  }

  public async previewResolutions(
    repositoryRoot: string,
    requests: readonly ConflictResolutionRequest[],
    options: ConflictInspectionOptions = {},
  ): Promise<ConflictResolutionPlan> {
    const snapshot = await this.inspect(repositoryRoot, options);
    if (snapshot.operation === undefined) {
      throw new ConflictOperationError(
        "operation-unavailable",
        "No merge, rebase, patch apply, cherry-pick, or revert is in progress.",
      );
    }
    if (requests.length === 0) {
      throw new ConflictOperationError(
        "invalid-plan",
        "Choose at least one conflict file before creating a resolution plan.",
      );
    }
    const conflictFilesByPath = new Map(
      snapshot.files.map((conflictFile) => [conflictFile.path, conflictFile]),
    );
    const seenPaths = new Set<string>();
    const actions: ConflictResolutionAction[] = [];
    let requiresManualEditing = false;
    for (const request of requests) {
      assertRepositoryRelativePath(request.path);
      if (seenPaths.has(request.path)) {
        throw new ConflictOperationError(
          "invalid-plan",
          `The resolution plan names ${request.path} more than once.`,
        );
      }
      seenPaths.add(request.path);
      const conflictFile = conflictFilesByPath.get(request.path);
      if (conflictFile === undefined || conflictFile.isResolved) {
        throw new ConflictOperationError(
          "stale-state",
          `Conflict ${request.path} is no longer unresolved. Refresh conflicts and try again.`,
        );
      }
      if (conflictFile.kind === "submodule" && request.choice !== "manual") {
        throw new ConflictOperationError(
          "operation-unavailable",
          `Cannot choose a side for submodule ${request.path} safely. Resolve the gitlink with Git's native merge tooling, then stage it manually.`,
        );
      }
      if (request.choice !== "manual" && !hasExactRollbackBytes(conflictFile)) {
        throw new ConflictOperationError(
          "invalid-plan",
          `Cannot create a transactional resolution for ${request.path}: its working-tree bytes exceed the bounded safety cap. Open and resolve it manually instead.`,
        );
      }
      if (
        conflictFile.workingTreeKind === "special" &&
        request.choice !== "manual"
      ) {
        throw new ConflictOperationError(
          "invalid-plan",
          `Cannot create a transactional resolution for special path ${request.path}; resolve it manually.`,
        );
      }
      const selectedSideVersion =
        request.choice === "keep-current"
          ? conflictFile.stages.current
          : request.choice === "keep-incoming"
            ? conflictFile.stages.incoming
            : undefined;
      const isExactSymlinkSideChoice =
        selectedSideVersion?.mode === "120000" &&
        selectedSideVersion.content !== undefined;
      if (
        conflictFile.kind === "binary" &&
        request.choice !== "manual" &&
        !isExactSymlinkSideChoice
      ) {
        throw new ConflictOperationError(
          "operation-unavailable",
          `Cannot create a transactional binary resolution for ${request.path}. Resolve the binary conflict with Git's native tooling, then stage it manually.`,
        );
      }
      if (
        request.choice === "combine" &&
        (request.combinedContent?.byteLength ?? 0) > MAX_CACHED_CONFLICT_BYTES
      ) {
        throw new ConflictOperationError(
          "invalid-plan",
          `Combined content for ${request.path} exceeds the ${MAX_CACHED_CONFLICT_BYTES} byte safety cap. Resolve it manually instead.`,
        );
      }
      actions.push(
        this.createAction(conflictFile, request, snapshot.operation.kind),
      );
      if (request.choice === "manual") requiresManualEditing = true;
    }
    const rollback = createRollbackPlan(
      snapshot,
      requests.map((request) => request.path),
    );
    const applyContextIgnoredPaths = new Set<string>(
      requests.map((request) => request.path),
    );
    for (const request of requests) {
      const conflictFile = snapshot.files.find(
        (candidate) => candidate.path === request.path,
      );
      if (conflictFile?.originalPath !== undefined) {
        applyContextIgnoredPaths.add(conflictFile.originalPath);
      }
    }
    const expectedApplyContextFingerprint = fingerprintApplyContext(
      snapshot,
      applyContextIgnoredPaths,
    );
    const operationSides = conflictOperationSideLabels(snapshot.operation.kind);
    const previewLines = [
      `${operationLabel(snapshot.operation.kind)} in ${snapshot.currentBranchName ?? "detached HEAD"}.`,
      `Target: ${formatOperationTarget(snapshot.operation)}. Source: ${formatOperationSource(snapshot.operation)}.`,
      `${operationSides.current}: ${operationSides.currentExplanation}`,
      `${operationSides.incoming}: ${operationSides.incomingExplanation}`,
      "Git stage 2 is the operation-specific current/ours side; stage 3 is the operation-specific incoming/theirs side.",
      ...(snapshot.operation.kind === "merge"
        ? [
            `${conflictSideLabels.current}: ${conflictSideExplanations.current}`,
            `${conflictSideLabels.incoming}: ${conflictSideExplanations.incoming}`,
          ]
        : []),
      ...requests.map((request) =>
        formatResolutionPreviewLine(request, {
          current: operationSides.current,
          incoming: operationSides.incoming,
        }),
      ),
      requiresManualEditing
        ? "Manual files open in VS Code's merge editor; no file is changed by this preview."
        : "Apply will change only these files, then stage only these paths.",
    ];
    return {
      repositoryRoot: snapshot.repositoryRoot,
      expectedSnapshotFingerprint: snapshot.fingerprint,
      expectedGitDirectory: snapshot.gitDirectory,
      expectedRepositoryRootIdentity: snapshot.repositoryRootIdentity,
      expectedGitDirectoryIdentity: snapshot.gitDirectoryIdentity,
      expectedRepositoryRootBinding: snapshot.repositoryRootBinding,
      expectedApplyContextFingerprint,
      operation: snapshot.operation.kind,
      requests,
      actions,
      stagedPaths: requests.map((request) => request.path),
      preview: previewLines.join("\n"),
      requiresManualEditing,
      rollback,
    };
  }

  public createMergeEditorCommand(
    repositoryRoot: string,
    relativePath: string,
  ): MergeEditorCommand {
    assertRepositoryRelativePath(relativePath);
    const filesystemPath = join(resolve(repositoryRoot), relativePath);
    const uriFactory = (
      vscode.Uri as unknown as
        { readonly file?: (path: string) => vscode.Uri } | undefined
    )?.file;
    return {
      commandIdentifier: "git.openMergeEditor",
      arguments: [
        uriFactory === undefined ? filesystemPath : uriFactory(filesystemPath),
      ],
    };
  }

  /** Revalidates the exact conflict file at the native-editor open boundary. */
  public async assertMergeEditorOpenReady(
    plan: ConflictResolutionPlan,
    relativePath: string,
    options: ConflictInspectionOptions = {},
  ): Promise<void> {
    assertRepositoryRelativePath(relativePath);
    const currentSnapshot = await this.inspect(plan.repositoryRoot, options);
    assertFreshSnapshot(plan.expectedSnapshotFingerprint, currentSnapshot);
    const conflictFile = currentSnapshot.files.find(
      (candidate) => candidate.path === relativePath,
    );
    if (
      conflictFile === undefined ||
      conflictFile.isResolved ||
      conflictFile.workingTreeKind !== "file"
    ) {
      throw new ConflictOperationError(
        "stale-state",
        `Conflict ${relativePath} is no longer a stable unresolved file; refresh conflicts before opening the merge editor.`,
      );
    }
    const workingTreeState = await readWorkingTreeState(
      plan.repositoryRoot,
      relativePath,
      options.cancellationSignal,
    );
    if (
      workingTreeState.kind !== conflictFile.workingTreeKind ||
      workingTreeState.digest !== conflictFile.workingTreeDigest ||
      workingTreeState.leafFingerprint !==
        conflictFile.workingTreeLeafFingerprint ||
      workingTreeState.parentFingerprint !==
        conflictFile.workingTreeParentFingerprint
    ) {
      throw new ConflictOperationError(
        "stale-state",
        `Conflict ${relativePath} changed at the merge-editor boundary; refresh conflicts before opening it.`,
      );
    }
    await assertMutationContext(
      this.gitCommandRunner,
      plan.repositoryRoot,
      currentSnapshot.gitDirectory ?? plan.expectedGitDirectory,
      [relativePath],
      options.cancellationSignal,
      false,
      {
        repositoryRoot:
          currentSnapshot.repositoryRootIdentity ??
          plan.expectedRepositoryRootIdentity,
        gitDirectory:
          currentSnapshot.gitDirectoryIdentity ??
          plan.expectedGitDirectoryIdentity,
        rootBinding: plan.expectedRepositoryRootBinding,
      },
    );
  }

  public async applyResolution(
    plan: ConflictResolutionPlan,
    confirmation: ConflictConfirmation,
    options: ConflictInspectionOptions = {},
  ): Promise<ConflictApplyResult> {
    assertConfirmation(confirmation);
    if (plan.requiresManualEditing) {
      throw new ConflictOperationError(
        "manual-resolution-required",
        "Open the manual files in VS Code's merge editor and stage them separately; this plan cannot auto-apply manual edits.",
      );
    }
    const confirmed = await confirmation.confirm(plan.preview);
    if (!confirmed) {
      throw new ConflictOperationError(
        "cancelled",
        "Conflict resolution cancelled before any file was changed.",
      );
    }
    return this.withMutation(plan.repositoryRoot, async () => {
      const currentSnapshot = await this.inspect(plan.repositoryRoot, options);
      assertFreshSnapshot(plan.expectedSnapshotFingerprint, currentSnapshot);
      const applyContextIgnoredPaths = ignoredApplyContextPaths(
        plan.requests,
        currentSnapshot,
      );
      assertFreshApplyContext(
        plan.expectedApplyContextFingerprint,
        currentSnapshot,
        applyContextIgnoredPaths,
      );
      const currentFiles = new Map(
        currentSnapshot.files.map((conflictFile) => [
          conflictFile.path,
          conflictFile,
        ]),
      );
      const rollbackExpectedCurrentStates = createRollbackExpectedStates(
        plan.rollback,
        currentSnapshot,
      );
      for (const request of plan.requests) {
        const currentFile = currentFiles.get(request.path);
        if (currentFile === undefined || currentFile.isResolved) {
          throw new ConflictOperationError(
            "stale-state",
            `Conflict ${request.path} changed after confirmation. Refresh conflicts and try again.`,
          );
        }
        assertNotCancelled(options.cancellationSignal);
        const selectedVersion =
          request.choice === "keep-current"
            ? currentFile.stages.current
            : request.choice === "keep-incoming"
              ? currentFile.stages.incoming
              : undefined;
        await assertMutationContext(
          this.gitCommandRunner,
          plan.repositoryRoot,
          currentSnapshot.gitDirectory ?? plan.expectedGitDirectory,
          [request.path],
          options.cancellationSignal,
          selectedVersion?.mode === "120000" ||
            selectedVersion?.exists === false,
          {
            repositoryRoot:
              currentSnapshot.repositoryRootIdentity ??
              plan.expectedRepositoryRootIdentity,
            gitDirectory:
              currentSnapshot.gitDirectoryIdentity ??
              plan.expectedGitDirectoryIdentity,
            rootBinding: plan.expectedRepositoryRootBinding,
          },
        );
      }
      let mutationStarted = false;
      try {
        for (const request of plan.requests) {
          assertNotCancelled(options.cancellationSignal);
          const latestSnapshot = await this.inspect(
            plan.repositoryRoot,
            options,
          );
          const expectedFile = currentFiles.get(request.path);
          const latestFile = latestSnapshot.files.find(
            (conflictFile) => conflictFile.path === request.path,
          );
          if (expectedFile === undefined || latestFile === undefined) {
            throw new ConflictOperationError(
              "stale-state",
              `Conflict ${request.path} changed after confirmation. Refresh conflicts and try again.`,
            );
          }
          assertFreshApplyContext(
            plan.expectedApplyContextFingerprint,
            latestSnapshot,
            applyContextIgnoredPaths,
          );
          assertFreshConflictFile(expectedFile, latestFile);
          await this.applyRequest(
            plan.repositoryRoot,
            latestFile,
            request,
            latestSnapshot.gitDirectory ?? plan.expectedGitDirectory,
            options.cancellationSignal,
            plan.expectedApplyContextFingerprint,
            applyContextIgnoredPaths,
            {
              repositoryRoot:
                latestSnapshot.repositoryRootIdentity ??
                plan.expectedRepositoryRootIdentity,
              gitDirectory:
                latestSnapshot.gitDirectoryIdentity ??
                plan.expectedGitDirectoryIdentity,
              rootBinding: plan.expectedRepositoryRootBinding,
            },
            () => {
              mutationStarted = true;
            },
          );
          const postApplyWorkingTree = await readWorkingTreeState(
            plan.repositoryRoot,
            request.path,
            options.cancellationSignal,
          );
          rollbackExpectedCurrentStates.set(
            request.path,
            mutationExpectationFromWorkingTreeState(postApplyWorkingTree),
          );
        }
        const snapshotAfterApply = await this.inspect(
          plan.repositoryRoot,
          options,
        );
        assertStableRepositoryIdentity(currentSnapshot, snapshotAfterApply);
        return {
          appliedPaths: plan.stagedPaths,
          rollback: plan.rollback,
          snapshotAfterApply,
        };
      } catch (error: unknown) {
        let failure: unknown = error;
        if (mutationStarted) {
          try {
            await this.restoreRollback(
              plan.rollback,
              rollbackExpectedCurrentStates,
            );
          } catch (rollbackError: unknown) {
            failure = new ConflictOperationError(
              "rollback-failed",
              `Resolution failed and automatic rollback failed: ${redactGitErrorMessage(formatRollbackErrorMessage(rollbackError))}. Repository state needs immediate review.`,
            );
          }
        }
        throw await this.withFinalConflictState(plan.repositoryRoot, failure);
      }
    });
  }

  public async abort(
    repositoryRoot: string,
    confirmation: ConflictConfirmation,
    expectedSnapshotFingerprint?: string,
    options: ConflictInspectionOptions = {},
  ): Promise<ConflictOperationResult> {
    return this.runOperationControl(
      repositoryRoot,
      "abort",
      confirmation,
      expectedSnapshotFingerprint,
      options,
    );
  }

  public async continue(
    repositoryRoot: string,
    confirmation: ConflictConfirmation,
    expectedSnapshotFingerprint?: string,
    options: ConflictInspectionOptions = {},
  ): Promise<ConflictOperationResult> {
    return this.runOperationControl(
      repositoryRoot,
      "continue",
      confirmation,
      expectedSnapshotFingerprint,
      options,
    );
  }

  private async runOperationControl(
    repositoryRoot: string,
    action: "abort" | "continue",
    confirmation: ConflictConfirmation,
    expectedSnapshotFingerprint: string | undefined,
    options: ConflictInspectionOptions,
  ): Promise<ConflictOperationResult> {
    assertConfirmation(confirmation);
    return this.withMutation(repositoryRoot, async () => {
      const snapshot = await this.inspect(repositoryRoot, options);
      if (snapshot.operation === undefined) {
        throw new ConflictOperationError(
          "operation-unavailable",
          `Cannot ${action}: no Git operation is in progress.`,
        );
      }
      if (expectedSnapshotFingerprint !== undefined) {
        assertFreshSnapshot(expectedSnapshotFingerprint, snapshot);
      }
      if (action === "continue" && !snapshot.canContinue) {
        throw new ConflictOperationError(
          "operation-unavailable",
          snapshot.continueReason ?? "Resolve all conflicts before continuing.",
        );
      }
      const command = operationCommand(snapshot.operation.kind, action);
      const preview = `${action === "abort" ? "Abort" : "Continue"} ${snapshot.operation.label}?\n${
        action === "abort"
          ? "Git may discard the in-progress operation's conflict state."
          : "Git will advance the in-progress operation using the currently staged resolution."
      }`;
      if (!(await confirmation.confirm(preview))) {
        throw new ConflictOperationError(
          "cancelled",
          `${action === "abort" ? "Abort" : "Continue"} cancelled before Git was changed.`,
        );
      }
      assertNotCancelled(options.cancellationSignal);
      const confirmedSnapshot = await this.inspect(repositoryRoot, options);
      assertFreshSnapshot(snapshot.fingerprint, confirmedSnapshot);
      await this.assertOperationMetadataPinned(
        confirmedSnapshot,
        options.cancellationSignal,
      );
      await assertMutationContext(
        this.gitCommandRunner,
        repositoryRoot,
        confirmedSnapshot.gitDirectory,
        [],
        options.cancellationSignal,
        false,
        {
          repositoryRoot: confirmedSnapshot.repositoryRootIdentity,
          gitDirectory: confirmedSnapshot.gitDirectoryIdentity,
          rootBinding: snapshot.repositoryRootBinding,
        },
      );
      this.assertWorkspaceTrusted(`operation ${action}`);
      try {
        await this.run(
          repositoryRoot,
          command,
          options.cancellationSignal,
          false,
          MAX_OPERATION_METADATA_BYTES,
          false,
          false,
          snapshot.repositoryRootBinding,
        );
        const afterOperation = await this.inspect(repositoryRoot, options);
        assertStableRepositoryIdentity(confirmedSnapshot, afterOperation);
        return {
          changed: true,
          operation: snapshot.operation.kind,
          command: ["git", ...command].join(" "),
          snapshot: afterOperation,
        };
      } catch (error: unknown) {
        throw await this.withFinalConflictState(repositoryRoot, error);
      }
    });
  }

  public async skip(
    repositoryRoot: string,
    confirmation: ConflictConfirmation,
    expectedSnapshotFingerprint?: string,
    options: ConflictInspectionOptions = {},
  ): Promise<ConflictOperationResult> {
    assertConfirmation(confirmation);
    return this.withMutation(repositoryRoot, async () => {
      const snapshot = await this.inspect(repositoryRoot, options);
      const operation = snapshot.operation;
      if (
        operation === undefined ||
        (operation.kind !== "rebase" &&
          operation.kind !== "am" &&
          operation.kind !== "cherry-pick")
      ) {
        throw new ConflictOperationError(
          "operation-unavailable",
          "Skip is available only for an active rebase, patch apply, or cherry-pick step.",
        );
      }
      if (expectedSnapshotFingerprint !== undefined) {
        assertFreshSnapshot(expectedSnapshotFingerprint, snapshot);
      }
      const command = operationCommand(operation.kind, "skip");
      const preview = `Skip ${operation.label}? Git will discard the current operation step.`;
      if (!(await confirmation.confirm(preview))) {
        throw new ConflictOperationError(
          "cancelled",
          "Skip cancelled before Git was changed.",
        );
      }
      assertNotCancelled(options.cancellationSignal);
      const confirmedSnapshot = await this.inspect(repositoryRoot, options);
      assertFreshSnapshot(snapshot.fingerprint, confirmedSnapshot);
      await this.assertOperationMetadataPinned(
        confirmedSnapshot,
        options.cancellationSignal,
      );
      await assertMutationContext(
        this.gitCommandRunner,
        repositoryRoot,
        confirmedSnapshot.gitDirectory,
        [],
        options.cancellationSignal,
        false,
        {
          repositoryRoot: confirmedSnapshot.repositoryRootIdentity,
          gitDirectory: confirmedSnapshot.gitDirectoryIdentity,
          rootBinding: snapshot.repositoryRootBinding,
        },
      );
      this.assertWorkspaceTrusted("operation skip");
      try {
        await this.run(
          repositoryRoot,
          command,
          options.cancellationSignal,
          false,
          MAX_OPERATION_METADATA_BYTES,
          false,
          false,
          snapshot.repositoryRootBinding,
        );
        const afterOperation = await this.inspect(repositoryRoot, options);
        assertStableRepositoryIdentity(confirmedSnapshot, afterOperation);
        return {
          changed: true,
          operation: operation.kind,
          command: ["git", ...command].join(" "),
          snapshot: afterOperation,
        };
      } catch (error: unknown) {
        throw await this.withFinalConflictState(repositoryRoot, error);
      }
    });
  }

  private async restoreRollback(
    rollbackPlan: ConflictRollbackPlan,
    expectedCurrentStates: ReadonlyMap<
      string,
      BoundWorkingTreeMutationExpectation
    >,
  ): Promise<void> {
    // Recovery must run even when the original operation was cancelled.
    const paths = rollbackPlan.files.map((file) => file.path);
    for (const file of rollbackPlan.files) {
      if (!expectedCurrentStates.has(file.path)) {
        throw new ConflictOperationError(
          "rollback-failed",
          `Current bytes are unavailable for ${file.path}; it was left untouched.`,
        );
      }
      if (
        file.workingTreeKind !== "file" &&
        file.workingTreeKind !== "symlink" &&
        file.workingTreeKind !== "missing"
      ) {
        throw new ConflictOperationError(
          "rollback-failed",
          `Rollback bytes are unavailable for ${file.path}; it was left untouched.`,
        );
      }
      if (
        file.workingTreeKind !== "missing" &&
        file.workingTreeContent === undefined
      ) {
        throw new ConflictOperationError(
          "rollback-failed",
          `Rollback bytes are unavailable for ${file.path}; it was left untouched.`,
        );
      }
    }
    if (paths.length > 0) {
      await this.assertRollbackMutationReady(rollbackPlan, paths, true);
      this.assertWorkspaceTrusted("rollback index removal");
      await this.runWithStandardInput(
        rollbackPlan.repositoryRoot,
        ["update-index", "--force-remove", "-z", "--stdin"],
        Buffer.from(`${paths.join("\0")}\0`),
        undefined,
        false,
        undefined,
        rollbackPlan.sourceRepositoryRootBinding,
      );
      await this.assertRollbackMutationReady(rollbackPlan, paths, true);
    }
    for (const file of rollbackPlan.files) {
      const expectedCurrentState = expectedCurrentStates.get(file.path);
      if (expectedCurrentState === undefined) {
        throw new ConflictOperationError(
          "rollback-failed",
          `Current bytes are unavailable for ${file.path}; it was left untouched.`,
        );
      }
      await this.restoreRollbackWorkingTreeFile(
        rollbackPlan,
        file,
        expectedCurrentState,
      );
    }
    const indexInput = rollbackIndexInput(rollbackPlan);
    if (indexInput.length > 0) {
      await this.assertRollbackMutationReady(rollbackPlan, [], false);
      this.assertWorkspaceTrusted("rollback index stages");
      await this.runWithStandardInput(
        rollbackPlan.repositoryRoot,
        ["update-index", "-z", "--index-info"],
        indexInput,
        undefined,
        false,
        undefined,
        rollbackPlan.sourceRepositoryRootBinding,
      );
      await this.assertRollbackMutationReady(rollbackPlan, [], false);
    }
  }

  private async assertRollbackMutationReady(
    rollbackPlan: ConflictRollbackPlan,
    relativePaths: readonly string[],
    allowNonRegularLeaf: boolean,
  ): Promise<void> {
    const currentSnapshot = await this.inspect(rollbackPlan.repositoryRoot);
    const ignoredPaths = new Set(
      rollbackPlan.files.map((rollbackFile) => rollbackFile.path),
    );
    if (
      rollbackPlan.sourceApplyContextFingerprint !== undefined &&
      rollbackPlan.sourceApplyContextFingerprint !==
        fingerprintApplyContext(currentSnapshot, ignoredPaths)
    ) {
      throw new ConflictOperationError(
        "stale-state",
        "Repository context changed during rollback; recovery stopped safely.",
      );
    }
    await assertMutationContext(
      this.gitCommandRunner,
      rollbackPlan.repositoryRoot,
      currentSnapshot.gitDirectory ?? rollbackPlan.sourceGitDirectory,
      relativePaths,
      undefined,
      allowNonRegularLeaf,
      {
        repositoryRoot:
          currentSnapshot.repositoryRootIdentity ??
          rollbackPlan.sourceRepositoryRootIdentity,
        gitDirectory:
          currentSnapshot.gitDirectoryIdentity ??
          rollbackPlan.sourceGitDirectoryIdentity,
        rootBinding: rollbackPlan.sourceRepositoryRootBinding,
      },
    );
  }

  private async restoreRollbackWorkingTreeFile(
    rollbackPlan: ConflictRollbackPlan,
    file: ConflictRollbackFileSnapshot,
    expectedCurrentState: BoundWorkingTreeMutationExpectation,
  ): Promise<void> {
    const path = file.path;
    if (file.workingTreeKind === "missing") {
      await this.assertRollbackMutationReady(rollbackPlan, [path], true);
      this.assertWorkspaceTrusted("rollback missing working-tree path");
      await writeWorkingTreeStateWithBoundWorker(
        rollbackPlan.repositoryRoot,
        path,
        "remove",
        undefined,
        undefined,
        {
          ...expectedCurrentState,
        },
        rollbackPlan.sourceRepositoryRootBinding,
        undefined,
      );
      await this.assertRollbackMutationReady(rollbackPlan, [path], true);
      return;
    }
    const content = file.workingTreeContent;
    if (content === undefined) {
      throw new ConflictOperationError(
        "rollback-failed",
        `Rollback bytes are unavailable for ${path}; it was left untouched.`,
      );
    }
    const mode =
      file.workingTreeKind === "symlink"
        ? "120000"
        : file.workingTreeMode === 0o755
          ? "100755"
          : "100644";
    await this.assertRollbackMutationReady(rollbackPlan, [path], true);
    this.assertWorkspaceTrusted("rollback working-tree object");
    const objectResult = await this.gitCommandRunner.run({
      repositoryRoot: rollbackPlan.repositoryRoot,
      rootBinding: rollbackPlan.sourceRepositoryRootBinding,
      arguments: ["hash-object", "-w", "--stdin"],
      standardInput: content,
      maxStandardOutputBytes: MAX_REFERENCE_OUTPUT_BYTES,
    });
    assertCompleteGitOutput(objectResult, "Rollback Git object ID");
    await this.assertRollbackMutationReady(rollbackPlan, [path], true);
    const objectId = objectResult.standardOutput.trim();
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(objectId)) {
      throw new ConflictOperationError(
        "rollback-failed",
        `Git returned an invalid rollback object ID for ${path}; recovery stopped safely.`,
      );
    }
    await this.assertRollbackMutationReady(rollbackPlan, [path], true);
    this.assertWorkspaceTrusted("rollback working-tree index");
    await this.runWithStandardInput(
      rollbackPlan.repositoryRoot,
      ["update-index", "-z", "--index-info"],
      Buffer.from(`${mode} ${objectId} 0\t${path}\0`),
      undefined,
      false,
      undefined,
      rollbackPlan.sourceRepositoryRootBinding,
    );
    await this.assertRollbackMutationReady(rollbackPlan, [path], true);
    this.assertWorkspaceTrusted("rollback working-tree bytes");
    await writeWorkingTreeStateWithBoundWorker(
      rollbackPlan.repositoryRoot,
      path,
      "write",
      content,
      mode,
      {
        ...expectedCurrentState,
      },
      rollbackPlan.sourceRepositoryRootBinding,
      undefined,
    );
    await this.assertRollbackMutationReady(rollbackPlan, [path], true);
  }

  private runWithStandardInput(
    repositoryRoot: string,
    argumentsPassed: readonly string[],
    standardInput: Uint8Array,
    cancellationSignal?: AbortSignal,
    collectStandardOutput = false,
    maxStandardOutputBytes = MAX_REFERENCE_OUTPUT_BYTES,
    rootBinding?: GitRootBindingIdentity,
  ): Promise<Awaited<ReturnType<GitCommandRunner["run"]>>> {
    return this.gitCommandRunner.run({
      repositoryRoot,
      rootBinding,
      arguments: argumentsPassed,
      standardInput,
      cancellationSignal,
      collectStandardOutput,
      maxStandardOutputBytes,
      literalPathspecs: true,
    });
  }

  private async withMutation<T>(
    repositoryRoot: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const queueKey = await realpath(repositoryRoot).catch(() =>
      resolve(repositoryRoot),
    );
    const previous = mutationQueues.get(queueKey) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const completion = current.then(
      () => undefined,
      () => undefined,
    );
    mutationQueues.set(queueKey, completion);
    return current.finally(() => {
      if (mutationQueues.get(queueKey) === completion) {
        mutationQueues.delete(queueKey);
      }
    });
  }

  private async withFinalConflictState(
    repositoryRoot: string,
    error: unknown,
  ): Promise<Error> {
    let finalState: ConflictRepositorySnapshot | undefined;
    try {
      finalState = await this.inspect(repositoryRoot);
    } catch {
      // Preserve the original failure when even final inspection is unavailable.
    }
    const originalMessage =
      error instanceof Error ? error.message : String(error);
    if (finalState === undefined)
      return error instanceof Error ? error : new Error(originalMessage);
    if (error instanceof ConflictOperationError) {
      return new ConflictOperationError(
        error.code,
        `${originalMessage} Final conflict state: ${formatConflictFinalState(finalState)}.`,
      );
    }
    return new Error(
      `${originalMessage} Final conflict state: ${formatConflictFinalState(finalState)}.`,
    );
  }

  private async assertOperationMetadataPinned(
    snapshot: ConflictRepositorySnapshot,
    cancellationSignal?: AbortSignal,
  ): Promise<void> {
    const operation = snapshot.operation;
    if (operation === undefined || operation.metadataFingerprint === undefined)
      return;
    const currentFingerprint = await fingerprintOperationMetadata(
      operation,
      cancellationSignal,
    );
    if (currentFingerprint !== operation.metadataFingerprint) {
      throw new ConflictOperationError(
        "stale-state",
        "Active Git operation metadata changed at the mutation boundary; refresh conflict state before continuing.",
      );
    }
  }

  private async buildFileStates(
    repositoryRoot: string,
    statusRecords: readonly ParsedConflictStatusRecord[],
    indexEntries: readonly ParsedUnmergedIndexEntry[],
    cancellationSignal: AbortSignal | undefined,
  ): Promise<readonly ConflictFileState[]> {
    const statusByPath = new Map(
      statusRecords.map((record) => [record.path, record]),
    );
    const entriesByPath = new Map<string, ParsedUnmergedIndexEntry[]>();
    for (const entry of indexEntries) {
      const entries = entriesByPath.get(entry.path) ?? [];
      entries.push(entry);
      entriesByPath.set(entry.path, entries);
    }
    const files: ConflictFileState[] = [];
    for (const [path, entries] of entriesByPath) {
      const statusRecord = statusByPath.get(path);
      const stages = {
        base: await this.createBlobVersion(
          repositoryRoot,
          "base",
          entries,
          1,
          cancellationSignal,
        ),
        current: await this.createBlobVersion(
          repositoryRoot,
          "current",
          entries,
          2,
          cancellationSignal,
        ),
        incoming: await this.createBlobVersion(
          repositoryRoot,
          "incoming",
          entries,
          3,
          cancellationSignal,
        ),
      };
      const workingTree = await readWorkingTreeState(
        repositoryRoot,
        path,
        cancellationSignal,
      );
      const originalPathWorkingTree =
        statusRecord?.originalPath === undefined
          ? undefined
          : await readWorkingTreeState(
              repositoryRoot,
              statusRecord.originalPath,
              cancellationSignal,
            );
      const hasBinaryStage = Object.values(stages).some(
        (stage) => stage?.kind === "binary",
      );
      const hasSubmoduleStage = Object.values(stages).some(
        (stage) => stage?.kind === "submodule",
      );
      const statusCode = statusRecord?.statusCode ?? inferStatusCode(stages);
      // Porcelain-v2 unmerged records expose the destination path only. Keep
      // rename/delete and rename/rename paths separate unless Git provides an
      // explicit source record; matching blob IDs alone is ambiguous.
      const kind = classifyConflictEntry(
        statusCode,
        stages,
        statusRecord?.originalPath,
        hasBinaryStage,
        hasSubmoduleStage,
      );
      files.push({
        path,
        originalPath: statusRecord?.originalPath,
        renamePair:
          statusRecord?.originalPath === undefined
            ? undefined
            : {
                originalPath: statusRecord.originalPath,
                destinationPath: path,
              },
        statusCode,
        kind,
        stages,
        workingTreeContent: workingTree.content,
        workingTreeKind: workingTree.kind,
        workingTreeMode: workingTree.mode,
        workingTreeByteLength: workingTree.byteLength,
        workingTreeDigest: workingTree.digest,
        workingTreeLeafFingerprint: workingTree.leafFingerprint,
        workingTreeParentFingerprint: workingTree.parentFingerprint,
        originalPathWorkingTreeContent: originalPathWorkingTree?.content,
        originalPathWorkingTreeKind: originalPathWorkingTree?.kind,
        originalPathWorkingTreeMode: originalPathWorkingTree?.mode,
        originalPathWorkingTreeByteLength: originalPathWorkingTree?.byteLength,
        originalPathWorkingTreeDigest: originalPathWorkingTree?.digest,
        originalPathWorkingTreeLeafFingerprint:
          originalPathWorkingTree?.leafFingerprint,
        originalPathWorkingTreeParentFingerprint:
          originalPathWorkingTree?.parentFingerprint,
        isResolved: false,
      });
    }
    return files.sort((leftFile, rightFile) =>
      leftFile.path.localeCompare(rightFile.path),
    );
  }

  private async createBlobVersion(
    repositoryRoot: string,
    side: ConflictSide,
    entries: readonly ParsedUnmergedIndexEntry[],
    stage: 1 | 2 | 3,
    cancellationSignal: AbortSignal | undefined,
  ): Promise<ConflictBlobVersion | undefined> {
    const entry = entries.find((candidate) => candidate.stage === stage);
    if (entry === undefined) return undefined;
    if (entry.objectId === undefined) {
      return {
        side,
        objectId: undefined,
        mode: entry.mode,
        exists: false,
        kind: "missing",
        content: undefined,
      };
    }
    if (entry.mode === "160000") {
      return {
        side,
        objectId: entry.objectId,
        mode: entry.mode,
        exists: true,
        kind: "submodule",
        content: undefined,
      };
    }
    if (entry.mode === "120000") {
      let content: Uint8Array | undefined;
      try {
        const objectResult = await this.run(
          repositoryRoot,
          ["cat-file", "blob", entry.objectId],
          cancellationSignal,
          false,
          MAX_CACHED_CONFLICT_BYTES + 1,
          false,
          true,
        );
        const objectBytes = outputBytes(objectResult);
        if (
          objectResult.standardOutputTruncated !== true &&
          objectBytes.length <= MAX_CACHED_CONFLICT_BYTES
        ) {
          content = objectBytes;
        }
      } catch (error: unknown) {
        if (cancellationSignal?.aborted === true) throw error;
        // Keep the stage metadata; side choice fails closed without bytes.
      }
      return {
        side,
        objectId: entry.objectId,
        mode: entry.mode,
        exists: true,
        kind: "binary",
        content,
      };
    }
    let kind: "text" | "binary" = "text";
    let content: Uint8Array | undefined;
    try {
      const objectResult = await this.run(
        repositoryRoot,
        ["cat-file", "blob", entry.objectId],
        cancellationSignal,
        false,
        MAX_CACHED_CONFLICT_BYTES + 1,
        false,
        true,
      );
      const objectBytes = outputBytes(objectResult);
      if (
        objectResult.standardOutputTruncated === true ||
        objectBytes.length > MAX_CACHED_CONFLICT_BYTES
      ) {
        // Keep metadata and classify the object without retaining an unbounded blob.
        kind = "binary";
      } else if (objectBytes.includes(0) || !isStrictUtf8(objectBytes)) {
        kind = "binary";
        content = objectBytes;
      } else {
        content = objectBytes;
      }
    } catch (error: unknown) {
      if (cancellationSignal?.aborted === true) throw error;
      // The stage metadata remains useful even if an object cannot be read.
    }
    return {
      side,
      objectId: entry.objectId,
      mode: entry.mode,
      exists: true,
      kind,
      content,
    };
  }

  private createAction(
    conflictFile: ConflictFileState,
    request: ConflictResolutionRequest,
    operation: ConflictOperationKind,
  ): ConflictResolutionAction {
    const operationSides = conflictOperationSideLabels(operation);
    switch (request.choice) {
      case "keep-current":
        return {
          type: "checkout-side",
          side: "current",
          path: request.path,
          explanation: `${operationSides.current}: ${operationSides.currentExplanation}`,
        };
      case "keep-incoming":
        return {
          type: "checkout-side",
          side: "incoming",
          path: request.path,
          explanation: `${operationSides.incoming}: ${operationSides.incomingExplanation}`,
        };
      case "combine":
        if (request.combinedContent === undefined) {
          throw new ConflictOperationError(
            "invalid-plan",
            `Combine for ${request.path} needs explicit combined bytes; the service will not invent content.`,
          );
        }
        return {
          type: "write-content",
          path: request.path,
          content: request.combinedContent,
          explanation: `Write the explicitly supplied combined content for ${conflictFile.path}.`,
        };
      case "manual":
        return {
          type: "open-merge-editor",
          path: request.path,
          commandIdentifier: "git.openMergeEditor",
          explanation: `Open ${conflictFile.path} with Base, Current, and Incoming panes.`,
        };
    }
  }

  private async assertApplyMutationReady(
    repositoryRoot: string,
    relativePaths: readonly string[],
    expectedGitDirectory: string | undefined,
    cancellationSignal: AbortSignal | undefined,
    allowNonRegularLeaf: boolean,
    expectedIdentities: MutationIdentityExpectation,
    expectedApplyContextFingerprint: string | undefined,
    applyContextIgnoredPaths: ReadonlySet<string>,
  ): Promise<void> {
    assertNotCancelled(cancellationSignal);
    const currentSnapshot = await this.inspect(repositoryRoot, {
      cancellationSignal,
    });
    assertFreshApplyContext(
      expectedApplyContextFingerprint,
      currentSnapshot,
      applyContextIgnoredPaths,
    );
    await assertMutationContext(
      this.gitCommandRunner,
      repositoryRoot,
      currentSnapshot.gitDirectory ?? expectedGitDirectory,
      relativePaths,
      cancellationSignal,
      allowNonRegularLeaf,
      {
        repositoryRoot:
          currentSnapshot.repositoryRootIdentity ??
          expectedIdentities.repositoryRoot,
        gitDirectory:
          currentSnapshot.gitDirectoryIdentity ??
          expectedIdentities.gitDirectory,
        rootBinding: expectedIdentities.rootBinding,
      },
    );
  }

  private async runApplyMutation(
    repositoryRoot: string,
    argumentsPassed: readonly string[],
    relativePaths: readonly string[],
    expectedGitDirectory: string | undefined,
    cancellationSignal: AbortSignal | undefined,
    allowNonRegularLeaf: boolean,
    expectedIdentities: MutationIdentityExpectation,
    expectedApplyContextFingerprint: string | undefined,
    applyContextIgnoredPaths: ReadonlySet<string>,
    markMutationStarted: () => void,
  ): Promise<void> {
    await this.assertApplyMutationReady(
      repositoryRoot,
      relativePaths,
      expectedGitDirectory,
      cancellationSignal,
      allowNonRegularLeaf,
      expectedIdentities,
      expectedApplyContextFingerprint,
      applyContextIgnoredPaths,
    );
    this.assertWorkspaceTrusted(`run ${argumentsPassed[0] ?? "Git mutation"}`);
    markMutationStarted();
    await this.run(
      repositoryRoot,
      argumentsPassed,
      cancellationSignal,
      false,
      MAX_OPERATION_METADATA_BYTES,
      false,
      false,
      expectedIdentities.rootBinding,
    );
    await this.assertApplyMutationReady(
      repositoryRoot,
      relativePaths,
      expectedGitDirectory,
      cancellationSignal,
      allowNonRegularLeaf,
      expectedIdentities,
      expectedApplyContextFingerprint,
      applyContextIgnoredPaths,
    );
  }

  private async writeKnownContentThroughGit(
    repositoryRoot: string,
    relativePath: string,
    content: Uint8Array,
    mode: string,
    expectedWorkingTreeKind: "file" | "symlink" | "missing" | undefined,
    expectedWorkingTreeMode: number | undefined,
    expectedWorkingTreeByteLength: number | undefined,
    expectedWorkingTreeDigest: string | undefined,
    expectedWorkingTreeLeafFingerprint: string | undefined,
    expectedWorkingTreeParentFingerprint: string | undefined,
    expectedGitDirectory: string | undefined,
    cancellationSignal: AbortSignal | undefined,
    expectedIdentities: MutationIdentityExpectation,
    expectedApplyContextFingerprint: string | undefined,
    applyContextIgnoredPaths: ReadonlySet<string>,
    markMutationStarted: () => void,
  ): Promise<void> {
    if (content.byteLength > MAX_CACHED_CONFLICT_BYTES) {
      throw new ConflictOperationError(
        "invalid-plan",
        `Content for ${relativePath} exceeds the ${MAX_CACHED_CONFLICT_BYTES} byte safety cap.`,
      );
    }
    const hashObjectOutput = await (async () => {
      await this.assertApplyMutationReady(
        repositoryRoot,
        [relativePath],
        expectedGitDirectory,
        cancellationSignal,
        mode === "120000",
        expectedIdentities,
        expectedApplyContextFingerprint,
        applyContextIgnoredPaths,
      );
      this.assertWorkspaceTrusted("write Git object");
      markMutationStarted();
      const result = await this.gitCommandRunner.run({
        repositoryRoot,
        rootBinding: expectedIdentities.rootBinding,
        arguments: ["hash-object", "-w", "--stdin"],
        standardInput: content,
        cancellationSignal,
        maxStandardOutputBytes: MAX_REFERENCE_OUTPUT_BYTES,
      });
      assertCompleteGitOutput(result, "Git object ID");
      await this.assertApplyMutationReady(
        repositoryRoot,
        [relativePath],
        expectedGitDirectory,
        cancellationSignal,
        mode === "120000",
        expectedIdentities,
        expectedApplyContextFingerprint,
        applyContextIgnoredPaths,
      );
      return result.standardOutput.trim();
    })();
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(hashObjectOutput)) {
      throw new ConflictOperationError(
        "invalid-plan",
        `Git returned an invalid object ID for ${relativePath}; no file was changed.`,
      );
    }
    await this.runApplyMutation(
      repositoryRoot,
      [
        "update-index",
        "--add",
        "--cacheinfo",
        `${mode},${hashObjectOutput},${relativePath}`,
      ],
      [relativePath],
      expectedGitDirectory,
      cancellationSignal,
      mode === "120000",
      expectedIdentities,
      expectedApplyContextFingerprint,
      applyContextIgnoredPaths,
      markMutationStarted,
    );
    assertNotCancelled(cancellationSignal);
    this.assertWorkspaceTrusted("write working-tree bytes");
    markMutationStarted();
    await writeWorkingTreeStateWithBoundWorker(
      repositoryRoot,
      relativePath,
      "write",
      content,
      mode,
      {
        kind: expectedWorkingTreeKind,
        mode: expectedWorkingTreeMode,
        byteLength: expectedWorkingTreeByteLength,
        digest: expectedWorkingTreeDigest,
        leafFingerprint: expectedWorkingTreeLeafFingerprint,
        parentFingerprint: expectedWorkingTreeParentFingerprint,
      },
      expectedIdentities.rootBinding,
      cancellationSignal,
    );
    await this.assertApplyMutationReady(
      repositoryRoot,
      [relativePath],
      expectedGitDirectory,
      cancellationSignal,
      mode === "120000",
      expectedIdentities,
      expectedApplyContextFingerprint,
      applyContextIgnoredPaths,
    );
  }

  private async applyRequest(
    repositoryRoot: string,
    conflictFile: ConflictFileState,
    request: ConflictResolutionRequest,
    expectedGitDirectory: string | undefined,
    cancellationSignal: AbortSignal | undefined,
    expectedApplyContextFingerprint: string | undefined,
    applyContextIgnoredPaths: ReadonlySet<string>,
    expectedIdentities: MutationIdentityExpectation = {},
    markMutationStarted: () => void = () => undefined,
  ): Promise<void> {
    if (request.choice === "combine") {
      if (request.combinedContent === undefined) {
        throw new ConflictOperationError(
          "invalid-plan",
          `Combine for ${request.path} needs explicit combined bytes.`,
        );
      }
      await this.writeKnownContentThroughGit(
        repositoryRoot,
        request.path,
        request.combinedContent,
        conflictFile.stages.current?.mode === "100755" ||
          conflictFile.stages.incoming?.mode === "100755"
          ? "100755"
          : "100644",
        rollbackCompatibleWorkingTreeKind(conflictFile.workingTreeKind),
        conflictFile.workingTreeMode,
        conflictFile.workingTreeByteLength,
        conflictFile.workingTreeDigest,
        conflictFile.workingTreeLeafFingerprint,
        conflictFile.workingTreeParentFingerprint,
        expectedGitDirectory,
        cancellationSignal,
        expectedIdentities,
        expectedApplyContextFingerprint,
        applyContextIgnoredPaths,
        markMutationStarted,
      );
      return;
    }
    const selectedSide: "current" | "incoming" =
      request.choice === "keep-current" ? "current" : "incoming";
    const selectedVersion = conflictFile.stages[selectedSide];
    const allowNonRegularLeaf =
      selectedVersion?.mode === "120000" || selectedVersion?.exists === false;
    await assertMutationContext(
      this.gitCommandRunner,
      repositoryRoot,
      expectedGitDirectory,
      [request.path],
      cancellationSignal,
      allowNonRegularLeaf,
      expectedIdentities,
    );
    if (selectedVersion?.mode === "160000") {
      throw new ConflictOperationError(
        "operation-unavailable",
        `Cannot choose a submodule side for ${request.path} safely. Resolve the gitlink with Git's native merge tooling, then stage it manually.`,
      );
    }
    if (selectedVersion?.mode === "120000") {
      const symlinkBytes = selectedVersion.content;
      if (symlinkBytes === undefined) {
        throw new ConflictOperationError(
          "invalid-plan",
          `Cannot preserve symlink bytes for ${request.path}; resolve it manually.`,
        );
      }
      await this.writeKnownContentThroughGit(
        repositoryRoot,
        request.path,
        symlinkBytes,
        "120000",
        rollbackCompatibleWorkingTreeKind(conflictFile.workingTreeKind),
        conflictFile.workingTreeMode,
        conflictFile.workingTreeByteLength,
        conflictFile.workingTreeDigest,
        conflictFile.workingTreeLeafFingerprint,
        conflictFile.workingTreeParentFingerprint,
        expectedGitDirectory,
        cancellationSignal,
        expectedIdentities,
        expectedApplyContextFingerprint,
        applyContextIgnoredPaths,
        markMutationStarted,
      );
      return;
    }
    if (selectedVersion?.exists === true) {
      if (selectedVersion.content !== undefined) {
        await this.writeKnownContentThroughGit(
          repositoryRoot,
          request.path,
          selectedVersion.content,
          selectedVersion.mode === "100755" ? "100755" : "100644",
          rollbackCompatibleWorkingTreeKind(conflictFile.workingTreeKind),
          conflictFile.workingTreeMode,
          conflictFile.workingTreeByteLength,
          conflictFile.workingTreeDigest,
          conflictFile.workingTreeLeafFingerprint,
          conflictFile.workingTreeParentFingerprint,
          expectedGitDirectory,
          cancellationSignal,
          expectedIdentities,
          expectedApplyContextFingerprint,
          applyContextIgnoredPaths,
          markMutationStarted,
        );
        return;
      }
      throw new ConflictOperationError(
        "invalid-plan",
        `The selected Git side bytes for ${request.path} are unavailable within the safety cap; resolve it with Git's native tooling and stage it manually.`,
      );
    }
    await this.assertApplyMutationReady(
      repositoryRoot,
      [request.path],
      expectedGitDirectory,
      cancellationSignal,
      true,
      expectedIdentities,
      expectedApplyContextFingerprint,
      applyContextIgnoredPaths,
    );
    markMutationStarted();
    await this.runWithStandardInput(
      repositoryRoot,
      ["update-index", "--force-remove", "-z", "--stdin"],
      Buffer.from(`${request.path}\0`),
      cancellationSignal,
      false,
      undefined,
      expectedIdentities.rootBinding,
    );
    await this.assertApplyMutationReady(
      repositoryRoot,
      [request.path],
      expectedGitDirectory,
      cancellationSignal,
      true,
      expectedIdentities,
      expectedApplyContextFingerprint,
      applyContextIgnoredPaths,
    );
    assertNotCancelled(cancellationSignal);
    this.assertWorkspaceTrusted("remove working-tree path");
    markMutationStarted();
    await writeWorkingTreeStateWithBoundWorker(
      repositoryRoot,
      request.path,
      "remove",
      undefined,
      undefined,
      {
        kind: conflictFile.workingTreeKind,
        mode: conflictFile.workingTreeMode,
        byteLength: conflictFile.workingTreeByteLength,
        digest: conflictFile.workingTreeDigest,
        leafFingerprint: conflictFile.workingTreeLeafFingerprint,
        parentFingerprint: conflictFile.workingTreeParentFingerprint,
      },
      expectedIdentities.rootBinding,
      cancellationSignal,
    );
    await this.assertApplyMutationReady(
      repositoryRoot,
      [request.path],
      expectedGitDirectory,
      cancellationSignal,
      true,
      expectedIdentities,
      expectedApplyContextFingerprint,
      applyContextIgnoredPaths,
    );
  }

  private run(
    repositoryRoot: string,
    argumentsPassed: readonly string[],
    cancellationSignal: AbortSignal | undefined,
    collectStandardOutput = true,
    maxStandardOutputBytes: number | undefined = undefined,
    literalPathspecs = false,
    collectStandardOutputBytes = false,
    rootBinding?: GitRootBindingIdentity,
  ): Promise<Awaited<ReturnType<GitCommandRunner["run"]>>> {
    const request: GitCommandRequest = {
      repositoryRoot:
        repositoryRoot.length === 0 ? process.cwd() : repositoryRoot,
      arguments: argumentsPassed,
      cancellationSignal,
      collectStandardOutput,
      collectStandardOutputBytes,
      maxStandardOutputBytes,
      rootBinding,
      literalPathspecs:
        literalPathspecs ||
        [
          "add",
          "rm",
          "checkout",
          "checkout-index",
          "clean",
          "update-index",
        ].includes(argumentsPassed[0] ?? ""),
    };
    return this.gitCommandRunner.run(request);
  }

  private async assertCanonicalRepository(
    repositoryRoot: string,
    cancellationSignal: AbortSignal | undefined,
  ): Promise<string> {
    if (repositoryRoot.length === 0) {
      throw new ConflictOperationError(
        "invalid-plan",
        "A repository root is required for conflict operations.",
      );
    }
    let canonicalRequestedRoot: string;
    try {
      canonicalRequestedRoot = await realpath(repositoryRoot);
    } catch {
      throw new ConflictOperationError(
        "invalid-plan",
        `Repository root does not exist: ${repositoryRoot}.`,
      );
    }
    const rootResult = await this.run(
      canonicalRequestedRoot,
      ["rev-parse", "--show-toplevel"],
      cancellationSignal,
      true,
      MAX_REFERENCE_OUTPUT_BYTES,
    );
    let canonicalGitRoot: string;
    try {
      canonicalGitRoot = await realpath(rootResult.standardOutput.trim());
    } catch {
      throw new ConflictOperationError(
        "invalid-plan",
        "Git did not return a usable repository root.",
      );
    }
    if (canonicalGitRoot !== canonicalRequestedRoot) {
      throw new ConflictOperationError(
        "invalid-plan",
        "The requested path is not the canonical root of the selected Git repository.",
      );
    }
    return canonicalGitRoot;
  }
}

function assertFreshSnapshot(
  expectedFingerprint: string,
  currentSnapshot: ConflictRepositorySnapshot,
): void {
  if (expectedFingerprint !== currentSnapshot.fingerprint) {
    throw new ConflictOperationError(
      "stale-state",
      "The repository changed after the preview. Refresh conflict state before applying anything.",
    );
  }
}

function assertStableRepositoryIdentity(
  expectedSnapshot: ConflictRepositorySnapshot,
  currentSnapshot: ConflictRepositorySnapshot,
): void {
  if (
    expectedSnapshot.repositoryRoot !== currentSnapshot.repositoryRoot ||
    expectedSnapshot.gitDirectory !== currentSnapshot.gitDirectory ||
    expectedSnapshot.repositoryRootIdentity !==
      currentSnapshot.repositoryRootIdentity ||
    expectedSnapshot.gitDirectoryIdentity !==
      currentSnapshot.gitDirectoryIdentity ||
    !sameGitRootBinding(
      expectedSnapshot.repositoryRootBinding,
      currentSnapshot.repositoryRootBinding,
    )
  ) {
    throw new ConflictOperationError(
      "stale-state",
      "The repository root or Git directory changed during the operation; refresh before continuing.",
    );
  }
}

function sameGitRootBinding(
  expectedBinding: GitRootBindingIdentity | undefined,
  currentBinding: GitRootBindingIdentity | undefined,
): boolean {
  if (expectedBinding === undefined || currentBinding === undefined) {
    return expectedBinding === currentBinding;
  }
  return (
    sameGitDirectoryBinding(expectedBinding, currentBinding) &&
    sameGitDirectoryBinding(
      expectedBinding.gitDirectory,
      currentBinding.gitDirectory,
    ) &&
    sameGitDirectoryBinding(
      expectedBinding.commonDirectory,
      currentBinding.commonDirectory,
    )
  );
}

function sameGitDirectoryBinding(
  expectedBinding: {
    readonly canonicalPath: string;
    readonly device: string;
    readonly inode: string;
  },
  currentBinding: {
    readonly canonicalPath: string;
    readonly device: string;
    readonly inode: string;
  },
): boolean {
  return (
    expectedBinding.canonicalPath === currentBinding.canonicalPath &&
    expectedBinding.device === currentBinding.device &&
    expectedBinding.inode === currentBinding.inode
  );
}

function fingerprintApplyContext(
  snapshot: ConflictRepositorySnapshot,
  ignoredPaths: ReadonlySet<string>,
): string {
  const filteredFiles = snapshot.files.filter(
    (conflictFile) => !ignoredPaths.has(conflictFile.path),
  );
  const baseFingerprint = fingerprintSnapshot(
    snapshot.gitDirectory ?? "",
    snapshot.repositoryRootIdentity ?? "",
    snapshot.gitDirectoryIdentity ?? "",
    snapshot.repositoryRootBinding,
    snapshot.headCommit ?? "",
    snapshot.currentBranchName ?? "",
    "",
    "",
    snapshot.operation,
    filteredFiles,
  );
  return baseFingerprint;
}

async function filesystemIdentity(path: string): Promise<string> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch {
    throw new ConflictOperationError(
      "stale-state",
      "A repository identity target changed or disappeared; no mutation was attempted.",
    );
  }
  if (stats.isSymbolicLink()) {
    throw new ConflictOperationError(
      "stale-state",
      "A repository identity target became a symlink; no mutation was attempted.",
    );
  }
  return `${String(stats.dev)}:${String(stats.ino)}`;
}

function assertCompleteGitOutput(
  output: Awaited<ReturnType<GitCommandRunner["run"]>>,
  description: string,
): void {
  if (output.standardOutputTruncated === true) {
    throw new ConflictOperationError(
      "invalid-plan",
      `${description} output exceeded the safety cap; refresh after resolving it with native Git tooling.`,
    );
  }
}

function assertFreshConflictFile(
  expectedFile: ConflictFileState,
  latestFile: ConflictFileState,
): void {
  if (
    expectedFile.path !== latestFile.path ||
    expectedFile.originalPath !== latestFile.originalPath ||
    expectedFile.statusCode !== latestFile.statusCode ||
    expectedFile.kind !== latestFile.kind ||
    expectedFile.isResolved !== latestFile.isResolved ||
    !samePathState(expectedFile, latestFile, false) ||
    !samePathState(expectedFile, latestFile, true) ||
    !sameStages(expectedFile, latestFile)
  ) {
    throw new ConflictOperationError(
      "stale-state",
      `Conflict ${latestFile.path} changed after confirmation. Refresh conflicts and try again.`,
    );
  }
}

function ignoredApplyContextPaths(
  requests: readonly ConflictResolutionRequest[],
  snapshot: ConflictRepositorySnapshot,
): ReadonlySet<string> {
  const ignoredPaths = new Set(requests.map((request) => request.path));
  for (const request of requests) {
    const conflictFile = snapshot.files.find(
      (candidate) => candidate.path === request.path,
    );
    if (conflictFile?.originalPath !== undefined) {
      ignoredPaths.add(conflictFile.originalPath);
    }
  }
  return ignoredPaths;
}

function assertFreshApplyContext(
  expectedFingerprint: string | undefined,
  snapshot: ConflictRepositorySnapshot,
  ignoredPaths: ReadonlySet<string>,
): void {
  if (
    expectedFingerprint !== undefined &&
    expectedFingerprint !== fingerprintApplyContext(snapshot, ignoredPaths)
  ) {
    throw new ConflictOperationError(
      "stale-state",
      "The operation, HEAD, branch, or another conflict changed after confirmation. Refresh conflict state before applying anything.",
    );
  }
}

function samePathState(
  expectedFile: ConflictFileState,
  latestFile: ConflictFileState,
  originalPath: boolean,
): boolean {
  const expectedContent = originalPath
    ? expectedFile.originalPathWorkingTreeContent
    : expectedFile.workingTreeContent;
  const latestContent = originalPath
    ? latestFile.originalPathWorkingTreeContent
    : latestFile.workingTreeContent;
  return (
    (originalPath
      ? expectedFile.originalPathWorkingTreeKind
      : expectedFile.workingTreeKind) ===
      (originalPath
        ? latestFile.originalPathWorkingTreeKind
        : latestFile.workingTreeKind) &&
    (originalPath
      ? expectedFile.originalPathWorkingTreeMode
      : expectedFile.workingTreeMode) ===
      (originalPath
        ? latestFile.originalPathWorkingTreeMode
        : latestFile.workingTreeMode) &&
    (originalPath
      ? expectedFile.originalPathWorkingTreeByteLength
      : expectedFile.workingTreeByteLength) ===
      (originalPath
        ? latestFile.originalPathWorkingTreeByteLength
        : latestFile.workingTreeByteLength) &&
    (originalPath
      ? expectedFile.originalPathWorkingTreeDigest
      : expectedFile.workingTreeDigest) ===
      (originalPath
        ? latestFile.originalPathWorkingTreeDigest
        : latestFile.workingTreeDigest) &&
    (originalPath
      ? expectedFile.originalPathWorkingTreeParentFingerprint
      : expectedFile.workingTreeParentFingerprint) ===
      (originalPath
        ? latestFile.originalPathWorkingTreeParentFingerprint
        : latestFile.workingTreeParentFingerprint) &&
    (originalPath
      ? expectedFile.originalPathWorkingTreeLeafFingerprint
      : expectedFile.workingTreeLeafFingerprint) ===
      (originalPath
        ? latestFile.originalPathWorkingTreeLeafFingerprint
        : latestFile.workingTreeLeafFingerprint) &&
    sameBytes(expectedContent, latestContent)
  );
}

function sameStages(
  expectedFile: ConflictFileState,
  latestFile: ConflictFileState,
): boolean {
  for (const side of ["base", "current", "incoming"] as const) {
    const expectedStage = expectedFile.stages[side];
    const latestStage = latestFile.stages[side];
    if (
      expectedStage?.objectId !== latestStage?.objectId ||
      expectedStage?.mode !== latestStage?.mode ||
      expectedStage?.exists !== latestStage?.exists ||
      expectedStage?.kind !== latestStage?.kind ||
      !sameBytes(expectedStage?.content, latestStage?.content)
    ) {
      return false;
    }
  }
  return true;
}

function sameBytes(
  expectedBytes: Uint8Array | undefined,
  latestBytes: Uint8Array | undefined,
): boolean {
  if (expectedBytes === undefined || latestBytes === undefined) {
    return expectedBytes === latestBytes;
  }
  return (
    Buffer.compare(Buffer.from(expectedBytes), Buffer.from(latestBytes)) === 0
  );
}

function assertConfirmation(confirmation: ConflictConfirmation): void {
  if (typeof confirmation?.confirm !== "function") {
    throw new ConflictOperationError(
      "confirmation-required",
      "An explicit confirmation callback is required before changing Git or files.",
    );
  }
}

function assertRepositoryRelativePath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).includes("..")
  ) {
    throw new ConflictOperationError(
      "invalid-plan",
      `Unsafe repository path: ${JSON.stringify(relativePath)}.`,
    );
  }
}

async function assertWritableTarget(
  repositoryRoot: string,
  relativePath: string,
  allowNonRegularLeaf = false,
): Promise<string> {
  assertRepositoryRelativePath(relativePath);
  const parentFingerprint = await assertParentDirectoriesNoFollow(
    repositoryRoot,
    relativePath,
  );
  const canonicalRoot = resolve(repositoryRoot);
  const absolutePath = resolve(canonicalRoot, relativePath);
  const resolvedRelativePath = relative(canonicalRoot, absolutePath);
  if (
    resolvedRelativePath === "" ||
    resolvedRelativePath === ".." ||
    resolvedRelativePath.startsWith("../") ||
    isAbsolute(resolvedRelativePath)
  ) {
    throw new ConflictOperationError(
      "invalid-plan",
      `Path escapes repository: ${relativePath}.`,
    );
  }
  try {
    const pathStats = await lstat(absolutePath);
    if (
      pathStats.isDirectory() ||
      (!pathStats.isFile() &&
        !(pathStats.isSymbolicLink() && allowNonRegularLeaf))
    ) {
      throw new ConflictOperationError(
        "invalid-plan",
        `Cannot mutate non-regular path ${relativePath}. Resolve it manually.`,
      );
    }
    if (pathStats.isSymbolicLink() && !allowNonRegularLeaf) {
      throw new ConflictOperationError(
        "invalid-plan",
        `Cannot combine into symlink ${relativePath}. Resolve it manually.`,
      );
    }
  } catch (error: unknown) {
    if (isFileMissingError(error)) return parentFingerprint;
    throw error;
  }
  return parentFingerprint;
}

async function assertParentDirectoriesNoFollow(
  repositoryRoot: string,
  relativePath: string,
  expectedFingerprint?: string,
): Promise<string> {
  const parentFingerprint = await readParentDirectoryFingerprint(
    repositoryRoot,
    relativePath,
  );
  if (parentFingerprint.startsWith("missing:")) {
    throw new ConflictOperationError(
      "invalid-plan",
      `Cannot write through a missing parent directory: ${relativePath}.`,
    );
  }
  if (
    expectedFingerprint !== undefined &&
    parentFingerprint !== expectedFingerprint
  ) {
    throw new ConflictOperationError(
      "stale-state",
      `Parent directory changed while preparing ${relativePath}; no write was attempted.`,
    );
  }
  return parentFingerprint;
}

async function readParentDirectoryFingerprint(
  repositoryRoot: string,
  relativePath: string,
  cancellationSignal?: AbortSignal,
): Promise<string> {
  assertNotCancelled(cancellationSignal);
  const canonicalRoot = resolve(repositoryRoot);
  const pathSegments = relativePath.split(/[\\/]/);
  let currentPath = canonicalRoot;
  const rootStats = await lstat(canonicalRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new ConflictOperationError(
      "invalid-plan",
      "The repository root is not a stable directory.",
    );
  }
  const fingerprintParts = [
    `root:${String(rootStats.dev)}:${String(rootStats.ino)}:${String(rootStats.mode & 0o7777)}`,
  ];
  for (const pathSegment of pathSegments.slice(0, -1)) {
    assertNotCancelled(cancellationSignal);
    if (pathSegment.length === 0 || pathSegment === ".") continue;
    currentPath = join(currentPath, pathSegment);
    try {
      const stats = await lstat(currentPath);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new ConflictOperationError(
          "invalid-plan",
          `Cannot write through non-directory path ${relativePath}.`,
        );
      }
      const canonicalParent = await realpath(currentPath);
      if (canonicalParent !== currentPath) {
        throw new ConflictOperationError(
          "invalid-plan",
          `Cannot write through a redirected parent directory: ${relativePath}.`,
        );
      }
      fingerprintParts.push(
        `${pathSegment}:${String(stats.dev)}:${String(stats.ino)}:${String(stats.mode & 0o7777)}`,
      );
    } catch (error: unknown) {
      if (isFileMissingError(error)) {
        return `missing:${currentPath}`;
      }
      throw error;
    }
  }
  return fingerprintParts.join("/");
}

async function assertMutationContext(
  gitCommandRunner: GitCommandRunner,
  repositoryRoot: string,
  expectedGitDirectory: string | undefined,
  relativePaths: readonly string[],
  cancellationSignal: AbortSignal | undefined,
  allowNonRegularLeaf = false,
  expectedIdentities: MutationIdentityExpectation = {},
): Promise<void> {
  assertNotCancelled(cancellationSignal);
  if (expectedIdentities.rootBinding === undefined) {
    throw new ConflictOperationError(
      "stale-state",
      "The complete repository binding is unavailable; no mutation was attempted.",
    );
  }
  let canonicalRequestedRoot: string;
  try {
    canonicalRequestedRoot = await realpath(repositoryRoot);
  } catch {
    throw new ConflictOperationError(
      "stale-state",
      "The repository root changed or disappeared; no mutation was attempted.",
    );
  }
  const rootResult = await gitCommandRunner.run({
    repositoryRoot: canonicalRequestedRoot,
    arguments: ["rev-parse", "--show-toplevel"],
    cancellationSignal,
    maxStandardOutputBytes: MAX_REFERENCE_OUTPUT_BYTES,
    rootBinding: expectedIdentities.rootBinding,
    rootBindingRequired: true,
  });
  assertCompleteGitOutput(rootResult, "Git repository root");
  let canonicalGitRoot: string;
  try {
    canonicalGitRoot = await realpath(rootResult.standardOutput.trim());
  } catch {
    throw new ConflictOperationError(
      "stale-state",
      "Git repository root changed during mutation validation; no mutation was attempted.",
    );
  }
  if (canonicalGitRoot !== canonicalRequestedRoot) {
    throw new ConflictOperationError(
      "stale-state",
      "Git repository root changed during mutation validation; no mutation was attempted.",
    );
  }
  if (expectedIdentities.repositoryRoot !== undefined) {
    const currentRepositoryRootIdentity = await filesystemIdentity(
      canonicalRequestedRoot,
    );
    if (currentRepositoryRootIdentity !== expectedIdentities.repositoryRoot) {
      throw new ConflictOperationError(
        "stale-state",
        "The repository root identity changed after confirmation; no mutation was attempted.",
      );
    }
  }
  const gitDirectoryResult = await gitCommandRunner.run({
    repositoryRoot: canonicalRequestedRoot,
    arguments: ["rev-parse", "--absolute-git-dir"],
    cancellationSignal,
    maxStandardOutputBytes: MAX_REFERENCE_OUTPUT_BYTES,
    rootBinding: expectedIdentities.rootBinding,
    rootBindingRequired: true,
  });
  assertCompleteGitOutput(gitDirectoryResult, "Git directory");
  const currentGitDirectory = await canonicalGitDirectory(
    gitDirectoryResult.standardOutput.trim(),
  );
  if (
    expectedGitDirectory !== undefined &&
    currentGitDirectory !== expectedGitDirectory
  ) {
    throw new ConflictOperationError(
      "stale-state",
      "Git directory changed after confirmation; no mutation was attempted.",
    );
  }
  if (expectedIdentities.gitDirectory !== undefined) {
    const currentGitDirectoryIdentity =
      await filesystemIdentity(currentGitDirectory);
    if (currentGitDirectoryIdentity !== expectedIdentities.gitDirectory) {
      throw new ConflictOperationError(
        "stale-state",
        "The Git directory identity changed after confirmation; no mutation was attempted.",
      );
    }
  }
  for (const relativePath of relativePaths) {
    await assertWritableTarget(
      canonicalRequestedRoot,
      relativePath,
      allowNonRegularLeaf,
    );
  }
}

function createRollbackPlan(
  snapshot: ConflictRepositorySnapshot,
  selectedPaths: readonly string[],
): ConflictRollbackPlan {
  const filesByPath = new Map<string, ConflictRollbackFileSnapshot>();
  const selectedPathSet = new Set(selectedPaths);
  for (const conflictFile of snapshot.files) {
    if (!selectedPathSet.has(conflictFile.path)) continue;
    filesByPath.set(conflictFile.path, {
      path: conflictFile.path,
      workingTreeContent: conflictFile.workingTreeContent,
      workingTreeKind: rollbackCompatibleWorkingTreeKind(
        conflictFile.workingTreeKind,
      ),
      workingTreeMode: conflictFile.workingTreeMode,
      workingTreeParentFingerprint: conflictFile.workingTreeParentFingerprint,
      workingTreeLeafFingerprint: conflictFile.workingTreeLeafFingerprint,
      stageEntries: stageEntriesForRollback(conflictFile),
    });
    if (conflictFile.originalPath !== undefined) {
      // Rename conflicts have two working-tree names even when the index only
      // reports stages for the destination name.
      filesByPath.set(conflictFile.originalPath, {
        path: conflictFile.originalPath,
        workingTreeContent: conflictFile.originalPathWorkingTreeContent,
        workingTreeKind: rollbackCompatibleWorkingTreeKind(
          conflictFile.originalPathWorkingTreeKind,
        ),
        workingTreeMode: conflictFile.originalPathWorkingTreeMode,
        workingTreeParentFingerprint:
          conflictFile.originalPathWorkingTreeParentFingerprint,
        workingTreeLeafFingerprint:
          conflictFile.originalPathWorkingTreeLeafFingerprint,
        stageEntries: [],
      });
    }
  }
  const files = [...filesByPath.values()];
  const ignoredPaths = new Set(files.map((file) => file.path));
  const commandPlan = [
    `git update-index --force-remove -- ${files.map((file) => quotePath(literalPathspec(file.path))).join(" ")}`,
    "git update-index --index-info -z <recorded stage records>",
    "restore recorded working-tree bytes without following symlinks",
  ];
  return {
    repositoryRoot: snapshot.repositoryRoot,
    sourceSnapshotFingerprint: snapshot.fingerprint,
    sourceGitDirectory: snapshot.gitDirectory,
    sourceRepositoryRootIdentity: snapshot.repositoryRootIdentity,
    sourceGitDirectoryIdentity: snapshot.gitDirectoryIdentity,
    sourceRepositoryRootBinding: snapshot.repositoryRootBinding,
    sourceApplyContextFingerprint: fingerprintApplyContext(
      snapshot,
      ignoredPaths,
    ),
    files,
    commandPlan,
    warning:
      "Automatic rollback restores the exact recorded index stages and working-tree bytes if any selected resolution fails.",
  };
}

function createRollbackExpectedStates(
  rollbackPlan: ConflictRollbackPlan,
  snapshot: ConflictRepositorySnapshot,
): Map<string, BoundWorkingTreeMutationExpectation> {
  const expectedStates = new Map<string, BoundWorkingTreeMutationExpectation>();
  for (const rollbackFile of rollbackPlan.files) {
    const conflictFile = snapshot.files.find(
      (candidate) => candidate.path === rollbackFile.path,
    );
    if (conflictFile !== undefined) {
      expectedStates.set(
        rollbackFile.path,
        mutationExpectationFromConflictFile(conflictFile, false),
      );
      continue;
    }
    const renameSourceFile = snapshot.files.find(
      (candidate) => candidate.originalPath === rollbackFile.path,
    );
    if (renameSourceFile !== undefined) {
      expectedStates.set(
        rollbackFile.path,
        mutationExpectationFromConflictFile(renameSourceFile, true),
      );
      continue;
    }
    expectedStates.set(rollbackFile.path, {
      kind: rollbackFile.workingTreeKind,
      mode: rollbackFile.workingTreeMode,
      byteLength: rollbackFile.workingTreeContent?.byteLength,
      digest:
        rollbackFile.workingTreeContent === undefined
          ? undefined
          : createHash("sha256")
              .update(rollbackFile.workingTreeContent)
              .digest("hex"),
      leafFingerprint: rollbackFile.workingTreeLeafFingerprint,
      parentFingerprint: rollbackFile.workingTreeParentFingerprint,
    });
  }
  return expectedStates;
}

function mutationExpectationFromConflictFile(
  conflictFile: ConflictFileState,
  originalPath: boolean,
): BoundWorkingTreeMutationExpectation {
  return {
    kind: originalPath
      ? conflictFile.originalPathWorkingTreeKind
      : conflictFile.workingTreeKind,
    mode: originalPath
      ? conflictFile.originalPathWorkingTreeMode
      : conflictFile.workingTreeMode,
    byteLength: originalPath
      ? conflictFile.originalPathWorkingTreeByteLength
      : conflictFile.workingTreeByteLength,
    digest: originalPath
      ? conflictFile.originalPathWorkingTreeDigest
      : conflictFile.workingTreeDigest,
    leafFingerprint: originalPath
      ? conflictFile.originalPathWorkingTreeLeafFingerprint
      : conflictFile.workingTreeLeafFingerprint,
    parentFingerprint: originalPath
      ? conflictFile.originalPathWorkingTreeParentFingerprint
      : conflictFile.workingTreeParentFingerprint,
  };
}

function hasExactRollbackBytes(conflictFile: ConflictFileState): boolean {
  const destinationBytesAvailable =
    conflictFile.workingTreeKind === "symlink"
      ? conflictFile.workingTreeContent !== undefined
      : conflictFile.workingTreeContent !== undefined ||
        conflictFile.workingTreeKind === "missing";
  const sourceBytesAvailable =
    conflictFile.originalPath === undefined ||
    (conflictFile.originalPathWorkingTreeKind === "symlink"
      ? conflictFile.originalPathWorkingTreeContent !== undefined
      : conflictFile.originalPathWorkingTreeContent !== undefined ||
        conflictFile.originalPathWorkingTreeKind === "missing");
  return destinationBytesAvailable && sourceBytesAvailable;
}

function rollbackCompatibleWorkingTreeKind(
  kind: ConflictFileState["workingTreeKind"],
): "file" | "symlink" | "missing" | undefined {
  return kind === "special" ? undefined : kind;
}

function stageEntriesForRollback(
  conflictFile: ConflictFileState,
): ConflictRollbackFileSnapshot["stageEntries"] {
  const stageEntries: {
    readonly stage: 1 | 2 | 3;
    readonly mode: string;
    readonly objectId: string;
  }[] = [];
  const stageBySide: readonly [1 | 2 | 3, ConflictSide][] = [
    [1, "base"],
    [2, "current"],
    [3, "incoming"],
  ];
  for (const [stage, side] of stageBySide) {
    const version = conflictFile.stages[side];
    if (version?.objectId === undefined || version.mode === undefined) continue;
    stageEntries.push({
      stage,
      mode: version.mode,
      objectId: version.objectId,
    });
  }
  return stageEntries;
}

function rollbackIndexInput(rollbackPlan: ConflictRollbackPlan): Uint8Array {
  const records: string[] = [];
  for (const file of rollbackPlan.files) {
    for (const entry of file.stageEntries) {
      records.push(
        `${entry.mode} ${entry.objectId} ${entry.stage}\t${file.path}`,
      );
    }
  }
  return Buffer.from(records.length === 0 ? "" : `${records.join("\0")}\0`);
}

function formatResolutionPreviewLine(
  request: ConflictResolutionRequest,
  labels: Readonly<Pick<Record<ConflictSide, string>, "current" | "incoming">>,
): string {
  const choiceLabel =
    request.choice === "keep-current"
      ? labels.current
      : request.choice === "keep-incoming"
        ? labels.incoming
        : request.choice === "combine"
          ? "Explicit combined content"
          : "Manual VS Code merge editor";
  return `- ${request.path}: ${choiceLabel}.`;
}

function operationCommand(
  operation: ConflictOperationKind,
  action: "abort" | "continue" | "skip",
): readonly string[] {
  const operationCommandName = operation === "am" ? "am" : operation;
  return ["-c", "core.editor=true", operationCommandName, `--${action}`];
}

function inferStatusCode(
  stages: Readonly<Record<ConflictSide, ConflictBlobVersion | undefined>>,
): string {
  const hasCurrent = stages.current?.exists === true;
  const hasIncoming = stages.incoming?.exists === true;
  if (!hasCurrent && !hasIncoming) return "DD";
  if (!hasCurrent || !hasIncoming) return "UD";
  return "UU";
}

function normalizeOptionalText(text: string): string | undefined {
  const normalizedText = text.trim();
  return normalizedText.length === 0 ? undefined : normalizedText;
}

async function canonicalGitDirectory(
  gitDirectoryOutput: string,
): Promise<string> {
  if (gitDirectoryOutput.length === 0 || !isAbsolute(gitDirectoryOutput)) {
    throw new ConflictOperationError(
      "invalid-plan",
      "Git did not return an absolute canonical Git directory.",
    );
  }
  try {
    return await realpath(gitDirectoryOutput);
  } catch {
    throw new ConflictOperationError(
      "invalid-plan",
      "Git directory is unavailable or changed during inspection.",
    );
  }
}

async function canonicalGitPath(
  repositoryRoot: string,
  gitPathOutput: string,
): Promise<string> {
  if (gitPathOutput.length === 0) {
    throw new ConflictOperationError(
      "invalid-plan",
      "Git did not return a usable Git common directory.",
    );
  }
  try {
    return await realpath(resolve(repositoryRoot, gitPathOutput));
  } catch {
    throw new ConflictOperationError(
      "invalid-plan",
      "Git common directory is unavailable or changed during inspection.",
    );
  }
}

async function captureGitRootBinding(
  repositoryRoot: string,
  gitDirectory: string,
  commonDirectory: string,
  cancellationSignal: AbortSignal | undefined,
): Promise<GitRootBindingIdentity> {
  return {
    ...(await captureDirectoryBinding(
      repositoryRoot,
      "repository root",
      cancellationSignal,
    )),
    gitDirectory: await captureDirectoryBinding(
      gitDirectory,
      "Git directory",
      cancellationSignal,
    ),
    commonDirectory: await captureDirectoryBinding(
      commonDirectory,
      "Git common directory",
      cancellationSignal,
    ),
  };
}

async function captureDirectoryBinding(
  directoryPath: string,
  description: string,
  cancellationSignal: AbortSignal | undefined,
): Promise<GitRootBindingIdentity["gitDirectory"]> {
  assertNotCancelled(cancellationSignal);
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(directoryPath);
  } catch {
    throw new ConflictOperationError(
      "stale-state",
      `${description} changed or disappeared; no mutation was attempted.`,
    );
  }
  assertNotCancelled(cancellationSignal);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new ConflictOperationError(
      "stale-state",
      `${description} is not a stable directory; no mutation was attempted.`,
    );
  }
  return {
    canonicalPath: directoryPath,
    device: String(stats.dev),
    inode: String(stats.ino),
  };
}

function formatOperationTarget(operation: ConflictOperationState): string {
  const targetRef = operation.targetRef ?? "checked-out target";
  const targetCommit = operation.targetCommit;
  return targetCommit === undefined || targetRef === targetCommit
    ? targetRef
    : `${targetRef} @ ${targetCommit}`;
}

function formatOperationSource(operation: ConflictOperationState): string {
  const sourceRef = operation.sourceRef;
  const sourceCommit = operation.sourceCommit;
  if (
    sourceRef !== undefined &&
    sourceCommit !== undefined &&
    sourceRef !== sourceCommit
  ) {
    return `${sourceRef} @ ${sourceCommit}`;
  }
  if (sourceCommit !== undefined) return sourceCommit;
  return operation.sourceDescription;
}

async function detectOperation(
  gitDirectory: string,
  repositoryRoot: string,
  gitCommandRunner: GitCommandRunner,
  cancellationSignal: AbortSignal | undefined,
  targetCommit: string | undefined,
  targetRef: string | undefined,
): Promise<ConflictOperationState | undefined> {
  const rebaseMergeDirectory = join(gitDirectory, "rebase-merge");
  const rebaseApplyDirectory = join(gitDirectory, "rebase-apply");
  const hasRebaseMerge = await pathExists(
    rebaseMergeDirectory,
    cancellationSignal,
  );
  const hasRebaseApply = await pathExists(
    rebaseApplyDirectory,
    cancellationSignal,
  );
  if (
    hasRebaseApply &&
    (await pathExists(
      join(rebaseApplyDirectory, "applying"),
      cancellationSignal,
    ))
  ) {
    const sourceCommit =
      (await readFirstLine(
        join(rebaseApplyDirectory, "original-commit"),
        cancellationSignal,
      )) ??
      (await readGitReference(
        repositoryRoot,
        "AM_HEAD",
        gitCommandRunner,
        cancellationSignal,
      ));
    return {
      kind: "am",
      label: operationLabel("am"),
      sourceDescription:
        "The mail patch currently being applied to the checked-out target.",
      sourceCommit,
      targetRef,
      targetCommit,
      metadataPath: rebaseApplyDirectory,
      canAbort: true,
    };
  }
  if (hasRebaseMerge || hasRebaseApply) {
    const metadataDirectory = hasRebaseMerge
      ? rebaseMergeDirectory
      : rebaseApplyDirectory;
    const sourceCommit = await readGitReference(
      repositoryRoot,
      "REBASE_HEAD",
      gitCommandRunner,
      cancellationSignal,
    );
    const metadataTargetCommit =
      (await readFirstLine(
        join(metadataDirectory, "onto"),
        cancellationSignal,
      )) ?? targetCommit;
    const metadataSourceRef = await readFirstLine(
      join(metadataDirectory, "head-name"),
      cancellationSignal,
    );
    return {
      kind: "rebase",
      label: operationLabel("rebase"),
      sourceDescription:
        "The commit currently being replayed onto the checked-out branch.",
      sourceCommit,
      sourceRef: metadataSourceRef,
      targetRef: metadataTargetCommit,
      targetCommit: metadataTargetCommit,
      metadataPath: metadataDirectory,
      canAbort: true,
    };
  }
  const markerDefinitions: readonly [ConflictOperationKind, string, string][] =
    [
      [
        "merge",
        "MERGE_HEAD",
        "The branch or commit being merged into the checked-out branch.",
      ],
      [
        "cherry-pick",
        "CHERRY_PICK_HEAD",
        "The commit being applied to the checked-out branch.",
      ],
      [
        "revert",
        "REVERT_HEAD",
        "The commit whose change is being reversed on the checked-out branch.",
      ],
    ];
  for (const [kind, markerName, sourceDescription] of markerDefinitions) {
    const markerPath = join(gitDirectory, markerName);
    if (!(await pathExists(markerPath, cancellationSignal))) continue;
    const sourceCommit = await readFirstLine(markerPath, cancellationSignal);
    return {
      kind,
      label: operationLabel(kind),
      sourceDescription,
      sourceCommit,
      targetRef,
      targetCommit,
      metadataPath: markerPath,
      canAbort: true,
    };
  }
  return undefined;
}

async function readGitReference(
  repositoryRoot: string,
  referenceName: string,
  gitCommandRunner: GitCommandRunner,
  cancellationSignal: AbortSignal | undefined,
): Promise<string | undefined> {
  try {
    const result = await gitCommandRunner.run({
      repositoryRoot,
      arguments: ["rev-parse", "--verify", referenceName],
      cancellationSignal,
      maxStandardOutputBytes: MAX_REFERENCE_OUTPUT_BYTES,
    });
    if (result.standardOutputTruncated === true) return undefined;
    return normalizeOptionalText(result.standardOutput);
  } catch (error: unknown) {
    if (cancellationSignal?.aborted === true) throw error;
    return undefined;
  }
}

async function readFirstLine(
  filePath: string,
  cancellationSignal?: AbortSignal,
): Promise<string | undefined> {
  try {
    assertNotCancelled(cancellationSignal);
    const metadataRead = await readRegularFileNoFollow(
      filePath,
      MAX_OPERATION_METADATA_BYTES,
      cancellationSignal,
    );
    if (metadataRead.content === undefined) return undefined;
    const firstLine = Buffer.from(metadataRead.content)
      .toString("utf8")
      .split(/\r?\n/, 1)[0];
    return normalizeOptionalText(firstLine ?? "");
  } catch (error: unknown) {
    if (cancellationSignal?.aborted === true) throw error;
    return undefined;
  }
}

async function fingerprintOperationMetadata(
  operation: ConflictOperationState,
  cancellationSignal?: AbortSignal,
): Promise<string> {
  assertNotCancelled(cancellationSignal);
  const metadataStats = await lstat(operation.metadataPath);
  const hash = createHash("sha256");
  let totalMetadataBytes = 0;
  const updateMetadata = (name: string, bytes: Uint8Array): void => {
    hash.update(name);
    hash.update("\0");
    hash.update(String(bytes.byteLength));
    hash.update(":");
    hash.update(bytes);
    hash.update("\0");
    totalMetadataBytes += bytes.byteLength;
    if (totalMetadataBytes > MAX_CACHED_CONFLICT_BYTES) {
      throw new ConflictOperationError(
        "invalid-plan",
        "Git operation metadata exceeds the bounded safety cap; refresh after resolving it with native Git tooling.",
      );
    }
  };
  if (metadataStats.isSymbolicLink()) {
    throw new ConflictOperationError(
      "invalid-plan",
      "Git operation metadata uses a symlink; conflict controls are disabled until native Git restores it.",
    );
  }
  if (metadataStats.isFile()) {
    const metadataRead = await readRegularFileNoFollow(
      operation.metadataPath,
      MAX_OPERATION_METADATA_BYTES,
      cancellationSignal,
    );
    if (metadataRead.content === undefined) {
      throw new ConflictOperationError(
        "invalid-plan",
        "Git operation metadata exceeds the bounded safety cap; conflict controls are disabled.",
      );
    }
    updateMetadata(operation.metadataPath, metadataRead.content);
    return hash.digest("hex");
  }
  if (!metadataStats.isDirectory()) {
    throw new ConflictOperationError(
      "invalid-plan",
      "Git operation metadata is not a regular file or directory; conflict controls are disabled.",
    );
  }
  const metadataEntries = (await readdir(operation.metadataPath)).sort();
  if (metadataEntries.length > 128) {
    throw new ConflictOperationError(
      "invalid-plan",
      "Git operation metadata contains too many entries; conflict controls are disabled.",
    );
  }
  for (const metadataEntry of metadataEntries) {
    assertNotCancelled(cancellationSignal);
    const metadataEntryPath = join(operation.metadataPath, metadataEntry);
    const entryStats = await lstat(metadataEntryPath);
    if (entryStats.isSymbolicLink()) {
      throw new ConflictOperationError(
        "invalid-plan",
        "Git operation metadata contains a symlink; conflict controls are disabled.",
      );
    }
    if (!entryStats.isFile()) {
      updateMetadata(metadataEntry, Buffer.from(String(entryStats.mode)));
      continue;
    }
    const entryRead = await readRegularFileNoFollow(
      metadataEntryPath,
      MAX_OPERATION_METADATA_BYTES,
      cancellationSignal,
    );
    if (entryRead.content === undefined) {
      throw new ConflictOperationError(
        "invalid-plan",
        "Git operation metadata exceeds the bounded safety cap; conflict controls are disabled.",
      );
    }
    updateMetadata(metadataEntry, entryRead.content);
  }
  return hash.digest("hex");
}

async function pathExists(
  path: string,
  cancellationSignal?: AbortSignal,
): Promise<boolean> {
  assertNotCancelled(cancellationSignal);
  try {
    const stats = await lstat(path);
    assertNotCancelled(cancellationSignal);
    return !stats.isSymbolicLink();
  } catch (error: unknown) {
    if (cancellationSignal?.aborted === true) throw error;
    return false;
  }
}

async function readRegularFileNoFollow(
  absolutePath: string,
  contentByteCap: number,
  cancellationSignal?: AbortSignal,
): Promise<{
  readonly content: Uint8Array | undefined;
  readonly byteLength: number;
  readonly mode: number;
  readonly digest: string | undefined;
}> {
  assertNotCancelled(cancellationSignal);
  const noFollowFlag =
    (fsConstants as { readonly O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const nonBlockFlag =
    (fsConstants as { readonly O_NONBLOCK?: number }).O_NONBLOCK ?? 0;
  const fileHandle =
    process.platform === "linux"
      ? await openAbsoluteRegularFileWithDirectoryFd(
          absolutePath,
          noFollowFlag,
          nonBlockFlag,
        )
      : await open(
          absolutePath,
          fsConstants.O_RDONLY | noFollowFlag | nonBlockFlag,
        );
  try {
    const boundedRead = await readRegularFileHandle(
      fileHandle,
      absolutePath,
      contentByteCap,
      cancellationSignal,
    );
    return boundedRead;
  } finally {
    await fileHandle.close();
  }
}

async function openAbsoluteRegularFileWithDirectoryFd(
  absolutePath: string,
  noFollowFlag: number,
  nonBlockFlag: number,
): Promise<Awaited<ReturnType<typeof open>>> {
  const directoryFlag =
    (fsConstants as { readonly O_DIRECTORY?: number }).O_DIRECTORY ?? 0;
  if (directoryFlag === 0 || !isAbsolute(absolutePath)) {
    return open(
      absolutePath,
      fsConstants.O_RDONLY | noFollowFlag | nonBlockFlag,
    );
  }
  const rootHandle = await open(
    "/",
    fsConstants.O_RDONLY | directoryFlag | noFollowFlag,
  );
  let parentHandle = rootHandle;
  try {
    const pathSegments = absolutePath.split("/").filter(Boolean);
    const leafName = pathSegments.pop();
    if (leafName === undefined) {
      throw new ConflictOperationError(
        "invalid-plan",
        `A regular file path is required: ${absolutePath}.`,
      );
    }
    for (const pathSegment of pathSegments) {
      const childDirectory = await open(
        linuxDirectoryFdPath(parentHandle.fd, pathSegment),
        fsConstants.O_RDONLY | directoryFlag | noFollowFlag,
      );
      if (parentHandle !== rootHandle) await parentHandle.close();
      parentHandle = childDirectory;
    }
    return await open(
      linuxDirectoryFdPath(parentHandle.fd, leafName),
      fsConstants.O_RDONLY | noFollowFlag | nonBlockFlag,
    );
  } finally {
    if (parentHandle !== rootHandle) await parentHandle.close();
    await rootHandle.close();
  }
}

async function readRegularFileHandle(
  fileHandle: Awaited<ReturnType<typeof open>>,
  displayPath: string,
  contentByteCap: number,
  cancellationSignal?: AbortSignal,
): Promise<{
  readonly content: Uint8Array | undefined;
  readonly byteLength: number;
  readonly mode: number;
  readonly digest: string | undefined;
}> {
  const digest = createHash("sha256");
  const readBuffer = Buffer.allocUnsafe(64 * 1024);
  const contentChunks: Buffer[] = [];
  let totalBytesRead = 0;
  let contentWithinCap = true;
  let capturedByteCount = 0;
  let fileMode = 0;
  const fileStats = await fileHandle.stat();
  assertNotCancelled(cancellationSignal);
  if (!fileStats.isFile()) {
    throw new ConflictOperationError(
      "invalid-plan",
      `Expected a regular file: ${displayPath}.`,
    );
  }
  fileMode = fileStats.mode & 0o777;
  const maximumReadBytes = contentByteCap + 1;
  while (totalBytesRead < maximumReadBytes) {
    assertNotCancelled(cancellationSignal);
    const readResult = await fileHandle.read(
      readBuffer,
      0,
      Math.min(readBuffer.length, maximumReadBytes - totalBytesRead),
      null,
    );
    if (readResult.bytesRead === 0) break;
    const chunk = readBuffer.subarray(0, readResult.bytesRead);
    totalBytesRead += readResult.bytesRead;
    digest.update(chunk);
    const captureLimit = contentByteCap + 1;
    if (capturedByteCount < captureLimit) {
      const captureLength = Math.min(
        chunk.byteLength,
        captureLimit - capturedByteCount,
      );
      contentChunks.push(Buffer.from(chunk.subarray(0, captureLength)));
      capturedByteCount += captureLength;
    }
    if (totalBytesRead > contentByteCap) contentWithinCap = false;
  }
  return {
    content: contentWithinCap ? Buffer.concat(contentChunks) : undefined,
    byteLength: totalBytesRead,
    mode: fileMode,
    digest: contentWithinCap ? digest.digest("hex") : undefined,
  };
}

function outputBytes(
  output: Awaited<ReturnType<GitCommandRunner["run"]>>,
): Uint8Array {
  const byteOutput = (
    output as Awaited<ReturnType<GitCommandRunner["run"]>> & {
      readonly standardOutputBytes?: Uint8Array;
    }
  ).standardOutputBytes;
  return byteOutput === undefined
    ? Buffer.from(output.standardOutput, "utf8")
    : byteOutput;
}

function isStrictUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException("Conflict operation cancelled", "AbortError");
  }
}

function formatRollbackErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown rollback error";
}

function formatConflictFinalState(
  snapshot: ConflictRepositorySnapshot,
): string {
  return `operation=${snapshot.operation?.kind ?? "none"}, conflicts=${snapshot.hasUnmergedEntries ? "present" : "none"}, root=${snapshot.repositoryRoot}`;
}

async function readWorkingTreeStateWithDirectoryFd(
  repositoryRoot: string,
  relativePath: string,
  cancellationSignal?: AbortSignal,
): Promise<{
  readonly content: Uint8Array | undefined;
  readonly kind: "file" | "symlink" | "missing" | "special";
  readonly mode: number | undefined;
  readonly byteLength: number | undefined;
  readonly digest: string | undefined;
  readonly leafFingerprint: string | undefined;
  readonly parentFingerprint: string | undefined;
}> {
  const directoryFlag =
    (fsConstants as { readonly O_DIRECTORY?: number }).O_DIRECTORY ?? 0;
  const noFollowFlag =
    (fsConstants as { readonly O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const nonBlockFlag =
    (fsConstants as { readonly O_NONBLOCK?: number }).O_NONBLOCK ?? 0;
  if (
    process.platform !== "linux" ||
    directoryFlag === 0 ||
    noFollowFlag === 0 ||
    nonBlockFlag === 0
  ) {
    throw new ConflictOperationError(
      "invalid-plan",
      "Directory-fd-bound working-tree reads are unavailable on this platform; no mutation was attempted.",
    );
  }
  const rootHandle = await open(
    resolve(repositoryRoot),
    fsConstants.O_RDONLY | directoryFlag | noFollowFlag,
  );
  let parentHandle = rootHandle;
  const pathSegments = relativePath.split(/[\\/]/).filter(Boolean);
  const fingerprintParts: string[] = [];
  try {
    const rootStats = await rootHandle.stat();
    if (!rootStats.isDirectory()) {
      throw new ConflictOperationError(
        "invalid-plan",
        "The repository root is not a stable directory.",
      );
    }
    fingerprintParts.push(
      `root:${String(rootStats.dev)}:${String(rootStats.ino)}:${String(rootStats.mode & 0o7777)}`,
    );
    for (const pathSegment of pathSegments.slice(0, -1)) {
      assertNotCancelled(cancellationSignal);
      const childDirectory = await open(
        linuxDirectoryFdPath(parentHandle.fd, pathSegment),
        fsConstants.O_RDONLY | directoryFlag | noFollowFlag,
      );
      const childStats = await childDirectory.stat();
      if (!childStats.isDirectory()) {
        await childDirectory.close();
        throw new ConflictOperationError(
          "invalid-plan",
          `Cannot read through non-directory path ${relativePath}.`,
        );
      }
      fingerprintParts.push(
        `${pathSegment}:${String(childStats.dev)}:${String(childStats.ino)}:${String(childStats.mode & 0o7777)}`,
      );
      if (parentHandle !== rootHandle) await parentHandle.close();
      parentHandle = childDirectory;
    }
    const leafName = pathSegments.at(-1);
    if (leafName === undefined) {
      throw new ConflictOperationError(
        "invalid-plan",
        `A file path is required: ${relativePath}.`,
      );
    }
    const parentFingerprint = fingerprintParts.join("/");
    const leafPath = linuxDirectoryFdPath(parentHandle.fd, leafName);
    let leafStats;
    try {
      leafStats = await lstat(leafPath);
    } catch (error: unknown) {
      if (isFileMissingError(error)) {
        return {
          content: undefined,
          kind: "missing",
          mode: undefined,
          byteLength: undefined,
          digest: undefined,
          leafFingerprint: undefined,
          parentFingerprint,
        };
      }
      throw error;
    }
    assertNotCancelled(cancellationSignal);
    if (leafStats.isSymbolicLink()) {
      const linkTarget = Buffer.from(
        await readlink(leafPath, { encoding: "buffer" }),
      );
      if (linkTarget.byteLength > MAX_CACHED_CONFLICT_BYTES) {
        throw new ConflictOperationError(
          "invalid-plan",
          `Symlink target for ${relativePath} exceeds the bounded safety cap.`,
        );
      }
      return {
        content: linkTarget,
        kind: "symlink",
        mode: undefined,
        byteLength: linkTarget.byteLength,
        digest: createHash("sha256").update(linkTarget).digest("hex"),
        leafFingerprint: `${String(leafStats.dev)}:${String(leafStats.ino)}`,
        parentFingerprint,
      };
    }
    if (!leafStats.isFile()) {
      return {
        content: undefined,
        kind: "special",
        mode: undefined,
        byteLength: undefined,
        digest: undefined,
        leafFingerprint: `${String(leafStats.dev)}:${String(leafStats.ino)}`,
        parentFingerprint,
      };
    }
    const fileHandle = await open(
      leafPath,
      fsConstants.O_RDONLY | noFollowFlag | nonBlockFlag,
    );
    try {
      const regularFileRead = await readRegularFileHandle(
        fileHandle,
        relativePath,
        MAX_CACHED_CONFLICT_BYTES,
        cancellationSignal,
      );
      const openedStats = await fileHandle.stat();
      const leafFingerprint = `${String(openedStats.dev)}:${String(openedStats.ino)}`;
      const observedLeafFingerprint = `${String(leafStats.dev)}:${String(leafStats.ino)}`;
      if (leafFingerprint !== observedLeafFingerprint) {
        throw new ConflictOperationError(
          "stale-state",
          `Working-tree file ${relativePath} changed during bounded read.`,
        );
      }
      return {
        content: regularFileRead.content,
        kind: "file",
        mode: regularFileRead.mode,
        byteLength: regularFileRead.byteLength,
        digest: regularFileRead.digest,
        leafFingerprint,
        parentFingerprint,
      };
    } finally {
      await fileHandle.close();
    }
  } finally {
    if (parentHandle !== rootHandle) await parentHandle.close();
    await rootHandle.close();
  }
}

function linuxDirectoryFdPath(directoryFd: number, childName: string): string {
  return `/proc/self/fd/${directoryFd}/${childName}`;
}

async function readWorkingTreeStateWithBoundWorker(
  repositoryRoot: string,
  relativePath: string,
  cancellationSignal?: AbortSignal,
): Promise<{
  readonly content: Uint8Array | undefined;
  readonly kind: "file" | "symlink" | "missing" | "special";
  readonly mode: number | undefined;
  readonly byteLength: number | undefined;
  readonly digest: string | undefined;
  readonly leafFingerprint: string | undefined;
  readonly parentFingerprint: string | undefined;
}> {
  assertNotCancelled(cancellationSignal);
  const rootStats = await lstat(repositoryRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new ConflictOperationError(
      "invalid-plan",
      "The repository root is not a stable directory.",
    );
  }
  const childProcess = spawn(
    process.execPath,
    [
      "-e",
      BOUND_WORKING_TREE_READER_SOURCE,
      `${String(rootStats.dev)}:${String(rootStats.ino)}`,
      relativePath,
      String(MAX_CACHED_CONFLICT_BYTES),
    ],
    {
      cwd: repositoryRoot,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const outputChunks: Buffer[] = [];
  const errorChunks: Buffer[] = [];
  const cancellationHandler = (): void => {
    childProcess.kill("SIGTERM");
  };
  if (cancellationSignal !== undefined) {
    cancellationSignal.addEventListener("abort", cancellationHandler, {
      once: true,
    });
  }
  childProcess.stdout.on("data", (chunk: Buffer | string) => {
    outputChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  childProcess.stderr.on("data", (chunk: Buffer | string) => {
    errorChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      childProcess.once("error", reject);
      childProcess.once("close", (code, signal) =>
        resolve(code ?? (signal === null ? 1 : 128)),
      );
    });
    assertNotCancelled(cancellationSignal);
    if (exitCode !== 0) {
      throw new ConflictOperationError(
        "stale-state",
        Buffer.concat(errorChunks).toString("utf8") ||
          `Bounded working-tree read failed for ${relativePath}.`,
      );
    }
    const parsed = JSON.parse(Buffer.concat(outputChunks).toString("utf8")) as {
      readonly content?: string;
      readonly kind: "file" | "symlink" | "missing" | "unsupported";
      readonly mode?: number;
      readonly byteLength?: number;
      readonly digest?: string;
      readonly leafFingerprint?: string;
      readonly parentFingerprint?: string;
    };
    return {
      content:
        parsed.content === undefined
          ? undefined
          : Buffer.from(parsed.content, "base64"),
      kind: parsed.kind === "unsupported" ? "special" : parsed.kind,
      mode: parsed.mode,
      byteLength: parsed.byteLength,
      digest: parsed.digest,
      leafFingerprint: parsed.leafFingerprint,
      parentFingerprint: parsed.parentFingerprint,
    };
  } finally {
    cancellationSignal?.removeEventListener("abort", cancellationHandler);
  }
}

interface BoundWorkingTreeMutationExpectation {
  readonly kind: "file" | "symlink" | "missing" | "special" | undefined;
  readonly mode: number | undefined;
  readonly byteLength: number | undefined;
  readonly digest: string | undefined;
  readonly leafFingerprint: string | undefined;
  readonly parentFingerprint: string | undefined;
}

function mutationExpectationFromWorkingTreeState(
  state: Awaited<ReturnType<typeof readWorkingTreeState>>,
): BoundWorkingTreeMutationExpectation {
  return {
    kind: state.kind,
    mode: state.mode,
    byteLength: state.byteLength,
    digest: state.digest,
    leafFingerprint: state.leafFingerprint,
    parentFingerprint: state.parentFingerprint,
  };
}

async function writeWorkingTreeStateWithBoundWorker(
  repositoryRoot: string,
  relativePath: string,
  operation: "write" | "remove",
  content: Uint8Array | undefined,
  mode: string | undefined,
  expected: BoundWorkingTreeMutationExpectation,
  rootBinding: GitRootBindingIdentity | undefined,
  cancellationSignal: AbortSignal | undefined,
): Promise<void> {
  assertNotCancelled(cancellationSignal);
  if (rootBinding === undefined) {
    throw new ConflictOperationError(
      "stale-state",
      "The complete repository binding is unavailable; no working-tree mutation was attempted.",
    );
  }
  if (content !== undefined && content.byteLength > MAX_CACHED_CONFLICT_BYTES) {
    throw new ConflictOperationError(
      "invalid-plan",
      `Content for ${relativePath} exceeds the bounded safety cap.`,
    );
  }
  const payload = Buffer.from(
    JSON.stringify({
      content:
        content === undefined
          ? undefined
          : Buffer.from(content).toString("base64"),
      mode,
    }),
    "utf8",
  );
  const expectedRootIdentity = `${rootBinding.device}:${rootBinding.inode}`;
  const childProcess = spawn(
    process.execPath,
    [
      "-e",
      BOUND_WORKING_TREE_WRITER_SOURCE,
      expectedRootIdentity,
      relativePath,
      operation,
      String(MAX_CACHED_CONFLICT_BYTES),
      expected.kind ?? "",
      expected.mode === undefined ? "" : String(expected.mode),
      expected.byteLength === undefined ? "" : String(expected.byteLength),
      expected.digest ?? "",
      expected.leafFingerprint ?? "",
      expected.parentFingerprint ?? "",
    ],
    {
      cwd: repositoryRoot,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const outputChunks: Buffer[] = [];
  const errorChunks: Buffer[] = [];
  const cancellationHandler = (): void => {
    childProcess.kill("SIGTERM");
  };
  if (cancellationSignal !== undefined) {
    cancellationSignal.addEventListener("abort", cancellationHandler, {
      once: true,
    });
  }
  childProcess.stdout.on("data", (chunk: Buffer | string) => {
    outputChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  childProcess.stderr.on("data", (chunk: Buffer | string) => {
    errorChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  childProcess.stdin.on("error", () => undefined);
  try {
    childProcess.stdin.end(payload);
    const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
      childProcess.once("error", rejectExit);
      childProcess.once("close", (code, signal) =>
        resolveExit(code ?? (signal === null ? 1 : 128)),
      );
    });
    assertNotCancelled(cancellationSignal);
    if (exitCode !== 0) {
      const errorText = Buffer.concat(errorChunks).toString("utf8");
      throw new ConflictOperationError(
        errorText.includes("special path") ? "invalid-plan" : "stale-state",
        errorText ||
          `Bounded working-tree mutation failed for ${relativePath}.`,
      );
    }
  } finally {
    cancellationSignal?.removeEventListener("abort", cancellationHandler);
  }
}

const BOUND_WORKING_TREE_WRITER_SOURCE = `
const fs = require("node:fs");
const crypto = require("node:crypto");
const expectedRootIdentity = process.argv[1];
const relativePath = process.argv[2];
const operation = process.argv[3];
const byteCap = Number(process.argv[4]);
const expectedKind = process.argv[5];
const expectedMode = process.argv[6] === "" ? undefined : Number(process.argv[6]);
const expectedByteLength = process.argv[7] === "" ? undefined : Number(process.argv[7]);
const expectedDigest = process.argv[8];
const expectedLeafFingerprint = process.argv[9];
const expectedParentFingerprint = process.argv[10];
const noFollowFlag = fs.constants.O_NOFOLLOW || 0;
const nonBlockFlag = fs.constants.O_NONBLOCK || 0;
const identity = (stats) => String(stats.dev) + ":" + String(stats.ino);
const fail = (message) => { process.stderr.write(message + "\\n"); process.exit(125); };
const readBounded = (fd) => {
  const chunks = []; let total = 0; const buffer = Buffer.allocUnsafe(65536);
  while (total < byteCap + 1) {
    const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, byteCap + 1 - total), null);
    if (count === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, count))); total += count;
  }
  return { bytes: Buffer.concat(chunks), total };
};
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const writeAll = (fd, bytes) => { let offset = 0; while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset); };
const syncParentDirectory = () => {
  const directoryFlag = fs.constants.O_DIRECTORY || 0;
  if (directoryFlag === 0) return;
  const fd = fs.openSync(".", fs.constants.O_RDONLY | directoryFlag);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};
try {
  const rootStats = fs.statSync(".");
  if (!rootStats.isDirectory() || identity(rootStats) !== expectedRootIdentity) fail("Repository root changed before bounded mutation.");
  const fingerprintParts = ["root:" + identity(rootStats) + ":" + String(rootStats.mode & 0o7777)];
  const pathSegments = relativePath.split(/[\\\\/]/).filter(Boolean);
  const leafName = pathSegments.pop();
  if (!leafName) fail("A file path is required.");
  for (const parentName of pathSegments) {
    const captured = fs.lstatSync(parentName);
    if (!captured.isDirectory() || captured.isSymbolicLink()) fail("A parent directory changed or redirected.");
    const capturedIdentity = identity(captured);
    process.chdir(parentName);
    const entered = fs.statSync(".");
    if (!entered.isDirectory() || identity(entered) !== capturedIdentity) fail("A parent directory changed during bounded mutation.");
    fingerprintParts.push(parentName + ":" + identity(entered) + ":" + String(entered.mode & 0o7777));
  }
  if (fingerprintParts.join("/") !== expectedParentFingerprint) fail("A parent directory changed before bounded mutation.");
  let payloadText = "";
  process.stdin.on("data", (chunk) => {
    payloadText += chunk.toString("utf8");
    if (Buffer.byteLength(payloadText, "utf8") > byteCap * 2 + 65536) fail("Mutation payload exceeds the bounded safety cap.");
  });
  process.stdin.on("end", () => {
    try {
      const payload = JSON.parse(payloadText || "{}");
      const desiredBytes = payload.content === undefined ? undefined : Buffer.from(payload.content, "base64");
      if (desiredBytes !== undefined && desiredBytes.length > byteCap) fail("Mutation payload exceeds the bounded safety cap.");
      let leafStats;
      try { leafStats = fs.lstatSync(leafName); }
      catch (error) { if (error && error.code === "ENOENT") { leafStats = undefined; } else throw error; }
      let actualKind = "missing"; let actualMode; let actualBytes; let actualIdentity;
      if (leafStats !== undefined && leafStats.isSymbolicLink()) {
        actualKind = "symlink";
        actualIdentity = identity(leafStats);
        actualBytes = fs.readlinkSync(leafName, { encoding: "buffer" });
        if (actualBytes.length > byteCap) fail("Symlink target exceeds the bounded safety cap.");
      } else if (leafStats !== undefined && leafStats.isFile()) {
        actualKind = "file"; actualMode = leafStats.mode & 0o777;
        actualIdentity = identity(leafStats);
        const fd = fs.openSync(leafName, fs.constants.O_RDONLY | noFollowFlag | nonBlockFlag);
        try {
          const opened = fs.fstatSync(fd);
          if (!opened.isFile() || identity(opened) !== actualIdentity) fail("Working-tree file changed during bounded mutation.");
          const read = readBounded(fd); actualBytes = read.bytes;
          if (read.total > byteCap) fail("Working-tree file exceeds the bounded safety cap.");
        } finally { fs.closeSync(fd); }
      } else if (leafStats !== undefined) {
        fail("Cannot mutate special path safely; resolve it manually.");
      }
      if (expectedKind !== "" && actualKind !== expectedKind) fail("Working-tree kind changed before bounded mutation.");
      if (expectedMode !== undefined && actualMode !== expectedMode) fail("Working-tree mode changed before bounded mutation.");
      if (expectedByteLength !== undefined && (actualBytes === undefined || actualBytes.length !== expectedByteLength)) fail("Working-tree byte length changed before bounded mutation.");
      if (expectedDigest !== "" && (actualBytes === undefined || digest(actualBytes) !== expectedDigest)) fail("Working-tree bytes changed before bounded mutation.");
      if (expectedLeafFingerprint !== "" && actualIdentity !== expectedLeafFingerprint) fail("Working-tree leaf identity changed before bounded mutation.");
      const verifyFinalLeaf = () => {
        let finalStats;
        try { finalStats = fs.lstatSync(leafName); }
        catch (error) { if (error && error.code === "ENOENT") { finalStats = undefined; } else throw error; }
        let finalKind = "missing"; let finalMode; let finalBytes; let finalIdentity;
        if (finalStats !== undefined && finalStats.isSymbolicLink()) {
          finalKind = "symlink"; finalIdentity = identity(finalStats); finalBytes = fs.readlinkSync(leafName, { encoding: "buffer" });
        } else if (finalStats !== undefined && finalStats.isFile()) {
          finalKind = "file"; finalMode = finalStats.mode & 0o777; finalIdentity = identity(finalStats);
          const finalFd = fs.openSync(leafName, fs.constants.O_RDONLY | noFollowFlag | nonBlockFlag);
          try {
            const opened = fs.fstatSync(finalFd);
            if (!opened.isFile() || identity(opened) !== finalIdentity) fail("Working-tree file changed during final CAS.");
            const finalRead = readBounded(finalFd); finalBytes = finalRead.bytes;
            if (finalRead.total > byteCap) fail("Working-tree file exceeds the bounded safety cap.");
          } finally { fs.closeSync(finalFd); }
        } else if (finalStats !== undefined) fail("Cannot mutate special path safely; resolve it manually.");
        if (expectedKind !== "" && finalKind !== expectedKind) fail("Working-tree kind changed before final CAS.");
        if (expectedMode !== undefined && finalMode !== expectedMode) fail("Working-tree mode changed before final CAS.");
        if (expectedByteLength !== undefined && (finalBytes === undefined || finalBytes.length !== expectedByteLength)) fail("Working-tree byte length changed before final CAS.");
        if (expectedDigest !== "" && (finalBytes === undefined || digest(finalBytes) !== expectedDigest)) fail("Working-tree bytes changed before final CAS.");
        if (expectedLeafFingerprint !== "" && finalIdentity !== expectedLeafFingerprint) fail("Working-tree leaf identity changed before final CAS.");
      };
      if (operation === "remove") {
        verifyFinalLeaf();
        if (leafStats !== undefined) fs.unlinkSync(leafName);
        syncParentDirectory();
        process.stdout.write("ok"); process.exit(0);
      }
      if (desiredBytes === undefined) fail("Write bytes are unavailable.");
      const targetMode = payload.mode === "100755" ? 0o755 : 0o644;
      const temporaryLeafName = ".gito-conflict-tmp-" + process.pid + "-" + crypto.randomBytes(8).toString("hex");
      try {
        if (payload.mode === "120000") {
          fs.symlinkSync(desiredBytes, temporaryLeafName);
        } else {
          const fd = fs.openSync(temporaryLeafName, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag | nonBlockFlag, targetMode);
          try { writeAll(fd, desiredBytes); fs.fchmodSync(fd, targetMode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        }
        verifyFinalLeaf();
        fs.renameSync(temporaryLeafName, leafName);
        syncParentDirectory();
      } catch (error) {
        try { fs.unlinkSync(temporaryLeafName); } catch {}
        throw error;
      }
      process.stdout.write("ok"); process.exit(0);
    } catch (error) { fail(error && error.message ? error.message : String(error)); }
  });
} catch (error) { fail(error && error.message ? error.message : String(error)); }
`;

const BOUND_WORKING_TREE_READER_SOURCE = `
const fs = require("node:fs");
const expectedRootIdentity = process.argv[1];
const relativePath = process.argv[2];
const byteCap = Number(process.argv[3]);
const noFollowFlag = fs.constants.O_NOFOLLOW || 0;
const nonBlockFlag = fs.constants.O_NONBLOCK || 0;
const directoryMode = 0o040000;
const identity = (stats) => String(stats.dev) + ":" + String(stats.ino);
const fail = (message) => { process.stderr.write(message + "\\n"); process.exit(125); };
try {
  let rootStats = fs.statSync(".");
  if (!rootStats.isDirectory() || identity(rootStats) !== expectedRootIdentity) fail("Repository root changed before bounded read.");
  const fingerprintParts = ["root:" + identity(rootStats) + ":" + String(rootStats.mode & 0o7777)];
  const pathSegments = relativePath.split(/[\\\\/]/).filter(Boolean);
  const leafName = pathSegments.pop();
  if (!leafName) fail("A file path is required.");
  for (const parentName of pathSegments) {
    const captured = fs.lstatSync(parentName);
    if (!captured.isDirectory() || captured.isSymbolicLink()) fail("A parent directory changed or redirected.");
    const capturedIdentity = identity(captured);
    process.chdir(parentName);
    const entered = fs.statSync(".");
    if (!entered.isDirectory() || identity(entered) !== capturedIdentity) fail("A parent directory changed during bounded read.");
    fingerprintParts.push(parentName + ":" + identity(entered) + ":" + String(entered.mode & 0o7777));
  }
  const parentFingerprint = fingerprintParts.join("/");
  let leafStats;
  try { leafStats = fs.lstatSync(leafName); }
  catch (error) {
    if (error && error.code === "ENOENT") {
      process.stdout.write(JSON.stringify({ kind: "missing", parentFingerprint }));
      process.exit(0);
    }
    throw error;
  }
  if (leafStats.isSymbolicLink()) {
    const target = fs.readlinkSync(leafName, { encoding: "buffer" });
    const after = fs.lstatSync(leafName);
    if (identity(leafStats) !== identity(after) || target.length > byteCap) fail("Symlink changed or exceeds the bounded safety cap.");
      process.stdout.write(JSON.stringify({ kind: "symlink", content: target.toString("base64"), byteLength: target.length, digest: require("node:crypto").createHash("sha256").update(target).digest("hex"), leafFingerprint: identity(leafStats), parentFingerprint }));
  } else if (!leafStats.isFile()) {
    process.stdout.write(JSON.stringify({ kind: "unsupported", parentFingerprint }));
  } else {
    const fileDescriptor = fs.openSync(leafName, fs.constants.O_RDONLY | noFollowFlag | nonBlockFlag);
    try {
      const openedStats = fs.fstatSync(fileDescriptor);
      if (!openedStats.isFile() || identity(openedStats) !== identity(leafStats)) fail("File changed during bounded read.");
      const chunks = []; let total = 0; const buffer = Buffer.allocUnsafe(65536);
      while (total < byteCap + 1) {
        const bytesRead = fs.readSync(fileDescriptor, buffer, 0, Math.min(buffer.length, byteCap + 1 - total), null);
        if (bytesRead === 0) break;
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead))); total += bytesRead;
      }
      const bytes = Buffer.concat(chunks); const bounded = total <= byteCap;
      process.stdout.write(JSON.stringify({ kind: "file", content: bounded ? bytes.toString("base64") : undefined, byteLength: total, mode: openedStats.mode & 0o777, digest: bounded ? require("node:crypto").createHash("sha256").update(bytes).digest("hex") : undefined, leafFingerprint: identity(openedStats), parentFingerprint }));
    } finally { fs.closeSync(fileDescriptor); }
  }
} catch (error) { fail(error && error.message ? error.message : String(error)); }
`;

async function readWorkingTreeState(
  repositoryRoot: string,
  relativePath: string,
  cancellationSignal?: AbortSignal,
): Promise<{
  readonly content: Uint8Array | undefined;
  readonly kind: "file" | "symlink" | "missing" | "special";
  readonly mode: number | undefined;
  readonly byteLength: number | undefined;
  readonly digest: string | undefined;
  readonly leafFingerprint: string | undefined;
  readonly parentFingerprint: string | undefined;
}> {
  try {
    assertRepositoryRelativePath(relativePath);
    assertNotCancelled(cancellationSignal);
    if (process.platform === "linux") {
      return await readWorkingTreeStateWithDirectoryFd(
        repositoryRoot,
        relativePath,
        cancellationSignal,
      );
    }
    if (process.platform === "win32" || process.platform === "darwin") {
      return await readWorkingTreeStateWithBoundWorker(
        repositoryRoot,
        relativePath,
        cancellationSignal,
      );
    }
    // Node has no portable openat/readlinkat API. Unknown bytes are kept
    // out of every mutation plan when descriptor-bound traversal is absent.
    return {
      content: undefined,
      kind: "file",
      mode: undefined,
      byteLength: undefined,
      digest: undefined,
      leafFingerprint: undefined,
      parentFingerprint: undefined,
    };
  } catch (error: unknown) {
    if (isFileMissingError(error)) {
      return {
        content: undefined,
        kind: "missing",
        mode: undefined,
        byteLength: undefined,
        digest: undefined,
        leafFingerprint: undefined,
        parentFingerprint: undefined,
      };
    }
    throw error;
  }
}

function fingerprintSnapshot(
  gitDirectory: string,
  repositoryRootIdentity: string,
  gitDirectoryIdentity: string,
  repositoryRootBinding: GitRootBindingIdentity | undefined,
  headCommit: string,
  branchName: string,
  statusOutput: string,
  indexOutput: string,
  operation: ConflictOperationState | undefined,
  files: readonly ConflictFileState[],
): string {
  const hash = createHash("sha256");
  const updateField = (field: string | undefined): void => {
    const bytes = Buffer.from(field ?? "", "utf8");
    hash.update(String(bytes.byteLength));
    hash.update(":");
    hash.update(bytes);
    hash.update("\0");
  };
  updateField(gitDirectory);
  updateField(repositoryRootIdentity);
  updateField(gitDirectoryIdentity);
  updateField(repositoryRootBinding?.canonicalPath);
  updateField(repositoryRootBinding?.device);
  updateField(repositoryRootBinding?.inode);
  updateField(repositoryRootBinding?.gitDirectory.canonicalPath);
  updateField(repositoryRootBinding?.gitDirectory.device);
  updateField(repositoryRootBinding?.gitDirectory.inode);
  updateField(repositoryRootBinding?.commonDirectory.canonicalPath);
  updateField(repositoryRootBinding?.commonDirectory.device);
  updateField(repositoryRootBinding?.commonDirectory.inode);
  updateField(headCommit);
  updateField(branchName);
  updateField(statusOutput);
  updateField(indexOutput);
  updateField(operation?.kind);
  updateField(operation?.label);
  updateField(operation?.sourceDescription);
  updateField(operation?.sourceCommit);
  updateField(operation?.sourceRef);
  updateField(operation?.targetRef);
  updateField(operation?.targetCommit);
  updateField(operation?.metadataPath);
  updateField(operation?.metadataFingerprint);
  updateField(
    operation?.canAbort === undefined ? undefined : String(operation.canAbort),
  );
  for (const conflictFile of files) {
    updateField(conflictFile.path);
    updateField(conflictFile.originalPath);
    updateField(conflictFile.renamePair?.originalPath);
    updateField(conflictFile.renamePair?.destinationPath);
    updateField(conflictFile.statusCode);
    updateField(conflictFile.kind);
    for (const pathState of [
      {
        content: conflictFile.workingTreeContent,
        kind: conflictFile.workingTreeKind,
        mode: conflictFile.workingTreeMode,
        byteLength: conflictFile.workingTreeByteLength,
        digest: conflictFile.workingTreeDigest,
        leafFingerprint: conflictFile.workingTreeLeafFingerprint,
        parentFingerprint: conflictFile.workingTreeParentFingerprint,
      },
      {
        content: conflictFile.originalPathWorkingTreeContent,
        kind: conflictFile.originalPathWorkingTreeKind,
        mode: conflictFile.originalPathWorkingTreeMode,
        byteLength: conflictFile.originalPathWorkingTreeByteLength,
        digest: conflictFile.originalPathWorkingTreeDigest,
        leafFingerprint: conflictFile.originalPathWorkingTreeLeafFingerprint,
        parentFingerprint:
          conflictFile.originalPathWorkingTreeParentFingerprint,
      },
    ]) {
      updateField(pathState.kind);
      updateField(
        pathState.mode === undefined ? undefined : String(pathState.mode),
      );
      updateField(
        pathState.byteLength === undefined
          ? undefined
          : String(pathState.byteLength),
      );
      updateField(pathState.digest);
      updateField(pathState.leafFingerprint);
      updateField(pathState.parentFingerprint);
      if (pathState.content !== undefined) {
        updateField(Buffer.from(pathState.content).toString("base64"));
      } else {
        updateField(undefined);
      }
    }
    for (const side of ["base", "current", "incoming"] as const) {
      const stage = conflictFile.stages[side];
      updateField(side);
      updateField(stage?.objectId);
      updateField(stage?.mode);
      updateField(
        stage?.exists === undefined ? undefined : String(stage.exists),
      );
      updateField(stage?.kind);
      if (stage?.content !== undefined) {
        updateField(Buffer.from(stage.content).toString("base64"));
      } else {
        updateField(undefined);
      }
    }
  }
  return hash.digest("hex");
}

function quotePath(path: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(path) ? path : JSON.stringify(path);
}

/** Git pathspec magic prevents wildcard, glob, and attr expansion. */
function literalPathspec(path: string): string {
  assertRepositoryRelativePath(path);
  // Plain repository paths have no pathspec metacharacters. Preserve them so
  // Git diagnostics stay readable; magic is mandatory for ambiguous paths.
  return /^(?!:)[A-Za-z0-9_./-]+$/.test(path) ? path : `:(literal)${path}`;
}

function isFileMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
