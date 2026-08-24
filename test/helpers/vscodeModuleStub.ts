/**
 * Resolution target for Vitest. Individual tests replace this module with
 * stateful, behavior-specific VS Code fakes before importing production code.
 */
export const ProgressLocation = { Notification: 15 } as const;
export const QuickPickItemKind = { Separator: -1, Default: 0 } as const;
