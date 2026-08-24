import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { workspaceMutationCommandClassifications } from "../../src/extension/security/workspaceTrustGuard.js";

const repositoryRoot = process.cwd();
const localCommandSource = readFileSync(
  resolve(repositoryRoot, "src/extension/commands/localGitCommands.ts"),
  "utf8",
);
const operationsExperienceSource = readFileSync(
  resolve(
    repositoryRoot,
    "src/extension/operationsExperience/operationsExperienceController.ts",
  ),
  "utf8",
);
const operationsExperienceModelSource = readFileSync(
  resolve(
    repositoryRoot,
    "src/extension/operationsExperience/operationsExperienceModels.ts",
  ),
  "utf8",
);
const conflictExperienceSource = readFileSync(
  resolve(
    repositoryRoot,
    "src/extension/conflictExperience/conflictExperienceModels.ts",
  ),
  "utf8",
);
const extensionCompositionSource = readFileSync(
  resolve(repositoryRoot, "src/extension/extensionComposition.ts"),
  "utf8",
);

describe("central mutation command classifications", () => {
  it("covers every local mutation command identifier", () => {
    for (const [commandIdentifier, mutationClass] of Object.entries(
      workspaceMutationCommandClassifications,
    )) {
      expect(["local", "premium"]).toContain(mutationClass);
      if (mutationClass === "local") {
        const commandSource =
          commandIdentifier === "gito.openOperations"
            ? operationsExperienceModelSource
            : commandIdentifier === "gito.openConflicts"
              ? conflictExperienceSource
              : localCommandSource;
        expect(commandSource).toContain(`"${commandIdentifier}"`);
      }
    }
    expect(operationsExperienceSource).toContain(
      "operationsExperienceCommandIds.open",
    );
  });

  it("does not classify read-only local commands as mutations", () => {
    for (const readOnlyCommandIdentifier of [
      "gito.openDiff",
      "gito.copyCommitSha",
      "gito.copyCommitMessage",
      "gito.openCommitFileDiff",
      "gito.openWorktree",
      "gito.openConflicts",
    ]) {
      expect(
        readOnlyCommandIdentifier in workspaceMutationCommandClassifications,
      ).toBe(false);
    }
  });

  it("routes command registration through the trust-aware registry", () => {
    expect(extensionCompositionSource).toContain(
      "createTrustedCommandRegistry",
    );
    expect(extensionCompositionSource).toContain(
      "localGitExtensionHost.registerCommands(trustedCommandRegistry)",
    );
    expect(extensionCompositionSource).toContain(
      "registerConflictExperienceCommands(\n      trustedCommandRegistry",
    );
    expect(extensionCompositionSource).toContain(
      "registerOperationsExperienceCommands(\n      trustedCommandRegistry",
    );
    expect(extensionCompositionSource).toContain(
      "workspaceTrustGuard.runTrustedMutation",
    );
  });
});
