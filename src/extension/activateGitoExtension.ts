import * as vscode from "vscode";
import { composeGitoExtension } from "./extensionComposition.js";

export function activateGitoExtension(
  extensionContext: vscode.ExtensionContext,
): void {
  const extensionComposition = composeGitoExtension(extensionContext);
  extensionContext.subscriptions.push(...extensionComposition.disposables);
}

export function deactivateGitoExtension(): void {}
