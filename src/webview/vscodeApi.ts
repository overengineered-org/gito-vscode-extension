interface VsCodeWebviewApi<State> {
  postMessage(message: unknown): void;
  getState(): State | undefined;
  setState(state: State): void;
}

declare function acquireVsCodeApi<State = unknown>(): VsCodeWebviewApi<State>;

export const vscodeWebviewApi = acquireVsCodeApi();
