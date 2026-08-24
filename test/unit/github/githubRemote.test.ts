import { describe, expect, it } from "vitest";
import { parseGitHubRemote } from "../../../src/extension/providers/github/githubRemote.js";

describe("GitHub remote parsing", () => {
  it.each([
    "https://github.com/octocat/Hello-World.git",
    "https://GITHUB.com/octocat/Hello-World",
    "git@github.com:octocat/Hello-World.git",
    "ssh://git@github.com/octocat/Hello-World.git",
    "ssh://git@github.com:22/octocat/Hello-World.git",
    "git+ssh://git@github.com/octocat/Hello-World.git",
  ])("detects supported remote %s", (remoteUrl) => {
    expect(parseGitHubRemote(remoteUrl)).toEqual({
      providerId: "github",
      owner: "octocat",
      repositoryName: "Hello-World",
    });
  });

  it.each([
    "http://github.com/octocat/Hello-World.git",
    "https://github.example.com/octocat/Hello-World.git",
    "https://github.com.evil.example/octocat/Hello-World.git",
    "git@gitlab.com:octocat/Hello-World.git",
    "https://github.com/octocat/Hello-World/tree/main",
    "https://github.com/octocat/Hello-World?token=secret",
    "https://github.com/octocat/Hello-World#fragment",
    "ssh://git:secret@github.com/octocat/Hello-World.git",
    "ssh://git@github.com/octocat/Hello-World.git?token=secret",
  ])("rejects unsupported or non-repository remote %s", (remoteUrl) => {
    expect(parseGitHubRemote(remoteUrl)).toBeUndefined();
  });

  it("uses the first supported remote when the provider adapter scans remotes", () => {
    expect(parseGitHubRemote("not a remote")).toBeUndefined();
  });
});
