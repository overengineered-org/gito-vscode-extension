import * as vscode from "vscode";
import { formatGitErrorForUser } from "../git/gitErrorFormatting.js";
import type { GitoSurfaceServices } from "./surfaceTypes.js";

export function executeSurfaceCommand(
  services: GitoSurfaceServices,
  commandIdentifier: string,
  ...argumentsPassed: readonly unknown[]
): Promise<unknown> {
  return services.commandExecutor.executeCommand(
    commandIdentifier,
    ...argumentsPassed,
  );
}

export function withSurfaceProgress<ProgressResult>(
  title: string,
  operation: (cancellationSignal: AbortSignal) => Promise<ProgressResult>,
): Promise<ProgressResult> {
  return Promise.resolve(
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: true,
      },
      async (_progress, cancellationToken) => {
        const abortController = new AbortController();
        const cancellationSubscription =
          cancellationToken?.onCancellationRequested(() =>
            abortController.abort(),
          );
        if (cancellationToken?.isCancellationRequested === true) {
          abortController.abort();
        }
        try {
          return await operation(abortController.signal);
        } finally {
          cancellationSubscription?.dispose();
        }
      },
    ),
  );
}

export async function reportSurfaceError(error: unknown): Promise<void> {
  if (error instanceof DOMException && error.name === "AbortError") return;
  const message = formatGitErrorForUser(
    error,
    "Git'o could not complete that action.",
  );
  await vscode.window.showErrorMessage(message);
}

export async function runSurfaceCommand(
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error: unknown) {
    await reportSurfaceError(error);
  }
}

export function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

export function formatDate(dateText: string): string {
  const parsedDate = new Date(dateText);
  if (Number.isNaN(parsedDate.getTime())) return dateText;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsedDate);
}

export function comparePaths(leftPath: string, rightPath: string): boolean {
  return (
    leftPath.replaceAll("\\", "/").replace(/\/+$/, "") ===
    rightPath.replaceAll("\\", "/").replace(/\/+$/, "")
  );
}
