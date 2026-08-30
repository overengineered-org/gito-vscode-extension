import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

interface ExtensionManifest {
  readonly browser?: string;
  readonly galleryBanner: { readonly color: string; readonly theme: string };
  readonly icon: string;
  readonly keywords: readonly string[];
  readonly pricing: string;
  readonly capabilities: {
    readonly untrustedWorkspaces: { readonly supported: boolean };
    readonly virtualWorkspaces: boolean;
  };
  readonly contributes: {
    readonly commands?: readonly { readonly command: string }[];
    readonly configuration?: {
      readonly properties: Readonly<
        Record<string, { readonly default: unknown; readonly scope: string; readonly type: string }>
      >;
    };
    readonly configurationDefaults?: Readonly<Record<string, unknown>>;
    readonly menus?: Readonly<
      Record<string, readonly { readonly command: string; readonly when?: string }[]>
    >;
    readonly views: Readonly<
      Record<
        string,
        readonly {
          readonly id: string;
          readonly name: string;
          readonly type?: string;
          readonly visibility?: string;
        }[]
      >
    >;
    readonly viewsWelcome: readonly {
      readonly contents: string;
      readonly view: string;
    }[];
    readonly walkthroughs: readonly {
      readonly description: string;
      readonly id: string;
      readonly steps: readonly {
        readonly completionEvents: readonly string[];
        readonly description: string;
        readonly id: string;
        readonly media: { readonly altText: string; readonly image: string };
        readonly title: string;
      }[];
      readonly title: string;
      readonly when?: string;
    }[];
  };
  readonly extensionDependencies: readonly string[];
  readonly extensionKind: readonly string[];
  readonly scripts: Readonly<Record<string, string>>;
}

const extensionManifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as ExtensionManifest;

test("runs complete static validation before packaging", () => {
  assert.equal(extensionManifest.scripts["vscode:prepublish"], "npm run verify:static");
  assert.equal(
    extensionManifest.scripts["verify:static"],
    "npm run clean && npm run typecheck && npm test && npm run benchmark:product && npm run build",
  );
  assert.equal(
    extensionManifest.scripts["test:integration"],
    "npm run build && npm run build:integration && node test/runIntegration.mjs",
  );
});

test("ships complete Marketplace discovery metadata", () => {
  assert.equal(extensionManifest.icon, "media/gito-icon.png");
  assert.deepEqual(extensionManifest.galleryBanner, {
    color: "#2E0854",
    theme: "dark",
  });
  assert.equal(extensionManifest.pricing, "Free");
  assert.deepEqual(extensionManifest.keywords, [
    "git",
    "source control",
    "branches",
    "tags",
    "worktrees",
    "history",
    "blame",
    "merge conflicts",
  ]);
  assert.ok(existsSync(new URL("../media/gito-icon.png", import.meta.url)));
});

test("ships one desktop path backed by VS Code Git", () => {
  assert.equal(extensionManifest.browser, undefined);
  assert.deepEqual(extensionManifest.extensionKind, ["workspace", "ui"]);
  assert.deepEqual(extensionManifest.extensionDependencies, ["vscode.git"]);
  assert.deepEqual(extensionManifest.capabilities, {
    untrustedWorkspaces: { supported: false },
    virtualWorkspaces: false,
  });
  assert.deepEqual(
    extensionManifest.contributes.commands?.map((commandContribution) =>
      commandContribution.command,
    ),
    [
      "gito.openGettingStarted",
      "gito.compareRemoteTags",
      "gito.showFileHistory",
      "gito.showCurrentLineBlame",
      "gito.refreshGit",
      "gito.toggleInlineBlame",
      "gito.toggleDiffLayout",
      "gito.createWorktree",
      "gito.openWorktreeInCurrentWindow",
      "gito.openWorktreeInNewWindow",
      "gito.renameWorktree",
    ],
  );
  assert.deepEqual(extensionManifest.contributes.menus?.["editor/title"], [
    {
      command: "gito.toggleDiffLayout",
      group: "navigation@10",
      when: "activeEditor == multiDiffEditor",
    },
    {
      command: "gito.showFileHistory",
      group: "navigation@20",
      when: "resourceScheme == file && activeEditor != multiDiffEditor",
    },
  ]);
  assert.deepEqual(extensionManifest.contributes.menus?.["explorer/context"], [
    {
      command: "gito.showFileHistory",
      group: "navigation@20",
      when: "resourceScheme == file",
    },
  ]);
  assert.deepEqual(extensionManifest.contributes.menus?.["view/title"], [
    {
      command: "gito.refreshGit",
      group: "navigation@1",
      when: "view == gito.git",
    },
    {
      command: "gito.openGettingStarted",
      group: "navigation@2",
      when: "view == gito.git",
    },
  ]);
  assert.deepEqual(extensionManifest.contributes.menus?.["view/item/context"], [
    {
      command: "gito.openWorktreeInNewWindow",
      group: "inline",
      when: "view == gito.git && viewItem == gito.worktree.available",
    },
    {
      command: "gito.openWorktreeInCurrentWindow",
      group: "navigation@1",
      when: "view == gito.git && viewItem == gito.worktree.available",
    },
    {
      command: "gito.renameWorktree",
      group: "navigation@2",
      when: "view == gito.git && (viewItem == gito.worktree.current || viewItem == gito.worktree.available)",
    },
  ]);
  assert.deepEqual(extensionManifest.contributes.configurationDefaults, {
    "git.detectWorktrees": true,
  });
  assert.deepEqual(
    extensionManifest.contributes.configuration?.properties["gito.worktrees.storageRoot"],
    {
      default: "",
      markdownDescription:
        "Absolute folder for linked worktrees. `~` is supported. Empty stores them beside the primary repository under `.gito-worktrees/<repository>/`.",
      scope: "machine",
      type: "string",
    },
  );
  assert.deepEqual(
    extensionManifest.contributes.configuration?.properties["gito.blame.inlineEnabled"],
    {
      default: true,
      markdownDescription:
        "Show subtle author, age, and commit summary text after the active line.",
      scope: "window",
      type: "boolean",
    },
  );
  assert.deepEqual(
    extensionManifest.contributes.configuration?.properties["gito.blame.enabled"],
    {
      default: true,
      markdownDescription:
        "Show native current-line authorship in the status bar. No repository data leaves your machine.",
      scope: "window",
      type: "boolean",
    },
  );
  assert.deepEqual(extensionManifest.contributes.views.gito, [
    { id: "gito.git", name: "Git" },
    { id: "gito.commit", name: "Changes", type: "webview", visibility: "visible" },
    { id: "gito.graph", name: "Graph", type: "webview", visibility: "visible" },
  ]);
  assert.deepEqual(extensionManifest.contributes.viewsWelcome, [
    {
      contents:
        "Choose how to start.\n[Clone Repository](command:git.clone)\n[Open Folder](command:vscode.openFolder)\n[Learn Git'o](command:gito.openGettingStarted)",
      view: "gito.git",
    },
  ]);
});

test("onboards every feature group through one native walkthrough", () => {
  const [gettingStartedWalkthrough] = extensionManifest.contributes.walkthroughs;
  assert.ok(gettingStartedWalkthrough);
  assert.equal(extensionManifest.contributes.walkthroughs.length, 1);
  assert.equal(gettingStartedWalkthrough.id, "gettingStarted");
  assert.equal(gettingStartedWalkthrough.when, "!isWeb");
  assert.match(gettingStartedWalkthrough.description, /under two minutes/iu);
  assert.equal(new Set(gettingStartedWalkthrough.steps.map((step) => step.id)).size, 5);
  assert.deepEqual(
    gettingStartedWalkthrough.steps.map((walkthroughStep) => walkthroughStep.id),
    [
      "gito.gettingStarted.repositories",
      "gito.gettingStarted.changes",
      "gito.gettingStarted.graph",
      "gito.gettingStarted.worktrees",
      "gito.gettingStarted.fileContext",
    ],
  );

  const contributedCommandIds = new Set(
    extensionManifest.contributes.commands?.map((commandContribution) =>
      commandContribution.command,
    ),
  );
  const contributedViewIds = new Set(
    Object.values(extensionManifest.contributes.views)
      .flat()
      .map((viewContribution) => viewContribution.id),
  );
  const validWalkthroughCommandIds = new Set([
    ...contributedCommandIds,
    "gito.commit.focus",
    "gito.graph.focus",
    "workbench.view.extension.gito",
  ]);
  for (const walkthroughStep of gettingStartedWalkthrough.steps) {
    assert.match(walkthroughStep.description, /\[.+\]\(command:[^)]+\)/);
    assert.ok(
      existsSync(new URL(`../${walkthroughStep.media.image}`, import.meta.url)),
      `Missing walkthrough media: ${walkthroughStep.media.image}`,
    );
    assert.ok(walkthroughStep.media.altText.length >= 20);
    const walkthroughSvg = readFileSync(
      new URL(`../${walkthroughStep.media.image}`, import.meta.url),
      "utf8",
    );
    assert.match(walkthroughSvg, /<svg[^>]*role="img"[^>]*aria-labelledby=/);
    assert.match(walkthroughSvg, /<title id="title">[^<]+<\/title>/);
    assert.match(walkthroughSvg, /<desc id="description">[^<]+<\/desc>/);
    assert.match(walkthroughSvg, /var\(--vscode-/);
    for (const commandLinkId of extractCommandLinkIds(walkthroughStep.description)) {
      assert.ok(
        validWalkthroughCommandIds.has(commandLinkId),
        `Unknown walkthrough command link: ${commandLinkId}`,
      );
    }

    for (const completionEvent of walkthroughStep.completionEvents) {
      const eventSeparatorIndex = completionEvent.indexOf(":");
      assert.notEqual(eventSeparatorIndex, -1, completionEvent);
      const eventKind = completionEvent.slice(0, eventSeparatorIndex);
      const completionContributionId = completionEvent.slice(eventSeparatorIndex + 1);
      if (eventKind === "onView") {
        assert.ok(contributedViewIds.has(completionContributionId), completionEvent);
      } else if (eventKind === "onCommand") {
        assert.ok(contributedCommandIds.has(completionContributionId), completionEvent);
      } else {
        assert.fail(`Unsupported walkthrough completion event: ${completionEvent}`);
      }
    }
  }
});

function extractCommandLinkIds(markdown: string): readonly string[] {
  return [...markdown.matchAll(/\]\(command:([^)]+)\)/g)].map(
    (commandLinkMatch) => commandLinkMatch[1] ?? "",
  );
}
