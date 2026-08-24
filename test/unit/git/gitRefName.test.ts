import { describe, expect, it } from "vitest";
import { getGitBranchNameValidationMessage } from "../../../src/extension/git/gitRefName.js";

describe("Git branch name validation", () => {
  it.each([
    "",
    "HEAD",
    "@",
    "-main",
    "main//topic",
    "main..topic",
    "main.lock",
    "main/topic.lock/child",
    "main.",
    "main/.private",
    "main space",
    "main~topic",
    "main@{topic",
  ])("rejects %j", (branchName) => {
    expect(getGitBranchNameValidationMessage(branchName)).toBeTypeOf("string");
  });

  it.each(["main", "feature/topic", "foo./bar", "foo/-bar", "foo.locked"])(
    "accepts %j",
    (branchName) => {
      expect(getGitBranchNameValidationMessage(branchName)).toBeUndefined();
    },
  );
});
