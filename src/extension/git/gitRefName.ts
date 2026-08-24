export function getGitBranchNameValidationMessage(
  branchName: string,
): string | undefined {
  if (branchName.length === 0) return "Enter a branch name.";
  if (branchName === "HEAD") return "HEAD is reserved by Git.";
  if (branchName !== branchName.trim()) {
    return "Branch names cannot start or end with whitespace.";
  }
  if (branchName === "@") return "A branch name cannot be @.";
  if (
    branchName.startsWith("/") ||
    branchName.endsWith("/") ||
    branchName.includes("//")
  ) {
    return "Branch names cannot start, end, or repeat a slash.";
  }
  if (branchName.includes("..")) return "Branch names cannot contain ..";
  if (branchName.includes("@{")) return "Branch names cannot contain @{";
  if (branchName.endsWith(".")) return "Branch names cannot end with a dot.";
  if (branchName.split("/").some((component) => component.endsWith(".lock"))) {
    return "Branch components cannot end with .lock.";
  }
  const containsAsciiControlOrSpace = [...branchName].some(
    (branchCharacter) => {
      const characterCode = branchCharacter.codePointAt(0) ?? 0;
      return characterCode <= 0x20 || characterCode === 0x7f;
    },
  );
  if (
    containsAsciiControlOrSpace ||
    ["~", "^", ":", "?", "*", "[", "]", "\\"].some((forbiddenCharacter) =>
      branchName.includes(forbiddenCharacter),
    )
  ) {
    return "Branch names contain an unsupported character.";
  }
  if (
    branchName
      .split("/")
      .some((branchComponent) => branchComponent.startsWith("."))
  ) {
    return "Branch components cannot start with a dot.";
  }
  if (branchName.startsWith("-"))
    return "Branch names cannot start with a hyphen.";
  return undefined;
}
