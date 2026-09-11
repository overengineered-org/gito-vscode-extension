export function gitViewCommitRequiresHistoryItem(vscodeVersion: string): boolean {
  const versionMatch = /^(\d+)\.(\d+)/u.exec(vscodeVersion);
  if (versionMatch === null) {
    throw new Error(`Unsupported VS Code version: ${vscodeVersion}`);
  }

  const majorVersion = Number(versionMatch[1]);
  const minorVersion = Number(versionMatch[2]);
  return majorVersion === 1 && minorVersion < 97;
}
