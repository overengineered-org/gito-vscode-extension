import * as vscode from "vscode";

import {
  graphExtensionToWebviewMessageSchema,
  graphWebviewToExtensionMessageSchema,
  type GraphExtensionToWebviewMessage,
} from "../../protocol/graphExperienceProtocol.js";
import {
  createContentSecurityNonce,
  escapeHtmlAttribute,
} from "../security/webviewSecurity.js";
import type { GraphExperienceController } from "./graphExperienceController.js";

/** Webview transport only; graph data and actions remain extension-host owned. */
export class GraphExperiencePanel implements vscode.WebviewPanelSerializer {
  private graphPanel: vscode.WebviewPanel | undefined;
  private panelDisposeSubscription: vscode.Disposable | undefined;
  private messageSubscription: vscode.Disposable | undefined;
  private readonly activePanelRequestIds = new Map<string, number>();
  private panelSessionEpoch = 0;
  private disposed = false;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: GraphExperienceController,
    private readonly releaseSession: () => void = () => undefined,
  ) {}

  public revealOrCreate(): void {
    if (this.disposed) return;
    if (this.graphPanel !== undefined) {
      this.graphPanel.reveal(vscode.ViewColumn.Active, true);
      return;
    }
    const graphPanel = vscode.window.createWebviewPanel(
      "gito.commitGraph",
      "Commit Graph",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
      },
    );
    this.configurePanel(graphPanel);
  }

  public deserializeWebviewPanel(
    graphPanel: vscode.WebviewPanel,
  ): Promise<void> {
    if (this.disposed) {
      graphPanel.dispose();
      return Promise.resolve();
    }
    this.configurePanel(graphPanel);
    return Promise.resolve();
  }

  /** Reboots an existing webview so rows from a replaced repository vanish. */
  public refresh(): void {
    if (this.disposed || this.graphPanel === undefined) return;
    this.configurePanel(this.graphPanel);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPanelRequests();
    this.disposePanelSubscriptions();
    const graphPanel = this.graphPanel;
    this.graphPanel = undefined;
    graphPanel?.dispose();
  }

  private configurePanel(graphPanel: vscode.WebviewPanel): void {
    this.cancelPanelRequests();
    this.disposePanelSubscriptions();
    this.panelSessionEpoch += 1;
    this.graphPanel = graphPanel;
    graphPanel.webview.html = this.createWebviewHtml(graphPanel.webview);
    this.panelDisposeSubscription = graphPanel.onDidDispose(() => {
      if (this.graphPanel !== graphPanel) return;
      this.cancelPanelRequests();
      this.disposePanelSubscriptions();
      this.graphPanel = undefined;
      this.releaseSession();
    });
    this.messageSubscription = graphPanel.webview.onDidReceiveMessage(
      (untrustedMessage: unknown) => {
        void this.handleWebviewMessage(untrustedMessage);
      },
    );
  }

  private async handleWebviewMessage(untrustedMessage: unknown): Promise<void> {
    if (this.disposed || this.graphPanel === undefined) return;
    const graphPanel = this.graphPanel;
    const panelSessionEpoch = this.panelSessionEpoch;
    const parsedMessage =
      graphWebviewToExtensionMessageSchema.safeParse(untrustedMessage);
    if (!parsedMessage.success) return;
    const requestId = graphRequestId(parsedMessage.data);
    const requestKey =
      requestId === undefined ? undefined : `${panelSessionEpoch}:${requestId}`;
    if (requestId !== undefined)
      this.activePanelRequestIds.set(
        `${panelSessionEpoch}:${requestId}`,
        requestId,
      );
    try {
      const response = await this.controller.handleMessage(parsedMessage.data);
      if (
        response !== undefined &&
        !this.disposed &&
        panelSessionEpoch === this.panelSessionEpoch &&
        this.graphPanel === graphPanel
      )
        this.postWebviewMessage(response, graphPanel);
    } finally {
      if (requestKey !== undefined)
        this.activePanelRequestIds.delete(requestKey);
    }
  }

  private postWebviewMessage(
    message: GraphExtensionToWebviewMessage,
    graphPanel = this.graphPanel,
  ): void {
    const parsedMessage =
      graphExtensionToWebviewMessageSchema.safeParse(message);
    if (!parsedMessage.success) return;
    void Promise.resolve(
      graphPanel?.webview.postMessage(parsedMessage.data),
    ).catch(() => undefined);
  }

  private cancelPanelRequests(): void {
    for (const requestId of this.activePanelRequestIds.values())
      this.controller.cancel(requestId);
    this.activePanelRequestIds.clear();
  }

  private disposePanelSubscriptions(): void {
    this.panelDisposeSubscription?.dispose();
    this.panelDisposeSubscription = undefined;
    this.messageSubscription?.dispose();
    this.messageSubscription = undefined;
  }

  private createWebviewHtml(webview: vscode.Webview): string {
    const contentSecurityNonce = createContentSecurityNonce();
    const webviewScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "graph.js"),
    );
    const webviewStylesheetUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "graph.css"),
    );
    const escapedCspSource = escapeHtmlAttribute(webview.cspSource);
    const escapedContentSecurityNonce =
      escapeHtmlAttribute(contentSecurityNonce);
    const escapedScriptUri = escapeHtmlAttribute(webviewScriptUri.toString());
    const escapedStylesheetUri = escapeHtmlAttribute(
      webviewStylesheetUri.toString(),
    );
    return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="gito-webview-style-nonce" content="${escapedContentSecurityNonce}"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; object-src 'none'; style-src ${escapedCspSource} 'nonce-${escapedContentSecurityNonce}'; font-src ${escapedCspSource}; script-src 'nonce-${escapedContentSecurityNonce}';"><link rel="stylesheet" href="${escapedStylesheetUri}"><title>Commit Graph</title></head><body><div id="gito-graph-root"></div><script nonce="${escapedContentSecurityNonce}" src="${escapedScriptUri}"></script></body></html>`;
  }
}

function graphRequestId(
  message: ReturnType<typeof graphWebviewToExtensionMessageSchema.parse>,
): number | undefined {
  return message.messageType === "graphReady" ? 0 : message.requestId;
}
