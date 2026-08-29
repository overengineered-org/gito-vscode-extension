import { relative } from "node:path";

import * as vscode from "vscode";

import {
  formatBlameAge,
  formatLineBlameAnnotation,
  type LineBlame,
  parseLineBlame,
} from "./blameModel.ts";
import type { GitApi, GitRepository } from "./gitApi.ts";
import { runGitCommand } from "./gitCommand.ts";
import type { WorkspaceRepositories } from "./workspaceRepositories.ts";

interface CurrentLineContext {
  readonly blame: LineBlame;
  readonly fileUri: vscode.Uri;
  readonly lineNumber: number;
  readonly repository: GitRepository;
}

export class CurrentLineBlame implements vscode.Disposable {
  private currentLineContext: CurrentLineContext | undefined;
  private decoratedEditor: vscode.TextEditor | undefined;
  private readonly lineAnnotationDecoration = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor("editorCodeLens.foreground"),
      fontStyle: "italic",
      margin: "0 0 0 2rem",
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });
  private refreshGeneration = 0;
  private scheduledRefresh: ReturnType<typeof setTimeout> | undefined;
  private readonly statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    90,
  );
  private readonly subscriptions: readonly vscode.Disposable[];

  public constructor(
    private readonly gitApi: GitApi,
    private readonly workspaceRepositories: WorkspaceRepositories,
    private readonly diagnostics: vscode.LogOutputChannel,
  ) {
    this.statusBarItem.name = "Git'o Line Blame";
    this.statusBarItem.command = "gito.showCurrentLineBlame";
    this.subscriptions = [
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleRefresh(0)),
      vscode.window.onDidChangeTextEditorSelection(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeTextDocument((textDocumentChange) => {
        if (textDocumentChange.document === vscode.window.activeTextEditor?.document) {
          this.scheduleRefresh();
        }
      }),
      vscode.workspace.onDidSaveTextDocument(() => this.scheduleRefresh(0)),
      vscode.workspace.onDidChangeConfiguration((configurationChange) => {
        if (configurationChange.affectsConfiguration("gito.blame")) {
          this.scheduleRefresh(0);
        }
      }),
    ];
    this.scheduleRefresh(0);
  }

  public dispose(): void {
    if (this.scheduledRefresh !== undefined) clearTimeout(this.scheduledRefresh);
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.statusBarItem.dispose();
    this.lineAnnotationDecoration.dispose();
  }

  public async toggleInlineAnnotation(): Promise<void> {
    const blameConfiguration = vscode.workspace.getConfiguration("gito.blame");
    const inlineAnnotationEnabled = blameConfiguration.get("inlineEnabled", true);
    await blameConfiguration.update(
      "inlineEnabled",
      !inlineAnnotationEnabled,
      vscode.ConfigurationTarget.Workspace,
    );
  }

  public async showDetails(): Promise<void> {
    const currentLineContext = this.currentLineContext;
    if (currentLineContext === undefined) return;
    const blameActions = currentLineContext.blame.commitHash === undefined
      ? [{ label: "$(history) Show File History", commandKind: "history" as const }]
      : [
          { label: "$(git-commit) Open Commit", commandKind: "commit" as const },
          { label: "$(history) Show File History", commandKind: "history" as const },
          { label: "$(copy) Copy Commit Hash", commandKind: "copy" as const },
        ];
    const selectedBlameAction = await vscode.window.showQuickPick(blameActions, {
      placeHolder: `${currentLineContext.blame.authorName} · ${currentLineContext.blame.summary}`,
      title: `Git'o: Line ${currentLineContext.lineNumber}`,
    });
    if (
      selectedBlameAction?.commandKind === "commit" &&
      currentLineContext.blame.commitHash !== undefined
    ) {
      await vscode.commands.executeCommand(
        "git.viewCommit",
        currentLineContext.repository.rootUri,
        currentLineContext.blame.commitHash,
      );
    } else if (selectedBlameAction?.commandKind === "history") {
      await vscode.commands.executeCommand("gito.showFileHistory", currentLineContext.fileUri);
    } else if (
      selectedBlameAction?.commandKind === "copy" &&
      currentLineContext.blame.commitHash !== undefined
    ) {
      await vscode.env.clipboard.writeText(currentLineContext.blame.commitHash);
    }
  }

  private scheduleRefresh(delayMilliseconds = 160): void {
    this.refreshGeneration += 1;
    if (this.scheduledRefresh !== undefined) clearTimeout(this.scheduledRefresh);
    this.scheduledRefresh = setTimeout(() => {
      this.scheduledRefresh = undefined;
      void this.refresh(this.refreshGeneration);
    }, delayMilliseconds);
  }

  private async refresh(refreshGeneration: number): Promise<void> {
    if (!vscode.workspace.getConfiguration("gito.blame").get("enabled", true)) {
      this.hide();
      return;
    }
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor?.document.uri.scheme !== "file") {
      this.hide();
      return;
    }
    const repository = this.workspaceRepositories.findRepositoryContaining(
      activeEditor.document.uri.fsPath,
    );
    if (repository === undefined) {
      this.hide();
      return;
    }
    const lineNumber = activeEditor.selection.active.line + 1;
    const filePath = relative(repository.rootUri.fsPath, activeEditor.document.uri.fsPath);
    try {
      const blamePorcelain = await runGitCommand(
        {
          environment: this.gitApi.git.env,
          executablePath: this.gitApi.git.path,
          repositoryPath: repository.rootUri.fsPath,
        },
        ["blame", "--line-porcelain", `-L${lineNumber},${lineNumber}`, "--", filePath],
        5_000,
      );
      if (refreshGeneration !== this.refreshGeneration) return;
      const lineBlame = parseLineBlame(blamePorcelain);
      if (lineBlame === undefined) {
        this.hide();
        return;
      }
      this.currentLineContext = {
        blame: lineBlame,
        fileUri: activeEditor.document.uri,
        lineNumber,
        repository,
      };
      const blameAge = lineBlame.authoredAt === undefined ? "local" : formatBlameAge(lineBlame.authoredAt);
      this.statusBarItem.text = `$(git-commit) ${lineBlame.authorName} · ${blameAge}`;
      this.statusBarItem.tooltip = new vscode.MarkdownString(
        `**${lineBlame.summary}**\n\n${lineBlame.authorName}${lineBlame.authoredAt === undefined ? "" : ` · ${lineBlame.authoredAt.toLocaleString()}`}\n\n${lineBlame.commitHash?.slice(0, 8) ?? "Uncommitted"}`,
      );
      this.statusBarItem.show();
      this.showInlineAnnotation(activeEditor, lineNumber, lineBlame, blameAge);
    } catch (blameFailure) {
      if (refreshGeneration === this.refreshGeneration) this.hide();
      this.diagnostics.debug("Current-line blame unavailable.", blameFailure);
    }
  }

  private hide(): void {
    this.currentLineContext = undefined;
    this.statusBarItem.hide();
    this.clearInlineAnnotation();
  }

  private showInlineAnnotation(
    activeEditor: vscode.TextEditor,
    lineNumber: number,
    lineBlame: LineBlame,
    blameAge: string,
  ): void {
    this.clearInlineAnnotation();
    if (!vscode.workspace.getConfiguration("gito.blame").get("inlineEnabled", true)) return;
    const lineText = activeEditor.document.lineAt(lineNumber - 1);
    activeEditor.setDecorations(this.lineAnnotationDecoration, [{
      range: new vscode.Range(lineText.range.end, lineText.range.end),
      renderOptions: {
        after: { contentText: formatLineBlameAnnotation(lineBlame, blameAge) },
      },
    }]);
    this.decoratedEditor = activeEditor;
  }

  private clearInlineAnnotation(): void {
    this.decoratedEditor?.setDecorations(this.lineAnnotationDecoration, []);
    this.decoratedEditor = undefined;
  }
}
