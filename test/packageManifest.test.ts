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
      "gito.toggleCommitDiffLayout",
    ],
  );
  assert.deepEqual(extensionManifest.contributes.menus?.["editor/title"], [
    {
      command: "gito.toggleCommitDiffLayout",
      group: "navigation@10",
      when: "activeEditor == multiDiffEditor",
    },
  ]);
  assert.deepEqual(
    extensionManifest.contributes.menus?.["view/item/context"]?.map(
      (menuContribution) => menuContribution.command,
    ),
    [
      "gito.stageChange",
      "gito.unstageChange",
      "gito.discardChange",
      "gito.stageGroup",
      "gito.unstageGroup",
    ],
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
