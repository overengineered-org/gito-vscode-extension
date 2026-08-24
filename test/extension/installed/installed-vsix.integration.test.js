const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const vscode = require("vscode");
const {
  gitOriginalRelativePath,
  isNativeSnapshotUri,
} = require("./diff-proof-helpers.cjs");
const {
  extractUriFilePath,
  normalizePath,
  normalizeRelativePath,
  pathsRepresentSameLocation,
  relativePathWithinRepository,
} = require("./path-alias-helpers.cjs");

const executeFile = promisify(execFile);
const gitUntrackedStatus = 7;

const installedExtensionPath = process.env.GITO_INSTALLED_EXTENSION_PATH;
const installedExtensionVersion = process.env.GITO_INSTALLED_EXTENSION_VERSION;
const installedVsixPath = process.env.GITO_INSTALLED_VSIX_PATH;
const installedVsixSha256 = process.env.GITO_INSTALLED_VSIX_SHA256;
const repositoryPath = process.env.GITO_INSTALLED_REPOSITORY_PATH;
const installedVscodeVersion = process.env.GITO_INSTALLED_VSCODE_VERSION;
const installedCommitSha = process.env.GITO_INSTALLED_COMMIT_SHA;
const installedSourceTreeSha256 = process.env.GITO_INSTALLED_SOURCE_TREE_SHA256;
const installedReleaseMetadataSha256 =
  process.env.GITO_INSTALLED_RELEASE_METADATA_SHA256;
const installedReleaseMetadataVersion =
  process.env.GITO_INSTALLED_RELEASE_METADATA_VERSION;
const quickPickCancellationPollMilliseconds = 100;
const quickPickCancellationAttemptLimit = 150;
const installedProofStepTimeoutMilliseconds = 30_000;
const installedNativeDiffProbeTimeoutMilliseconds = 10_000;

module.exports = async function runInstalledVsixIntegration() {
  assert.ok(
    installedExtensionPath,
    "Installed VSIX runner must provide GITO_INSTALLED_EXTENSION_PATH",
  );
  assert.ok(
    installedVsixPath,
    "Installed VSIX runner must provide GITO_INSTALLED_VSIX_PATH",
  );
  assert.ok(
    installedVsixSha256,
    "Installed VSIX runner must provide GITO_INSTALLED_VSIX_SHA256",
  );
  assert.ok(
    installedExtensionVersion,
    "Installed VSIX runner must provide GITO_INSTALLED_EXTENSION_VERSION",
  );
  assert.ok(
    repositoryPath,
    "Installed VSIX runner must provide GITO_INSTALLED_REPOSITORY_PATH",
  );
  assert.ok(
    installedVscodeVersion,
    "Installed VSIX runner must provide GITO_INSTALLED_VSCODE_VERSION",
  );
  assert.match(
    installedCommitSha ?? "",
    /^[0-9a-f]{40}$/u,
    "Installed VSIX runner provides the current commit attestation",
  );
  assert.match(
    installedSourceTreeSha256 ?? "",
    /^[0-9a-f]{64}$/u,
    "Installed VSIX runner provides the current source-tree attestation",
  );
  assert.equal(
    installedReleaseMetadataSha256,
    installedVsixSha256,
    "Installed VSIX release metadata binds the archive hash",
  );
  assert.equal(
    installedReleaseMetadataVersion,
    installedExtensionVersion,
    "Installed VSIX release metadata binds the extension version",
  );
  assert.equal(
    vscode.version,
    installedVscodeVersion,
    "Extension Host ran under the runner-selected VS Code version",
  );

  assert.equal(
    await sha256File(installedVsixPath),
    installedVsixSha256,
    "Extension Host is bound to the exact VSIX archive hash",
  );

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, "Extension Host opened the disposable repository");
  assert.equal(
    normalizePath(workspaceFolder.uri.fsPath),
    normalizePath(repositoryPath),
    "Extension Host opened the runner-created repository",
  );
  assert.equal(
    vscode.workspace.isTrusted,
    true,
    "Installed VSIX runs in a trusted disposable workspace",
  );

  const gitoExtension = vscode.extensions.getExtension(
    "overengineered-org.gito",
  );
  assert.ok(gitoExtension, "Installed Git'o extension is available");
  assert.equal(
    normalizePath(gitoExtension.extensionPath),
    normalizePath(installedExtensionPath),
    `Extension Host loaded the installed VSIX (${installedVsixPath})`,
  );
  assert.equal(
    gitoExtension.packageJSON.publisher,
    "overengineered-org",
    "Extension Host loaded the expected VSIX publisher",
  );
  assert.equal(
    gitoExtension.packageJSON.name,
    "gito",
    "Extension Host loaded the expected VSIX name",
  );
  assert.equal(
    gitoExtension.packageJSON.version,
    installedExtensionVersion,
    `Extension Host loaded the installed VSIX version (${installedExtensionVersion})`,
  );
  await gitoExtension.activate();
  assert.equal(
    vscode.workspace.getConfiguration().get("gito.developerDiagnostics"),
    true,
    "Installed VSIX developer diagnostics are enabled only in the isolated host",
  );

  const bundledGitExtension = vscode.extensions.getExtension("vscode.git");
  assert.ok(
    bundledGitExtension,
    "VS Code's bundled Git extension is available",
  );
  const bundledGitExports = bundledGitExtension.isActive
    ? bundledGitExtension.exports
    : await bundledGitExtension.activate();
  assert.ok(
    bundledGitExports && typeof bundledGitExports.getAPI === "function",
    "VS Code's bundled Git extension exposes its public API",
  );
  assert.equal(
    bundledGitExports.enabled,
    true,
    "VS Code's bundled Git extension is enabled",
  );
  const gitApi = bundledGitExports.getAPI(1);
  await waitForCondition(
    "bundled Git API initialization",
    () => gitApi.state === "initialized",
  );

  const repository = await waitForRepository(gitApi, repositoryPath);
  assert.equal(
    typeof repository.status,
    "function",
    "Bundled vscode.git exposes repository.status for explicit status refresh",
  );
  const registeredCommands = await vscode.commands.getCommands();
  for (const commandIdentifier of [
    "gito.openHome",
    "gito.stageAll",
    "gito.unstageAll",
    "gito.commit",
    "gito.createBranch",
    "gito.checkoutBranch",
  ]) {
    assert.ok(
      registeredCommands.includes(commandIdentifier),
      `Git'o command is registered: ${commandIdentifier}`,
    );
  }

  const changeUri = vscode.Uri.file(
    path.join(repositoryPath, "change.gito-proof"),
  );
  await vscode.workspace.fs.writeFile(
    changeUri,
    Buffer.from("installed VSIX integration\n", "utf8"),
  );
  await refreshRepositoryStatus(repository);
  await waitForCondition("untracked fixture change", () => {
    const snapshot = repositorySnapshot(repository);
    return (
      snapshot.untrackedPaths.includes("change.gito-proof") &&
      snapshot.stagedPaths.length === 0 &&
      snapshot.workingTreePaths.length === 0
    );
  });
  const untrackedSnapshot = repositorySnapshot(repository);
  assert.deepEqual(untrackedSnapshot.stagedPaths, []);
  assert.deepEqual(untrackedSnapshot.workingTreePaths, []);

  await vscode.commands.executeCommand("gito.stageAll");
  await waitForCondition("Git'o stage-all snapshot", () => {
    const snapshot = repositorySnapshot(repository);
    return (
      snapshot.stagedPaths.includes("change.gito-proof") &&
      snapshot.untrackedPaths.length === 0 &&
      snapshot.workingTreePaths.length === 0
    );
  });
  const stagedSnapshot = repositorySnapshot(repository);
  assert.deepEqual(stagedSnapshot.untrackedPaths, []);
  assert.deepEqual(stagedSnapshot.workingTreePaths, []);

  const initialHeadCommit = repository.state.HEAD?.commit;
  await vscode.commands.executeCommand(
    "gito.commit",
    "test: installed VSIX command flow",
  );
  await waitForCondition("Git'o commit snapshot", () => {
    const snapshot = repositorySnapshot(repository);
    return (
      snapshot.stagedPaths.length === 0 &&
      snapshot.untrackedPaths.length === 0 &&
      snapshot.headCommit !== undefined &&
      snapshot.headCommit !== initialHeadCommit
    );
  });
  const committedSnapshot = repositorySnapshot(repository);
  assert.equal(committedSnapshot.headName, "main");
  assert.ok(committedSnapshot.headCommit);
  const committedChange = await repository.getCommit(
    committedSnapshot.headCommit,
  );
  assert.equal(committedChange.message, "test: installed VSIX command flow");

  const integrationBranchName = "fixture/installed-vsix";
  await vscode.commands.executeCommand(
    "gito.createBranch",
    integrationBranchName,
  );
  await waitForCondition("Git'o branch creation", async () => {
    const snapshot = repositorySnapshot(repository);
    return (
      snapshot.headName === integrationBranchName &&
      (await getLocalBranchNames(repository)).includes(integrationBranchName)
    );
  });
  assert.ok(
    (await getLocalBranchNames(repository)).includes(integrationBranchName),
    "Git'o created the branch through bundled vscode.git",
  );

  await vscode.commands.executeCommand("gito.checkoutBranch", "main");
  await waitForCondition(
    "Git'o branch checkout",
    () => repositorySnapshot(repository).headName === "main",
  );

  const readBackChange = await vscode.workspace.fs.readFile(changeUri);
  assert.equal(
    Buffer.from(readBackChange).toString("utf8"),
    "installed VSIX integration\n",
    "Git'o command flow preserved the repository file",
  );

  await verifyInstalledPremiumReadFlows(
    repository,
    repositoryPath,
    changeUri,
    committedSnapshot.headCommit,
    committedChange.message,
  );
};

async function verifyInstalledPremiumReadFlows(
  repository,
  repositoryRootPath,
  changeUri,
  knownCommitSha,
  knownCommitSubject,
) {
  assert.ok(knownCommitSha, "Installed history fixture has a known commit SHA");
  assert.equal(
    knownCommitSubject,
    "test: installed VSIX command flow",
    "Installed history fixture has the known commit subject",
  );
  const repositoryRootUri = vscode.Uri.file(repositoryRootPath);
  const changeDocument = vscode.workspace.textDocuments.find(
    (document) => document.uri.toString() === changeUri.toString(),
  );
  assert.ok(
    changeDocument,
    "Installed host opened the history fixture before test-driver activation",
  );
  assert.equal(
    changeDocument.languageId,
    "gito-installed-proof",
    "Installed hover proof excludes unrelated language-specific providers",
  );

  // Exercise the shipped history providers through VS Code's public commands.
  assert.equal(
    vscode.workspace.getConfiguration().get("gito.history.enabled"),
    true,
    "Installed VSIX history is enabled",
  );
  assert.equal(
    vscode.workspace.getConfiguration().get("gito.history.blame.enabled"),
    true,
    "Installed VSIX history blame is enabled",
  );
  assert.equal(
    vscode.workspace.getConfiguration().get("gito.history.codeLens.enabled"),
    true,
    "Installed VSIX history CodeLens is enabled",
  );
  const codeLenses = await waitForValue(
    "installed history CodeLens",
    async () =>
      withInstalledProofStepTimeout(
        "installed history CodeLens provider",
        vscode.commands.executeCommand(
          "vscode.executeCodeLensProvider",
          changeUri,
        ),
      ),
    (value) => Array.isArray(value) && value.length > 0,
  );
  assert.ok(codeLenses.length > 0, "Installed VSIX exposes history CodeLens");
  assert.ok(
    codeLenses.some(
      (codeLens) =>
        codeLens.command?.command === "gito.history.openCommit" &&
        codeLens.command.arguments?.[0]?.commit?.sha === knownCommitSha &&
        codeLens.command.arguments?.[0]?.commit?.subject === knownCommitSubject,
    ),
    "Installed VSIX history CodeLens identifies the known Git'o commit",
  );
  const hovers = await withInstalledProofStepTimeout(
    "installed history hover provider",
    vscode.commands.executeCommand(
      "vscode.executeHoverProvider",
      changeUri,
      new vscode.Position(0, 0),
    ),
  );
  assert.ok(
    Array.isArray(hovers),
    "Installed VSIX exposes history hover results",
  );
  const hoverText = hovers
    .flatMap((hover) =>
      Array.isArray(hover.contents) ? hover.contents : [hover.contents],
    )
    .map((content) => {
      if (typeof content === "string") return content;
      if (content !== undefined && typeof content.value === "string")
        return content.value;
      return "";
    })
    .join("\n");
  assert.ok(
    hoverText.trim().length > 0,
    "Installed VSIX exposes non-empty Git'o history hover",
  );
  assert.ok(
    hoverText.includes(knownCommitSubject),
    "Installed VSIX history hover identifies the known commit subject",
  );
  assert.ok(
    hoverText.includes(knownCommitSha),
    "Installed VSIX history hover identifies the known commit SHA",
  );
  assert.match(
    hoverText,
    /command:gito\.history\.openCommit\?/u,
    "Installed VSIX history hover opens Git'o commit details",
  );

  // Prove the host's native diff and bundled Git revision provider before
  // attributing any later failure to Git'o's immutable snapshot resource.
  await verifyRawVscodePlainFileDiffProbe(repositoryRootPath);
  await verifyRawVscodeGitFileDiffProbe(repositoryRootPath, knownCommitSha);

  // Open a real working-tree diff with explicit, repository-bound sources.
  const diffUri = vscode.Uri.file(path.join(repositoryRootPath, "diff.txt"));
  await vscode.workspace.fs.writeFile(
    diffUri,
    Buffer.from("installed VSIX diff changed\n"),
  );
  await refreshRepositoryStatus(repository);
  await waitForCondition("installed diff change", () =>
    repositorySnapshot(repository).workingTreePaths.includes("diff.txt"),
  );
  const diffCommandOutcome = dispatchInstalledUiCommand(
    vscode.commands.executeCommand("gito.diff.openRepository", {
      repositoryRoot: repositoryRootUri,
      from: {
        kind: "revision",
        repositoryRoot: repositoryRootUri,
        revision: "HEAD",
      },
      to: { kind: "working-tree", repositoryRoot: repositoryRootUri },
    }),
  );
  let exactDiffProof;
  try {
    await waitForCondition(
      "installed native diff source and content",
      async () => {
        if (diffCommandOutcome.failure !== undefined)
          throw diffCommandOutcome.failure;
        exactDiffProof = await findExactDiffProof(
          allTabs(),
          repositoryRootPath,
          "diff.txt",
          "installed VSIX diff baseline\n",
          "installed VSIX diff changed\n",
        );
        return exactDiffProof !== undefined;
      },
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} Visible tab inputs: ${describeTabInputs(allTabs())}. Open document schemes: ${describeOpenDocumentSchemes()}.`,
      { cause: error },
    );
  }
  assert.ok(
    exactDiffProof,
    "Installed VSIX diff has exact sources and content",
  );
  assert.equal(
    exactDiffProof.originalRelativePath,
    "diff.txt",
    "Installed VSIX diff original URI is bound to the exact repository file",
  );
  assert.equal(
    exactDiffProof.originalScheme,
    "git",
    "Installed VSIX diff reads the immutable git resource",
  );
  assert.equal(
    exactDiffProof.modifiedScheme,
    "file",
    "Installed VSIX diff reads a native immutable snapshot resource",
  );
  await awaitInstalledUiCommandSettlement(
    "installed Git'o repository diff",
    diffCommandOutcome,
  );
  await verifyRawVscodeDiffUriMatrix(repositoryRootPath, exactDiffProof);
  await verifyRawVscodeGitFileDiffProbe(repositoryRootPath, knownCommitSha);
  await verifyRawVscodePlainFileDiffProbe(repositoryRootPath);

  // Graph command must complete a real webview protocol exchange from the
  // installed extension, including the known repository commit.
  const graphWebviewProbe = createGraphWebviewProbe();
  try {
    const graphCommandOutcome = dispatchInstalledUiCommand(
      vscode.commands.executeCommand("gito.graph.open"),
    );
    const graphTab = await waitForValue(
      "installed commit graph webview panel",
      () =>
        graphCommandOutcome.failure === undefined
          ? allTabs().find(
              (tab) =>
                tab.input?.viewType === "gito.commitGraph" &&
                tab.label === "Commit Graph",
            )
          : (() => {
              throw graphCommandOutcome.failure;
            })(),
      (value) => value !== undefined,
    );
    assert.equal(graphTab.input?.viewType, "gito.commitGraph");
    assert.equal(graphTab.label, "Commit Graph");
    await assertInstalledGraphRuntimeProof(
      graphWebviewProbe,
      knownCommitSha,
      knownCommitSubject,
    );
  } finally {
    graphWebviewProbe.dispose();
  }

  // Operations center is read-only here: a real stash proves state discovery,
  // and the command must not alter the stash while its picker is dismissed.
  const operationFilePath = path.join(repositoryRootPath, "operation.txt");
  await vscode.workspace.fs.writeFile(
    vscode.Uri.file(operationFilePath),
    Buffer.from("operation\n"),
  );
  let stashCreated = false;
  try {
    await runGit(repositoryRootPath, ["add", "operation.txt"]);
    await runGit(repositoryRootPath, [
      "stash",
      "push",
      "-m",
      "installed operations read flow",
    ]);
    stashCreated = true;
    const stashBeforeOperations = await readGit(repositoryRootPath, [
      "stash",
      "list",
    ]);
    await cancelInteractiveReadCommand("gito.openOperations", {
      cancellationPickerIndex: 0,
      assertPicker: (pickerItems, pickerOptions) => {
        assert.equal(pickerOptions.title, "Git'o Operations Center");
        assert.ok(
          pickerItems.some((pickerItem) => pickerItem.action === "stash"),
          "Installed operations picker exposes stash read flow",
        );
      },
    });
    const operationsReadAcknowledgement = await runOperationsReadFlow();
    assert.match(
      operationsReadAcknowledgement,
      /installed operations read flow/u,
      "Installed operations read flow acknowledges the known stash",
    );
    const stashAfterOperations = await readGit(repositoryRootPath, [
      "stash",
      "list",
    ]);
    assert.equal(stashAfterOperations, stashBeforeOperations);
  } finally {
    if (stashCreated)
      await runGit(repositoryRootPath, ["stash", "pop"], {
        allowFailure: true,
      });
  }

  // Build a real merge conflict and verify the conflict story is inspect-only.
  try {
    await createConflictFixture(repositoryRootPath);
    const unmergedBeforeConflictView = await readGit(repositoryRootPath, [
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);
    assert.match(unmergedBeforeConflictView, /conflict\.txt/);
    await cancelInteractiveReadCommand("gito.openConflicts", {
      cancellationPickerIndex: 2,
      selectPicker: (pickerItems, pickerIndex) => {
        if (pickerIndex === 0)
          return pickerItems.find(
            (pickerItem) => pickerItem.action === "resolve",
          );
        if (pickerIndex === 1) {
          const conflictFileItem = pickerItems.find(
            (pickerItem) => pickerItem.conflictFile?.path === "conflict.txt",
          );
          assert.ok(
            conflictFileItem,
            "Installed conflicts picker exposes the known conflict file",
          );
          return [conflictFileItem];
        }
        return undefined;
      },
      assertPicker: (pickerItems, pickerOptions, pickerIndex) => {
        if (pickerIndex === 0) {
          assert.equal(pickerOptions.title, "Conflict Story");
          assert.ok(
            pickerItems.some((pickerItem) => pickerItem.action === "resolve"),
            "Installed conflict story acknowledges the read/resolve path",
          );
        }
        if (pickerIndex === 2) {
          assert.equal(pickerOptions.title, "Resolve 1 selected conflict.txt");
          assert.ok(
            pickerItems.some(
              (pickerItem) => pickerItem.label === "Preview Current ↔ Incoming",
            ),
            "Installed conflict actions expose an inspect-only preview",
          );
        }
      },
    });
    const unmergedAfterConflictView = await readGit(repositoryRootPath, [
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);
    assert.equal(unmergedAfterConflictView, unmergedBeforeConflictView);
  } finally {
    await runGit(repositoryRootPath, ["merge", "--abort"], {
      allowFailure: true,
    });
  }
}

function dispatchInstalledUiCommand(commandExecution) {
  const commandOutcome = { settled: false, failure: undefined };
  commandOutcome.completion = Promise.resolve(commandExecution).then(
    () => {
      commandOutcome.settled = true;
    },
    (error) => {
      commandOutcome.failure = error;
      commandOutcome.settled = true;
    },
  );
  return commandOutcome;
}

async function awaitInstalledUiCommandSettlement(description, commandOutcome) {
  await withInstalledProofStepTimeout(
    `${description} command settlement`,
    commandOutcome.completion,
  );
  if (commandOutcome.failure !== undefined) throw commandOutcome.failure;
  assert.equal(
    commandOutcome.settled,
    true,
    `${description} command settled before proof completed`,
  );
}

async function withInstalledProofStepTimeout(description, operation) {
  let timeout;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${description}.`)),
          installedProofStepTimeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function allTabs() {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs);
}

function describeTabInputs(tabs) {
  return tabs
    .map((tab) => {
      const input = tab.input;
      if (input === undefined || typeof input !== "object") return "unknown";
      if ("original" in input || "modified" in input)
        return `diff(${input.original?.scheme ?? "missing"}->${input.modified?.scheme ?? "missing"})`;
      if (isUri(input.uri)) return `text(${input.uri.scheme})`;
      const fieldNames = Object.keys(input).sort().join("|");
      const inputType = input.constructor?.name ?? "unknown";
      return `object(${inputType}:${fieldNames || "no-fields"})`;
    })
    .join(", ");
}

function describeOpenDocumentSchemes() {
  return [
    ...new Set(vscode.workspace.textDocuments.map(({ uri }) => uri.scheme)),
  ]
    .sort()
    .join(", ");
}

function isDiffTab(tab) {
  const input = tab.input;
  return (
    input !== undefined &&
    typeof input === "object" &&
    ("original" in input || "textDiffs" in input)
  );
}

async function findExactDiffProof(
  tabs,
  repositoryRootPath,
  relativeFilePath,
  expectedOriginalText,
  expectedModifiedText,
) {
  for (const tab of tabs) {
    if (!isDiffTab(tab)) continue;
    const diffInput = tab.input;
    const diffSides =
      diffInput.original !== undefined && diffInput.modified !== undefined
        ? diffInput
        : diffInput.textDiffs?.[0];
    if (
      diffSides === undefined ||
      !isUri(diffSides.original) ||
      !isUri(diffSides.modified) ||
      gitOriginalRelativePath(diffSides.original, repositoryRootPath) !==
        normalizeRelativePath(relativeFilePath) ||
      !isNativeSnapshotUri(diffSides.modified)
    )
      continue;
    const [originalText, modifiedText] = await Promise.all([
      readResourceText(diffSides.original),
      readResourceText(diffSides.modified),
    ]);
    if (
      originalText === expectedOriginalText &&
      modifiedText === expectedModifiedText
    )
      return {
        original: diffSides.original,
        modified: diffSides.modified,
        originalRelativePath: gitOriginalRelativePath(
          diffSides.original,
          repositoryRootPath,
        ),
        originalScheme: diffSides.original.scheme,
        modifiedScheme: diffSides.modified.scheme,
      };
  }
  return undefined;
}

async function verifyRawVscodeDiffUriMatrix(
  repositoryRootPath,
  exactDiffProof,
) {
  const probeCases = [
    {
      label: "product-git->file",
      original: exactDiffProof.original,
      modified: exactDiffProof.modified,
      expectedOriginalText: "installed VSIX diff baseline\n",
      expectedModifiedText: "installed VSIX diff changed\n",
    },
  ];
  const probeResults = [];
  for (const probeCase of probeCases) {
    probeResults.push(
      await probeRawVscodeDiffCase(repositoryRootPath, probeCase),
    );
  }
  assert.ok(
    probeResults.every((probeResult) => probeResult.passed),
    `Raw vscode.diff URI probe failed: ${JSON.stringify(probeResults)}`,
  );
}

async function verifyRawVscodeGitFileDiffProbe(
  repositoryRootPath,
  knownCommitSha,
) {
  const gitFilePath = path.join(repositoryRootPath, "diff.txt");
  const gitOriginalUri = vscode.Uri.file(gitFilePath).with({
    scheme: "git",
    query: JSON.stringify({ path: gitFilePath, ref: knownCommitSha }),
  });
  const probeResult = await probeRawVscodeDiffCase(repositoryRootPath, {
    label: "git->file",
    original: gitOriginalUri,
    modified: vscode.Uri.file(gitFilePath),
    expectedOriginalText: "installed VSIX diff baseline\n",
    expectedModifiedText: "installed VSIX diff baseline\n",
  });
  assert.ok(
    probeResult.passed,
    `Raw vscode.diff Git/file probe failed: ${JSON.stringify(probeResult)}`,
  );
}

async function verifyRawVscodePlainFileDiffProbe(repositoryRootPath) {
  const probeDirectoryPath = path.dirname(repositoryRootPath);
  const plainOriginalPath = path.join(
    probeDirectoryPath,
    "installed-native-diff-plain-original.txt",
  );
  const plainModifiedPath = path.join(
    probeDirectoryPath,
    "installed-native-diff-plain-modified.txt",
  );
  const plainOriginalUri = vscode.Uri.file(plainOriginalPath);
  const plainModifiedUri = vscode.Uri.file(plainModifiedPath);
  await vscode.workspace.fs.writeFile(
    plainOriginalUri,
    Buffer.from("installed native probe baseline\n"),
  );
  await vscode.workspace.fs.writeFile(
    plainModifiedUri,
    Buffer.from("installed native probe changed\n"),
  );
  const probeResult = await probeRawVscodeDiffCase(repositoryRootPath, {
    label: "file->file",
    original: plainOriginalUri,
    modified: plainModifiedUri,
    expectedOriginalText: "installed native probe baseline\n",
    expectedModifiedText: "installed native probe changed\n",
  });
  assert.ok(
    probeResult.passed,
    `Raw vscode.diff plain file probe failed: ${JSON.stringify(probeResult)}`,
  );
}

async function probeRawVscodeDiffCase(repositoryRootPath, probeCase) {
  let ownedDiffTab;
  let probeResult;
  try {
    const preexistingDiffTab = findDiffTabForUris(
      allTabs(),
      probeCase.original,
      probeCase.modified,
    );
    if (preexistingDiffTab !== undefined)
      await vscode.window.tabGroups.close(preexistingDiffTab.tab, true);

    const commandOutcome = dispatchInstalledUiCommand(
      vscode.commands.executeCommand(
        "vscode.diff",
        probeCase.original,
        probeCase.modified,
        `Git'o raw native diff probe · ${probeCase.label}`,
        { preview: false, preserveFocus: false },
      ),
    );
    let diffTab;
    await waitForCondition(
      `raw vscode.diff ${probeCase.label}`,
      async () => {
        if (commandOutcome.failure !== undefined) throw commandOutcome.failure;
        diffTab = findDiffTabForUris(
          allTabs(),
          probeCase.original,
          probeCase.modified,
        );
        if (diffTab !== undefined) ownedDiffTab = diffTab.tab;
        return diffTab !== undefined;
      },
      installedNativeDiffProbeTimeoutMilliseconds,
    );
    if (commandOutcome.failure !== undefined) throw commandOutcome.failure;

    const observedOriginalUri = diffTab.original.toString();
    const observedModifiedUri = diffTab.modified.toString();
    const expectedOriginalUri = probeCase.original.toString();
    const expectedModifiedUri = probeCase.modified.toString();
    const originalText = await readResourceText(diffTab.original);
    const modifiedText = await readResourceText(diffTab.modified);
    probeResult = {
      label: probeCase.label,
      passed:
        observedOriginalUri === expectedOriginalUri &&
        observedModifiedUri === expectedModifiedUri &&
        diffTab.original.scheme === probeCase.original.scheme &&
        diffTab.modified.scheme === probeCase.modified.scheme &&
        originalText === probeCase.expectedOriginalText &&
        modifiedText === probeCase.expectedModifiedText,
      originalScheme: diffTab.original.scheme,
      modifiedScheme: diffTab.modified.scheme,
      originalRelativePath: gitOriginalRelativePath(
        diffTab.original,
        repositoryRootPath,
      ),
      observedOriginalUri,
      observedModifiedUri,
      originalText,
      modifiedText,
    };
  } catch (error) {
    probeResult = {
      label: probeCase.label,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      observedTabs: describeTabInputs(allTabs()),
    };
  } finally {
    if (ownedDiffTab === undefined) {
      const lateObservedDiffTab = findDiffTabForUris(
        allTabs(),
        probeCase.original,
        probeCase.modified,
      );
      if (lateObservedDiffTab !== undefined)
        ownedDiffTab = lateObservedDiffTab.tab;
    }
    if (ownedDiffTab !== undefined) {
      try {
        const closeOutcome = dispatchInstalledUiCommand(
          vscode.window.tabGroups.close(ownedDiffTab, true),
        );
        await waitForCondition(
          `raw vscode.diff ${probeCase.label} tab cleanup`,
          () => {
            if (closeOutcome.failure !== undefined) throw closeOutcome.failure;
            return (
              findDiffTabForUris(
                allTabs(),
                probeCase.original,
                probeCase.modified,
              ) === undefined
            );
          },
          installedNativeDiffProbeTimeoutMilliseconds,
        );
      } catch (error) {
        probeResult = {
          ...(probeResult ?? {
            label: probeCase.label,
            passed: false,
          }),
          passed: false,
          cleanupError: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }
  return probeResult;
}

function findDiffTabForUris(tabs, expectedOriginalUri, expectedModifiedUri) {
  const expectedOriginal = expectedOriginalUri.toString();
  const expectedModified = expectedModifiedUri.toString();
  return tabs
    .filter(isDiffTab)
    .map((tab) => {
      const input = tab.input;
      if (input.original !== undefined && input.modified !== undefined)
        return { tab, original: input.original, modified: input.modified };
      const textDiff = input.textDiffs?.[0];
      if (textDiff?.original !== undefined && textDiff.modified !== undefined)
        return {
          tab,
          original: textDiff.original,
          modified: textDiff.modified,
        };
      return undefined;
    })
    .find(
      (diffTab) =>
        diffTab !== undefined &&
        isUri(diffTab.original) &&
        isUri(diffTab.modified) &&
        diffTab.original.toString() === expectedOriginal &&
        diffTab.modified.toString() === expectedModified,
    );
}

async function readResourceText(resourceUri) {
  try {
    const bytes = await vscode.workspace.fs.readFile(resourceUri);
    return Buffer.from(bytes).toString("utf8");
  } catch {
    const document = await vscode.workspace.openTextDocument(resourceUri);
    return document.getText();
  }
}

function isUri(candidate) {
  return (
    candidate !== undefined &&
    typeof candidate === "object" &&
    typeof candidate.toString === "function" &&
    extractUriFilePath(candidate) !== undefined
  );
}

function createGraphWebviewProbe() {
  const originalCreateWebviewPanel = vscode.window.createWebviewPanel;
  const incomingMessages = [];
  const outgoingMessages = [];
  let graphWebview;
  let originalPostMessage;
  let messageSubscription;
  let disposed = false;

  vscode.window.createWebviewPanel = function createProbedWebviewPanel(
    ...argumentsList
  ) {
    const graphPanel = originalCreateWebviewPanel.apply(this, argumentsList);
    graphWebview = graphPanel.webview;
    originalPostMessage = graphWebview.postMessage;
    graphWebview.postMessage = (message) => {
      outgoingMessages.push(message);
      return originalPostMessage.call(graphWebview, message);
    };
    messageSubscription = graphWebview.onDidReceiveMessage((message) => {
      incomingMessages.push(message);
    });
    return graphPanel;
  };

  return {
    incomingMessages,
    outgoingMessages,
    dispose() {
      if (disposed) return;
      disposed = true;
      messageSubscription?.dispose();
      if (graphWebview !== undefined && originalPostMessage !== undefined)
        graphWebview.postMessage = originalPostMessage;
      vscode.window.createWebviewPanel = originalCreateWebviewPanel;
    },
  };
}

async function assertInstalledGraphRuntimeProof(
  graphWebviewProbe,
  knownCommitSha,
  knownCommitSubject,
) {
  await waitForCondition("installed graph protocol exchange", () => {
    const graphReadyMessage = graphWebviewProbe.outgoingMessages.find(
      (message) => message?.messageType === "graphReady",
    );
    const graphQueryMessage = graphWebviewProbe.incomingMessages.find(
      (message) => message?.messageType === "graphQuery",
    );
    const graphPageLoadedMessage = graphWebviewProbe.outgoingMessages.find(
      (message) => message?.messageType === "graphPageLoaded",
    );
    return (
      graphReadyMessage !== undefined &&
      graphQueryMessage !== undefined &&
      graphPageLoadedMessage !== undefined
    );
  });
  const graphReadyMessage = graphWebviewProbe.outgoingMessages.find(
    (message) => message?.messageType === "graphReady",
  );
  const graphQueryMessage = graphWebviewProbe.incomingMessages.find(
    (message) => message?.messageType === "graphQuery",
  );
  const graphPageLoadedMessage = graphWebviewProbe.outgoingMessages.find(
    (message) => message?.messageType === "graphPageLoaded",
  );
  assert.ok(graphReadyMessage.summary.totalCommits >= 2);
  assert.equal(graphQueryMessage.append, false);
  assert.ok(graphPageLoadedMessage.page.totalCommits >= 2);
  assert.ok(
    graphPageLoadedMessage.page.rows.some(
      (row) =>
        row.kind === "commit" &&
        row.commitSha === knownCommitSha &&
        row.subject === knownCommitSubject,
    ),
    "Installed graph runtime returned the known commit SHA and subject",
  );
}

async function runOperationsReadFlow() {
  const observedPickers = [];
  const observedInformationMessages = [];
  const originalShowQuickPick = vscode.window.showQuickPick;
  const originalShowInformationMessage = vscode.window.showInformationMessage;
  vscode.window.showQuickPick = (pickerItems, pickerOptions) => {
    const pickerIndex = observedPickers.length;
    observedPickers.push({ pickerItems, pickerOptions });
    const selectedItem =
      pickerIndex === 0
        ? pickerItems.find((pickerItem) => pickerItem.action === "stash")
        : pickerItems.find((pickerItem) => pickerItem.id === "list");
    assert.ok(
      selectedItem,
      `Installed operations picker ${pickerIndex} has a read choice`,
    );
    return Promise.resolve(selectedItem);
  };
  vscode.window.showInformationMessage = (message) => {
    observedInformationMessages.push(message);
    return Promise.resolve(undefined);
  };
  try {
    await vscode.commands.executeCommand("gito.openOperations");
  } finally {
    vscode.window.showQuickPick = originalShowQuickPick;
    vscode.window.showInformationMessage = originalShowInformationMessage;
  }
  assert.equal(
    observedPickers.length,
    2,
    "Installed operations read flow used both pickers",
  );
  const acknowledgement = observedInformationMessages.find((message) =>
    message.includes("Readback:"),
  );
  assert.ok(
    acknowledgement,
    "Installed operations read flow returned a read acknowledgement",
  );
  return acknowledgement;
}

async function createConflictFixture(repositoryRootPath) {
  await runGit(repositoryRootPath, [
    "switch",
    "-c",
    "fixture/conflict-incoming",
  ]);
  await writeFixtureFile(repositoryRootPath, "conflict.txt", "incoming\n");
  await runGit(repositoryRootPath, ["add", "conflict.txt"]);
  await runGit(repositoryRootPath, ["commit", "-m", "test: incoming conflict"]);
  await runGit(repositoryRootPath, ["switch", "main"]);
  await writeFixtureFile(repositoryRootPath, "conflict.txt", "current\n");
  await runGit(repositoryRootPath, ["add", "conflict.txt"]);
  await runGit(repositoryRootPath, ["commit", "-m", "test: current conflict"]);
  await runGit(repositoryRootPath, ["merge", "fixture/conflict-incoming"], {
    allowFailure: true,
  });
}

async function writeFixtureFile(
  repositoryRootPath,
  relativeFilePath,
  contents,
) {
  await vscode.workspace.fs.writeFile(
    vscode.Uri.file(path.join(repositoryRootPath, relativeFilePath)),
    Buffer.from(contents),
  );
}

async function runGit(repositoryRootPath, gitArguments, options = {}) {
  try {
    await executeFile("git", gitArguments, {
      cwd: repositoryRootPath,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    if (!options.allowFailure) throw error;
  }
}

async function readGit(repositoryRootPath, gitArguments) {
  const result = await executeFile("git", gitArguments, {
    cwd: repositoryRootPath,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  return result.stdout;
}

async function cancelInteractiveReadCommand(commandIdentifier, options = {}) {
  const cancellationPickerIndex = options.cancellationPickerIndex ?? 0;
  const observedPickers = [];
  let pickerAssertionError;
  const originalShowQuickPick = vscode.window.showQuickPick;
  vscode.window.showQuickPick = (pickerItems, pickerOptions) => {
    const pickerIndex = observedPickers.length;
    observedPickers.push({ pickerItems, pickerOptions });
    try {
      options.assertPicker?.(pickerItems, pickerOptions, pickerIndex);
    } catch (error) {
      pickerAssertionError = error;
    }
    let selectedItem;
    try {
      selectedItem = options.selectPicker?.(pickerItems, pickerIndex);
    } catch (error) {
      pickerAssertionError = error;
    }
    if (selectedItem !== undefined) return Promise.resolve(selectedItem);
    return originalShowQuickPick.call(
      vscode.window,
      pickerItems,
      pickerOptions,
    );
  };
  let interactiveCommandOutcome = { settled: false, error: undefined };
  let interactiveCommandCompletion;
  try {
    const interactiveCommandPromise =
      vscode.commands.executeCommand(commandIdentifier);
    interactiveCommandCompletion = interactiveCommandPromise.then(
      () => {
        interactiveCommandOutcome = { settled: true, error: undefined };
      },
      (error) => {
        interactiveCommandOutcome = { settled: true, error };
      },
    );

    await waitForCondition(
      `${commandIdentifier} picker ${cancellationPickerIndex + 1}`,
      () => observedPickers.length > cancellationPickerIndex,
      quickPickCancellationAttemptLimit * quickPickCancellationPollMilliseconds,
    );
    for (
      let attemptIndex = 0;
      attemptIndex < quickPickCancellationAttemptLimit &&
      !interactiveCommandOutcome.settled;
      attemptIndex += 1
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, quickPickCancellationPollMilliseconds),
      );
      if (interactiveCommandOutcome.settled) break;
      await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
    }

    if (!interactiveCommandOutcome.settled) {
      throw new Error(
        `Timed out cancelling ${commandIdentifier} after ${quickPickCancellationAttemptLimit * quickPickCancellationPollMilliseconds}ms.`,
      );
    }
    await interactiveCommandCompletion;
    if (interactiveCommandOutcome.error !== undefined)
      throw interactiveCommandOutcome.error;
    if (pickerAssertionError !== undefined) throw pickerAssertionError;
  } finally {
    if (!interactiveCommandOutcome.settled) {
      try {
        await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
      } catch {
        // The command may already be closing the picker during shutdown.
      }
      if (interactiveCommandCompletion !== undefined) {
        await Promise.race([
          interactiveCommandCompletion,
          new Promise((resolve) => setTimeout(resolve, 1_000)),
        ]);
      }
    }
    vscode.window.showQuickPick = originalShowQuickPick;
  }
}

async function waitForValue(description, readValue, predicate) {
  let lastValue;
  await waitForCondition(description, async () => {
    lastValue = await readValue();
    return predicate(lastValue);
  });
  return lastValue;
}

async function sha256File(filePath) {
  const fileContents = await readFile(filePath);
  return createHash("sha256").update(fileContents).digest("hex");
}

function repositorySnapshot(repository) {
  const repositoryRootPath = repository.rootUri.fsPath;
  const relativeResourcePath = (resourceState) =>
    relativePathWithinRepository(
      repositoryRootPath,
      extractUriFilePath(resourceState.uri),
    );
  const untrackedResourceStates = [
    ...repository.state.untrackedChanges,
    ...repository.state.workingTreeChanges.filter(
      (resourceState) => resourceState.status === gitUntrackedStatus,
    ),
  ];
  return {
    headName: repository.state.HEAD?.name,
    headCommit: repository.state.HEAD?.commit,
    stagedPaths: repository.state.indexChanges.map(relativeResourcePath),
    workingTreePaths: repository.state.workingTreeChanges
      .filter((resourceState) => resourceState.status !== gitUntrackedStatus)
      .map(relativeResourcePath),
    untrackedPaths: untrackedResourceStates.map(relativeResourcePath),
  };
}

async function getLocalBranchNames(repository) {
  const localBranches = await repository.getBranches({ remote: false });
  return localBranches.flatMap((branch) =>
    branch.name === undefined ? [] : [branch.name],
  );
}

async function waitForRepository(gitApi, expectedRepositoryPath) {
  let repository;
  await waitForCondition("bundled Git repository discovery", () => {
    repository = gitApi.repositories.find((candidateRepository) =>
      pathsRepresentSameLocation(
        candidateRepository.rootUri.fsPath,
        expectedRepositoryPath,
      ),
    );
    return repository !== undefined;
  });
  return repository;
}

async function refreshRepositoryStatus(repository) {
  assert.equal(
    typeof repository.status,
    "function",
    "Bundled vscode.git repository status refresh is required",
  );
  await repository.status();
}

async function waitForCondition(
  description,
  condition,
  timeoutMilliseconds = 15_000,
) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}
