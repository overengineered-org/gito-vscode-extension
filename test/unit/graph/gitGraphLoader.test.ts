import { describe, expect, it, vi } from "vitest";

import { GitCommitGraphLoader } from "../../../src/extension/graph/index.js";
import type { GitCommandRunner } from "../../../src/extension/git/gitCommandRunner.js";

describe("GitCommitGraphLoader bounds", () => {
  it("bounds Git metadata stdout and marks truncated command output", async () => {
    const requests: Parameters<GitCommandRunner["run"]>[0][] = [];
    const commandRunner: GitCommandRunner = {
      run: vi.fn((request: Parameters<GitCommandRunner["run"]>[0]) => {
        requests.push(request);
        if (request.arguments[0] === "log")
          return Promise.resolve({
            standardOutput: `sha\0\0${"x".repeat(20_000)}\0author\0email\0date\0date\x01`,
            standardError: "",
            exitCode: 0,
            standardOutputTruncated: true,
          });
        return Promise.resolve({
          standardOutput: "",
          standardError: "",
          exitCode: 0,
          standardOutputTruncated: false,
        });
      }),
      runStreaming: vi.fn(),
    };
    const snapshot = await new GitCommitGraphLoader(commandRunner).load(
      "/repo",
    );
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.commits[0]?.subject?.length).toBeLessThanOrEqual(4_096);
    expect(
      requests.filter(
        (request) => request.maxStandardOutputBytes !== undefined,
      ),
    ).toHaveLength(6);
  });
});
