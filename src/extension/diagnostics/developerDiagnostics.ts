import * as vscode from "vscode";

export const developerDiagnosticsSettingKey = "gito.developerDiagnostics";
export const developerDiagnosticsCommandIds = {
  open: "gito.developerDiagnostics.open",
  toggle: "gito.developerDiagnostics.toggle",
} as const;

export type DeveloperDiagnosticEventName =
  | "dashboard.refresh.repository-state"
  | "diagnostics.state"
  | "diff.command.started"
  | "diff.command.completed"
  | "diff.content.requested"
  | "diff.editor.dispatching"
  | "diff.editor.dispatched"
  | "diff.editor.failed"
  | "diff.plan.creation"
  | "diff.progress.entered"
  | "diff.recent.repository"
  | "diff.recent.state"
  | "diff.repository.binding"
  | "diff.repository.validated"
  | "diff.session.context-dispatched"
  | "repository.state.changed";

type DeveloperDiagnosticOutcome =
  "completed" | "cancelled" | "disabled" | "enabled" | "failed" | "started";

const developerDiagnosticEventNames = new Set<unknown>([
  "dashboard.refresh.repository-state",
  "diagnostics.state",
  "diff.command.started",
  "diff.command.completed",
  "diff.content.requested",
  "diff.editor.dispatching",
  "diff.editor.dispatched",
  "diff.editor.failed",
  "diff.plan.creation",
  "diff.progress.entered",
  "diff.recent.repository",
  "diff.recent.state",
  "diff.repository.binding",
  "diff.repository.validated",
  "diff.session.context-dispatched",
  "repository.state.changed",
]);
const developerDiagnosticOutcomes = new Set<unknown>([
  "completed",
  "cancelled",
  "disabled",
  "enabled",
  "failed",
  "started",
]);
const diagnosticBurstWindowMilliseconds = 250;

interface DeveloperDiagnosticFields {
  readonly durationMilliseconds?: number;
  readonly outcome?: DeveloperDiagnosticOutcome;
}

/** Default-off, local-only diagnostics with a deliberately fixed safe schema. */
export class DeveloperDiagnostics implements vscode.Disposable {
  private readonly outputChannel =
    vscode.window.createOutputChannel("Git'o Diagnostics");
  private readonly disposables: vscode.Disposable[];
  private readonly lastRecordedAtByEventName = new Map<
    DeveloperDiagnosticEventName,
    number
  >();
  private readonly suppressedCountByEventName = new Map<
    DeveloperDiagnosticEventName,
    number
  >();
  private enabled = readDeveloperDiagnosticsEnabled();
  private disposed = false;

  public constructor() {
    this.disposables = [
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration(developerDiagnosticsSettingKey)) return;
        const nextEnabled = readDeveloperDiagnosticsEnabled();
        if (nextEnabled === this.enabled) return;
        if (nextEnabled) {
          this.enabled = true;
          this.record("diagnostics.state", { outcome: "enabled" });
        } else {
          this.record("diagnostics.state", { outcome: "disabled" });
          this.enabled = false;
          this.lastRecordedAtByEventName.clear();
          this.suppressedCountByEventName.clear();
        }
      }),
      vscode.commands.registerCommand(developerDiagnosticsCommandIds.open, () =>
        this.outputChannel.show(true),
      ),
      vscode.commands.registerCommand(
        developerDiagnosticsCommandIds.toggle,
        async () => {
          const nextEnabled = !readDeveloperDiagnosticsEnabled();
          await vscode.workspace
            .getConfiguration()
            .update(
              developerDiagnosticsSettingKey,
              nextEnabled,
              vscode.ConfigurationTarget.Global,
            );
          if (nextEnabled) this.outputChannel.show(true);
        },
      ),
    ];
  }

  public record(
    eventName: DeveloperDiagnosticEventName,
    fields: DeveloperDiagnosticFields = {},
  ): void {
    if (
      !this.enabled ||
      this.disposed ||
      !isDeveloperDiagnosticEvent(eventName)
    )
      return;
    const recordedAtMilliseconds = performance.now();
    const suppressedEventCount = this.takeSuppressedEventCount(
      eventName,
      recordedAtMilliseconds,
    );
    if (suppressedEventCount === undefined) return;
    this.writeDiagnosticLine(eventName, fields, suppressedEventCount);
  }

  public async traceOperation<OperationResult>(
    eventName: DeveloperDiagnosticEventName,
    operation: () => Promise<OperationResult>,
  ): Promise<OperationResult> {
    if (!this.enabled || this.disposed) return operation();
    const startedAtMilliseconds = performance.now();
    if (!isDeveloperDiagnosticEvent(eventName)) return operation();
    const suppressedEventCount = this.takeSuppressedEventCount(
      eventName,
      startedAtMilliseconds,
    );
    if (suppressedEventCount === undefined) return operation();
    this.writeDiagnosticLine(
      eventName,
      { outcome: "started" },
      suppressedEventCount,
    );
    try {
      const operationResult = await operation();
      this.writeDiagnosticLine(
        eventName,
        {
          outcome: "completed",
          durationMilliseconds: performance.now() - startedAtMilliseconds,
        },
        0,
      );
      return operationResult;
    } catch (error: unknown) {
      this.writeDiagnosticLine(
        eventName,
        {
          outcome:
            error instanceof Error && error.name === "AbortError"
              ? "cancelled"
              : "failed",
          durationMilliseconds: performance.now() - startedAtMilliseconds,
        },
        0,
      );
      throw error;
    }
  }

  private takeSuppressedEventCount(
    eventName: DeveloperDiagnosticEventName,
    recordedAtMilliseconds: number,
  ): number | undefined {
    if (eventName === "diagnostics.state") return 0;
    const lastRecordedAtMilliseconds =
      this.lastRecordedAtByEventName.get(eventName);
    if (
      lastRecordedAtMilliseconds !== undefined &&
      recordedAtMilliseconds - lastRecordedAtMilliseconds <
        diagnosticBurstWindowMilliseconds
    ) {
      this.suppressedCountByEventName.set(
        eventName,
        (this.suppressedCountByEventName.get(eventName) ?? 0) + 1,
      );
      return undefined;
    }
    this.lastRecordedAtByEventName.set(eventName, recordedAtMilliseconds);
    const suppressedEventCount =
      this.suppressedCountByEventName.get(eventName) ?? 0;
    this.suppressedCountByEventName.delete(eventName);
    return suppressedEventCount;
  }

  private writeDiagnosticLine(
    eventName: DeveloperDiagnosticEventName,
    fields: DeveloperDiagnosticFields,
    suppressedEventCount: number,
  ): void {
    try {
      const serializedFields = [
        ...(developerDiagnosticOutcomes.has(fields.outcome)
          ? [`outcome=${fields.outcome}`]
          : []),
        ...(typeof fields.durationMilliseconds === "number" &&
        Number.isFinite(fields.durationMilliseconds)
          ? [
              `durationMs=${Math.max(0, Math.round(fields.durationMilliseconds))}`,
            ]
          : []),
        ...(suppressedEventCount > 0
          ? [`suppressed=${suppressedEventCount}`]
          : []),
      ];
      this.outputChannel.appendLine(
        serializedFields.length === 0
          ? eventName
          : `${eventName} ${serializedFields.join(" ")}`,
      );
    } catch {
      // Diagnostics must never change product behavior.
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.outputChannel.dispose();
  }
}

function isDeveloperDiagnosticEvent(
  eventName: unknown,
): eventName is DeveloperDiagnosticEventName {
  return developerDiagnosticEventNames.has(eventName);
}

function readDeveloperDiagnosticsEnabled(): boolean {
  return vscode.workspace
    .getConfiguration()
    .get<boolean>(developerDiagnosticsSettingKey, false);
}
