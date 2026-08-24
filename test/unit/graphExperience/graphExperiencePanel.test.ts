// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const panelInstances: TestPanel[] = [];

vi.mock("vscode", () => ({
  Disposable: class {
    public constructor(
      private readonly disposeCallback: () => void = () => {},
    ) {}
    public dispose(): void {
      this.disposeCallback();
    }
  },
  Uri: {
    joinPath: (baseUri: { toString(): string }, ...segments: string[]) => ({
      toString: () => `${baseUri.toString()}/${segments.join("/")}`,
    }),
  },
  ViewColumn: { Active: 1 },
  window: {
    createWebviewPanel: (
      _viewType: string,
      _title: string,
      _column: number,
      options: Record<string, unknown>,
    ) => {
      const panel = createTestPanel(options);
      panelInstances.push(panel);
      return panel;
    },
  },
}));

import { GraphExperiencePanel } from "../../../src/extension/graphExperience/graphExperiencePanel.js";

interface TestWebview {
  html: string;
  readonly cspSource: string;
  readonly postMessage: ReturnType<typeof vi.fn>;
  readonly asWebviewUri: (uri: { toString(): string }) => {
    toString(): string;
  };
  readonly onDidReceiveMessage: (listener: (message: unknown) => void) => {
    dispose(): void;
  };
  messageListener: ((message: unknown) => void) | undefined;
}

interface TestPanel {
  readonly creationOptions: Record<string, unknown>;
  readonly webview: TestWebview;
  readonly reveal: ReturnType<typeof vi.fn>;
  readonly onDidDispose: (listener: () => void) => { dispose(): void };
  readonly dispose: () => void;
}

function createTestPanel(
  creationOptions: Record<string, unknown> = {},
): TestPanel {
  const disposeListeners = new Set<() => void>();
  let disposed = false;
  const webview: TestWebview = {
    html: "",
    cspSource: "vscode-resource://test",
    messageListener: undefined,
    postMessage: vi.fn(() => Promise.resolve(true)),
    asWebviewUri: (uri) => ({ toString: () => `webview://${uri.toString()}` }),
    onDidReceiveMessage: (listener) => {
      webview.messageListener = listener;
      return { dispose: () => (webview.messageListener = undefined) };
    },
  };
  return {
    creationOptions,
    webview,
    reveal: vi.fn(),
    onDidDispose: (listener) => {
      disposeListeners.add(listener);
      return { dispose: () => disposeListeners.delete(listener) };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const listener of disposeListeners) listener();
    },
  };
}

const queryMessage = {
  protocolVersion: 1,
  messageType: "graphQuery",
  requestId: 7,
  pageSize: 1,
  append: false,
  filter: { scope: "all" },
  includeWip: false,
  includeWorktrees: false,
} as const;

const operationResponse = {
  protocolVersion: 1,
  messageType: "graphOperationFailed",
  requestId: 7,
  userMessage: "request complete",
} as const;

describe("GraphExperiencePanel", () => {
  it("releases host state when a memory-bounded panel closes", () => {
    const releaseSession = vi.fn();
    const panel = new GraphExperiencePanel(
      { toString: () => "file:///extension" } as never,
      { cancel: vi.fn(), handleMessage: vi.fn() } as never,
      releaseSession,
    );

    panel.revealOrCreate();
    const createdPanel = panelInstances.at(-1)!;
    expect(createdPanel.creationOptions.retainContextWhenHidden).toBe(false);
    createdPanel.dispose();

    expect(releaseSession).toHaveBeenCalledOnce();
  });

  it("authorizes the virtual layout stylesheet with a CSP nonce", () => {
    const controller = {
      cancel: vi.fn(),
      handleMessage: vi.fn(),
    };
    const panel = new GraphExperiencePanel(
      { toString: () => "file:///extension" } as never,
      controller as never,
    );

    panel.revealOrCreate();
    const webviewHtml = panelInstances.at(-1)!.webview.html;
    const styleNonce =
      /name="gito-webview-style-nonce" content="([^"]+)"/u.exec(
        webviewHtml,
      )?.[1];

    expect(styleNonce).toBeDefined();
    expect(webviewHtml).toContain(
      `style-src vscode-resource://test 'nonce-${styleNonce}'`,
    );
    expect(webviewHtml).toContain(`script-src 'nonce-${styleNonce}'`);
    expect(webviewHtml).not.toContain("unsafe-inline");
    expect(webviewHtml).not.toContain("style=");
  });

  it("keeps old-session finally cleanup from deleting a reused request key", async () => {
    let resolveOld: ((response: typeof operationResponse) => void) | undefined;
    let resolveNew: ((response: typeof operationResponse) => void) | undefined;
    const controller = {
      cancel: vi.fn(),
      handleMessage: vi.fn(
        (message: typeof queryMessage) =>
          new Promise<typeof operationResponse>((resolve) => {
            if (message.requestId === 7 && resolveOld === undefined)
              resolveOld = resolve;
            else resolveNew = resolve;
          }),
      ),
    };
    const panel = new GraphExperiencePanel(
      { toString: () => "file:///extension" } as never,
      controller as never,
    );

    panel.revealOrCreate();
    const oldWebview = panelInstances.at(-1)!.webview;
    oldWebview.messageListener?.(queryMessage);
    await Promise.resolve();
    panelInstances.at(-1)!.dispose();
    panel.revealOrCreate();
    const newWebview = panelInstances.at(-1)!.webview;
    newWebview.messageListener?.(queryMessage);
    await Promise.resolve();
    resolveOld?.(operationResponse);
    resolveNew?.(operationResponse);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(newWebview.postMessage).toHaveBeenCalledTimes(1);
    expect(oldWebview.postMessage).not.toHaveBeenCalled();
    expect(controller.cancel).toHaveBeenCalledWith(7);
  });
});
