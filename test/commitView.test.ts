import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { extractGeneratedBrowserScript } from "./webviewTestUtils.ts";

class SimulatedWebviewElement {
  public clientHeight = 34;
  public clientWidth = 300;
  public dataset: Record<string, string> = {};
  public disabled = false;
  public hidden = false;
  public placeholder = "";
  public scrollLeft = 0;
  public scrollTop = 0;
  public selected = false;
  public style: Record<string, string> = {};
  public textContent = "";
  public value = "";

  private readonly eventListeners = new Map<string, (event?: unknown) => void>();

  public addEventListener(
    eventName: string,
    eventListener: (event?: unknown) => void,
  ): void {
    this.eventListeners.set(eventName, eventListener);
  }

  public dispatch(eventName: string, event?: unknown): void {
    this.eventListeners.get(eventName)?.(event);
  }

  public replaceChildren(): void {}
}

const commitViewSource = readFileSync(
  new URL("../src/commitView.ts", import.meta.url),
  "utf8",
);
const generatedCommitViewScript = extractGeneratedBrowserScript(commitViewSource);

test("highlights commit subject graphemes beyond 50 without highlighting the body", () => {
  const simulatedElements = new Map<string, SimulatedWebviewElement>();
  let windowMessageListener: ((event: unknown) => void) | undefined;
  const getSimulatedElement = (elementId: string): SimulatedWebviewElement => {
    const existingElement = simulatedElements.get(elementId);
    if (existingElement !== undefined) {
      return existingElement;
    }
    const simulatedElement = new SimulatedWebviewElement();
    simulatedElements.set(elementId, simulatedElement);
    return simulatedElement;
  };
  const simulatedDocument = {
    activeElement: undefined as SimulatedWebviewElement | undefined,
    createElement: () => new SimulatedWebviewElement(),
    getElementById: getSimulatedElement,
  };

  runInNewContext(generatedCommitViewScript, {
    acquireVsCodeApi: () => ({ postMessage: () => undefined }),
    document: simulatedDocument,
    Intl,
    navigator: { platform: "MacIntel" },
    ResizeObserver: class {
      public observe(): void {}
    },
    window: {
      addEventListener: (eventName: string, eventListener: (event: unknown) => void) => {
        if (eventName === "message") {
          windowMessageListener = eventListener;
        }
      },
    },
  });

  const longCommitMessage = `${"😀".repeat(51)}\nBody text remains normal`;
  assert.ok(windowMessageListener);
  windowMessageListener({
    data: {
      branchName: "main",
      gitActionInProgress: false,
      commitMessage: longCommitMessage,
      repositories: [{ label: "Git'o", path: "/repository" }],
      selectedRepositoryPath: "/repository",
      stagedChangeCount: 1,
      type: "state",
      unstagedChangeCount: 0,
    },
  });

  const commitMessageInput = getSimulatedElement("message");

  assert.equal(getSimulatedElement("message-within-limit").textContent, "😀".repeat(50));
  assert.equal(getSimulatedElement("message-overflow").textContent, "😀");
  assert.equal(
    getSimulatedElement("message-body").textContent,
    "\nBody text remains normal",
  );
  assert.equal(getSimulatedElement("message-count").textContent, "51/50 · 1 over");
  assert.equal(getSimulatedElement("message-count").dataset.overLimit, "true");
  assert.equal(commitMessageInput.value, longCommitMessage);
  assert.equal(getSimulatedElement("commit").disabled, false);
  assert.equal(getSimulatedElement("commit-options").disabled, false);

  getSimulatedElement("commit-options").dispatch("click");
  windowMessageListener({
    data: {
      branchName: "main",
      gitActionInProgress: false,
      commitMessage: longCommitMessage,
      repositories: [{ label: "Git'o", path: "/repository" }],
      selectedRepositoryPath: "/repository",
      stagedChangeCount: 1,
      type: "state",
      unstagedChangeCount: 0,
    },
  });
  assert.equal(getSimulatedElement("commit").disabled, true);
  assert.equal(getSimulatedElement("commit-options").disabled, true);

  windowMessageListener({ data: { busy: false, type: "commitStatus" } });
  assert.equal(getSimulatedElement("commit").disabled, false);
  assert.equal(getSimulatedElement("commit-options").disabled, false);

  windowMessageListener({
    data: {
      branchName: "main",
      gitActionInProgress: false,
      commitMessage: "",
      repositories: [{ label: "Git'o", path: "/repository" }],
      selectedRepositoryPath: "/repository",
      stagedChangeCount: 0,
      type: "state",
      unstagedChangeCount: 0,
    },
  });

  assert.equal(getSimulatedElement("commit").disabled, true);
  assert.equal(getSimulatedElement("commit-options").disabled, false);

  commitMessageInput.value = "typed";
  commitMessageInput.dispatch("input");
  assert.equal(getSimulatedElement("message-within-limit").textContent, "typed");
  assert.equal(getSimulatedElement("message-overflow").textContent, "");
  assert.equal(getSimulatedElement("message-count").textContent, "5/50");

  simulatedDocument.activeElement = commitMessageInput;
  windowMessageListener({
    data: {
      branchName: "main",
      gitActionInProgress: false,
      commitMessage: "typed",
      repositories: [{ label: "Git'o", path: "/repository" }],
      selectedRepositoryPath: "/repository",
      stagedChangeCount: 1,
      type: "state",
      unstagedChangeCount: 0,
    },
  });
  getSimulatedElement("commit").dispatch("click");
  windowMessageListener({
    data: {
      branchName: "main",
      gitActionInProgress: true,
      commitMessage: "",
      repositories: [{ label: "Git'o", path: "/repository" }],
      selectedRepositoryPath: "/repository",
      stagedChangeCount: 0,
      type: "state",
      unstagedChangeCount: 0,
    },
  });
  assert.equal(commitMessageInput.value, "");
  assert.equal(getSimulatedElement("message-count").textContent, "0/50");

  windowMessageListener({ data: { busy: false, type: "commitStatus" } });
  windowMessageListener({
    data: {
      branchName: "Detached HEAD",
      gitActionInProgress: false,
      commitMessage: "",
      repositories: [],
      stagedChangeCount: 0,
      type: "state",
      unstagedChangeCount: 0,
    },
  });
  assert.equal(commitMessageInput.disabled, true);
  assert.equal(getSimulatedElement("commit").disabled, true);
  assert.equal(getSimulatedElement("commit-options").disabled, true);
});

test("keeps selected commit-message text visible", () => {
  assert.match(
    commitViewSource,
    /\.message-editor textarea::selection\s*\{[^}]*color:\s*var\(--vscode-editor-selectionForeground,/su,
  );
});

test("uses precise accessible icons instead of text glyphs", () => {
  assert.doesNotMatch(commitViewSource, />[⌄✓]</u);
  assert.match(commitViewSource, /aria-label="Open commit and push actions"/u);
  assert.match(commitViewSource, /<svg class="action-icon"/u);
});
