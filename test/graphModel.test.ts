import assert from "node:assert/strict";
import test from "node:test";

import { buildCommitGraphRows } from "../src/graphModel.ts";
import { GitReferenceType } from "../src/gitModel.ts";

test("lays out linear history and attaches sorted references", () => {
  const graphRows = buildCommitGraphRows(
    [
      createCommit("aaaaaaaa", ["bbbbbbbb"], "Latest", "Alex"),
      createCommit("bbbbbbbb", [], "Initial", "Blair"),
    ],
    [
      { commit: "aaaaaaaa", name: "origin/main", type: GitReferenceType.remoteBranch },
      { commit: "aaaaaaaa", name: "origin/HEAD", type: GitReferenceType.remoteBranch },
      { commit: "aaaaaaaa", name: "main", type: GitReferenceType.localBranch },
      { commit: "bbbbbbbb", name: "v1.0.0", type: GitReferenceType.tag },
    ],
  );

  assert.deepEqual(
    graphRows.map((graphRow) => ({
      laneCount: graphRow.laneCount,
      nodeLane: graphRow.nodeLane,
      references: graphRow.referenceLabels,
      subject: graphRow.subject,
    })),
    [
      {
        laneCount: 1,
        nodeLane: 0,
        references: [
          { kind: "branch", name: "main" },
          { kind: "remote", name: "origin/main" },
        ],
        subject: "Latest",
      },
      {
        laneCount: 1,
        nodeLane: 0,
        references: [{ kind: "tag", name: "v1.0.0" }],
        subject: "Initial",
      },
    ],
  );
});

test("collapses dense histories without drawing false off-screen connections", () => {
  const parentHashes = Array.from({ length: 8 }, (_, parentIndex) => `parent-${parentIndex}`);
  const [mergeRow] = buildCommitGraphRows(
    [createCommit("merge", parentHashes, "Octopus merge", "Alex")],
    [],
  );

  assert.equal(mergeRow?.laneCount, 6);
  assert.equal(mergeRow?.hiddenLaneCount, 2);
  assert.equal(mergeRow?.connections.length, 6);
  assert.equal(
    mergeRow?.connections.every(
      (connection) => connection.fromLane < 6 && connection.toLane < 6,
    ),
    true,
  );
});

test("preserves merge lanes until their shared parent", () => {
  const graphRows = buildCommitGraphRows(
    [
      createCommit("merge", ["left", "right"], "Merge feature", "Alex"),
      createCommit("left", ["base"], "Main work", "Alex"),
      createCommit("right", ["base"], "Feature work", "Blair"),
      createCommit("base", [], "Base", "Casey"),
    ],
    [],
  );

  assert.equal(graphRows[0]?.parentCount, 2);
  assert.equal(graphRows[0]?.laneCount, 2);
  assert.deepEqual(
    graphRows[0]?.connections.filter((connection) => connection.startsAtNode),
    [
      { colorIndex: 0, fromLane: 0, startsAtNode: true, toLane: 0 },
      { colorIndex: 1, fromLane: 0, startsAtNode: true, toLane: 1 },
    ],
  );
  assert.equal(graphRows[2]?.nodeLane, 1);
  assert.equal(graphRows[3]?.nodeLane, 0);
});

function createCommit(
  hash: string,
  parents: readonly string[],
  message: string,
  authorName: string,
) {
  return { hash, parents, message, authorName };
}
