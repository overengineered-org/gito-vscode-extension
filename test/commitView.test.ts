import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { extractGeneratedBrowserScript } from "./webviewTestUtils.ts";

class SimulatedWebviewElement {
  public attributes: Record<string, string> = {};
  public clientHeight = 34;
  public clientWidth = 300;
  public children: SimulatedWebviewElement[] = [];
  public className = "";
  public dataset: Record<string, string> = {};
  public disabled = false;
  public hidden = false;
  public innerHTML = "";
  public placeholder = "";
  public scrollLeft = 0;
  public scrollTop = 0;
  public selected = false;
  public style: Record<string, string> = {};
  public textContent = "";
  public title = "";
  public type = "";
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

  public append(...children: SimulatedWebviewElement[]): void {
    this.children.push(...children);
  }

  public replaceChildren(...children: SimulatedWebviewElement[]): void {
    this.children = children;
    this.value = children.find((child) => child.selected)?.value ?? this.value;
  }

  public setAttribute(attributeName: string, attributeValue: string): void {
    this.attributes[attributeName] = attributeValue;
  }
}

const commitViewSource = readFileSync(
  new URL("../src/commitView.ts", import.meta.url),
  "utf8",
);
const generatedCommitViewScript = extractGeneratedBrowserScript(commitViewSource);

test("uses theme-aware branch and motion-safe change presentation", () => {
  assert.match(commitViewSource, /id="branch-name" class="branch-name"/u);
  assert.match(commitViewSource, /class="branch"><svg[^>]*aria-hidden="true"/u);
  assert.match(commitViewSource, /color: var\(--vscode-charts-green\)/u);
  assert.match(commitViewSource, /@keyframes clean-state-enter/u);
  assert.match(
    commitViewSource,
    /@media \(prefers-reduced-motion: reduce\)[^}]*animation-duration: \.01ms !important/u,
  );
});

test("keeps commit controls and working-tree actions synchronized", () => {
  const simulatedElements = new Map<string, SimulatedWebviewElement>();
  const postedMessages: unknown[] = [];
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
    acquireVsCodeApi: () => ({ postMessage: (message: unknown) => postedMessages.push(message) }),
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

  windowMessageListener({
    data: {
      branchName: "main",
      changeGroups: [{
        changes: [{
          description: "src M",
          filePath: "/repository/src/changed.ts",
          label: "changed.ts",
        }],
        groupKind: "unstaged",
        label: "Changes",
      }],
      gitActionInProgress: false,
      commitMessage: "",
      repositories: [{ label: "Git'o", path: "/repository" }],
      selectedRepositoryPath: "/repository",
      stagedChangeCount: 0,
      type: "state",
      unstagedChangeCount: 1,
    },
  });
  const [changeGroup] = getSimulatedElement("changes").children;
  assert.ok(changeGroup);
  const [changeGroupHeader, changeRow] = changeGroup.children;
  assert.ok(changeGroupHeader);
  assert.ok(changeRow);
  const stageAllButton = changeGroupHeader.children.at(-1);
  stageAllButton?.dispatch("click");
  stageAllButton?.dispatch("click");
  windowMessageListener({ data: { busy: false, completed: true, type: "changeStatus" } });
  changeRow.children[0]?.dispatch("click");
  windowMessageListener({ data: { busy: false, completed: true, type: "changeStatus" } });
  changeRow.children[1]?.dispatch("click");
  windowMessageListener({ data: { busy: false, completed: true, type: "changeStatus" } });
  changeRow.children[2]?.dispatch("click");
  assert.deepEqual(JSON.parse(JSON.stringify(postedMessages.slice(-4))), [
    {
      action: "stageGroup",
      groupKind: "unstaged",
      repositoryPath: "/repository",
      type: "changeAction",
    },
    {
      action: "open",
      filePath: "/repository/src/changed.ts",
      groupKind: "unstaged",
      repositoryPath: "/repository",
      type: "changeAction",
    },
    {
      action: "stage",
      filePath: "/repository/src/changed.ts",
      groupKind: "unstaged",
      repositoryPath: "/repository",
      type: "changeAction",
    },
    {
      action: "discard",
      filePath: "/repository/src/changed.ts",
      groupKind: "unstaged",
      repositoryPath: "/repository",
      type: "changeAction",
    },
  ]);
});
