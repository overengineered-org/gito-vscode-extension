import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

interface ExtensionManifest {
  readonly browser?: string;
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
  };
  readonly extensionDependencies: readonly string[];
  readonly extensionKind: readonly string[];
}

const extensionManifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as ExtensionManifest;

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
      "gito.compareRemoteTags",
      "gito.stageChange",
      "gito.unstageChange",
      "gito.discardChange",
      "gito.stageGroup",
      "gito.unstageGroup",
      "gito.resolveConflict",
      "gito.toggleCommitDiffLayout",
      "gito.showFileHistory",
      "gito.showCurrentLineBlame",
      "gito.refreshGit",
      "gito.toggleInlineBlame",
      "gito.createWorktree",
      "gito.openWorktreeInCurrentWindow",
      "gito.openWorktreeInNewWindow",
      "gito.renameWorktree",
    ],
  );
  assert.deepEqual(extensionManifest.contributes.menus?.["editor/title"], [
    {
      command: "gito.toggleCommitDiffLayout",
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
  ]);
  assert.deepEqual(extensionManifest.contributes.menus?.["view/item/context"], [
    {
      command: "gito.stageChange",
      group: "inline",
      when: "view == gito.changes && viewItem == gito.change.unstaged",
    },
    {
      command: "gito.unstageChange",
      group: "inline",
      when: "view == gito.changes && viewItem == gito.change.staged",
    },
    {
      command: "gito.discardChange",
      group: "navigation",
      when: "view == gito.changes && viewItem == gito.change.unstaged",
    },
    {
      command: "gito.stageGroup",
      group: "inline",
      when: "view == gito.changes && viewItem == gito.group.unstaged",
    },
    {
      command: "gito.resolveConflict",
      group: "inline",
      when: "view == gito.changes && viewItem == gito.change.conflicts",
    },
    {
      command: "gito.unstageGroup",
      group: "inline",
      when: "view == gito.changes && viewItem == gito.group.staged",
    },
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
    { id: "gito.commit", name: "Commit", type: "webview", visibility: "visible" },
    { id: "gito.changes", name: "Changes", visibility: "visible" },
    { id: "gito.graph", name: "Graph", type: "webview", visibility: "visible" },
  ]);
  assert.deepEqual(extensionManifest.contributes.viewsWelcome, [
    {
      contents:
        "Choose how to start.\n[Clone Repository](command:git.clone)\n[Open Folder](command:vscode.openFolder)",
      view: "gito.git",
    },
  ]);
});
