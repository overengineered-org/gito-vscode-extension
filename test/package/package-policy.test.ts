import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("VSIX package policy", () => {
  it("declares an exact package allowlist", () => {
    const packageManifest = JSON.parse(
      readFileSync("package.json", "utf8"),
    ) as Record<string, unknown>;
    expect(packageManifest.files).toEqual([
      "CHANGELOG.md",
      "LICENSE",
      "NOTICE",
      "README.md",
      "SUPPORT.md",
      "dist/extension.js",
      "dist/graph.css",
      "dist/graph.js",
      "dist/webview.css",
      "dist/webview.js",
      "dist/codicon.ttf",
      "media/gito.png",
      "media/gito.svg",
      "media/onboarding/setup.svg",
    ]);
  });

  it("links excluded policy docs to stable repository pages", () => {
    const readmeText = readFileSync("README.md", "utf8");
    const repositoryDocumentBaseUrl =
      "https://github.com/overengineered-org/gito-vscode-extension/blob/main";

    expect(readmeText).toContain(
      `[SECURITY.md](${repositoryDocumentBaseUrl}/SECURITY.md)`,
    );
    expect(readmeText).toContain(
      `[PRIVACY.md](${repositoryDocumentBaseUrl}/PRIVACY.md)`,
    );
    expect(readmeText).not.toContain("[SECURITY.md](SECURITY.md)");
    expect(readmeText).not.toContain("[PRIVACY.md](PRIVACY.md)");
  });

  it("keeps Marketplace identity and privacy claims explicit", () => {
    const packageManifest = JSON.parse(
      readFileSync("package.json", "utf8"),
    ) as Record<string, unknown>;
    expect(packageManifest.name).toBe("gito");
    expect(packageManifest.publisher).toBe("overengineered-org");
    expect(packageManifest.license).toBe("Apache-2.0");
    expect(packageManifest.icon).toBe("media/gito.png");
    expect(JSON.stringify(packageManifest)).not.toMatch(
      /"(?:telemetry|analytics|tracking|feature.?flag)"\s*:/i,
    );
  });

  it("does not publish an unverified cloud provider surface", () => {
    const packageManifestText = readFileSync("package.json", "utf8");
    expect(packageManifestText).not.toMatch(/azure|devops|microsoft/i);
    expect(readFileSync("README.md", "utf8")).not.toMatch(
      /azure|devops|microsoft/i,
    );
  });

  it("declares untrusted-workspace support with a mutation trust boundary", () => {
    const packageManifest = JSON.parse(
      readFileSync("package.json", "utf8"),
    ) as {
      capabilities?: {
        untrustedWorkspaces?: {
          supported?: boolean;
          description?: string;
        };
      };
    };
    expect(packageManifest.capabilities?.untrustedWorkspaces?.supported).toBe(
      true,
    );
    expect(
      packageManifest.capabilities?.untrustedWorkspaces?.description,
    ).toMatch(/Restricted Mode.*onboarding.*read-only repository inspection/i);
    expect(
      packageManifest.capabilities?.untrustedWorkspaces?.description,
    ).toMatch(/mutations require a trusted workspace/i);
    expect(
      packageManifest.capabilities?.untrustedWorkspaces?.description,
    ).toMatch(/bundled Git extension/i);
  });

  it("ships a PNG derived from the checked-in gradient mark", () => {
    const logoSvg = readFileSync("media/gito.svg", "utf8");
    const logoPngHeader = readFileSync("media/gito.png").subarray(0, 8);
    expect(logoSvg).toContain("#7c3aed");
    expect(logoSvg).toContain("#0ea5e9");
    expect(logoPngHeader.toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("keeps command palette entries bounded to task entry points", () => {
    const packageManifest = JSON.parse(
      readFileSync("package.json", "utf8"),
    ) as {
      contributes: {
        commands: readonly { command: string }[];
        menus: { commandPalette: readonly { command: string; when: string }[] };
      };
    };
    const contributedCommands = packageManifest.contributes.commands.map(
      ({ command }) => command,
    );
    const commandPaletteEntries =
      packageManifest.contributes.menus.commandPalette;
    expect(commandPaletteEntries).toHaveLength(contributedCommands.length);
    expect(
      new Set(commandPaletteEntries.map(({ command }) => command)),
    ).toEqual(new Set(contributedCommands));

    const taskEntryCommands = [
      "gito.openHome",
      "gito.refreshDashboard",
      "gito.openChanges",
      "gito.openPullRequests",
      "gito.openCommits",
      "gito.openBranches",
      "gito.openWorktrees",
      "gito.diff.open",
      "gito.diff.openRepository",
      "gito.compare.open",
      "gito.compare.search",
      "gito.compare.actions",
      "gito.openConflicts",
      "gito.openOperations",
      "gito.history.search",
      "gito.graph.open",
    ];
    for (const command of taskEntryCommands)
      expect(
        commandPaletteEntries.find((entry) => entry.command === command)?.when,
      ).toContain("gito.workspaceTrusted");

    expect(
      commandPaletteEntries.find((entry) => entry.command === "gito.openDiff")
        ?.when,
    ).toBe("false");

    for (const command of [
      "gito.history.toggleBlame",
      "gito.history.openFileHistory",
      "gito.history.openLineHistory",
      "gito.history.openContributors",
    ]) {
      expect(
        commandPaletteEntries.find((entry) => entry.command === command)?.when,
      ).toBe(
        "gito.workspaceTrusted && gito.onboarding.localRepositoryAvailable && editorLangId != '' && resourceScheme == file",
      );
    }

    const mutationCommands = [
      "gito.stageChanges",
      "gito.unstageChanges",
      "gito.stageAll",
      "gito.unstageAll",
      "gito.discardChanges",
      "gito.commit",
      "gito.fetch",
      "gito.pull",
      "gito.push",
      "gito.sync",
      "gito.checkoutBranch",
      "gito.createBranch",
      "gito.publishBranch",
      "gito.deleteBranch",
      "gito.forceDeleteBranch",
      "gito.createWorktree",
      "gito.removeWorktree",
    ];
    for (const command of mutationCommands)
      expect(
        commandPaletteEntries.find((entry) => entry.command === command)?.when,
      ).toBe("false");

    const normalTrustedRepositoryEntries = commandPaletteEntries.filter(
      ({ when }) =>
        when !== "false" &&
        !when.includes("gito.diff.sessionActive") &&
        !when.includes("editorLangId") &&
        !when.includes("!gito.onboarding"),
    );
    expect(normalTrustedRepositoryEntries.length).toBeLessThanOrEqual(25);
  });

  it("keeps onboarding visible while gating Git views and context actions", () => {
    const packageManifest = JSON.parse(
      readFileSync("package.json", "utf8"),
    ) as {
      contributes: {
        menus: Record<string, readonly { command: string; when: string }[]>;
        views: Record<string, readonly { id: string; when?: string }[]>;
      };
    };
    const commandPaletteEntries =
      packageManifest.contributes.menus["commandPalette"] ?? [];
    for (const command of [
      "gito.onboarding.openSetup",
      "gito.onboarding.showSourceControlSteps",
      "gito.onboarding.acknowledgeSourceControlVisible",
    ]) {
      expect(
        commandPaletteEntries.find((entry) => entry.command === command)?.when,
      ).not.toContain("gito.workspaceTrusted");
    }

    expect(
      packageManifest.contributes.views.gito?.find(
        (view) => view.id === "gito.navigation",
      )?.when,
    ).toBe("gito.workspaceTrusted");
    for (const menuId of ["explorer/context", "scm/resourceState/context"]) {
      expect(
        packageManifest.contributes.menus[menuId]?.every(({ when }) =>
          when.includes("gito.workspaceTrusted"),
        ),
      ).toBe(true);
    }
  });
});
