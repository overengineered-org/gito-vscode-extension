import { h } from "preact";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/preact";

import {
  getGraphRowAccessibleLabel,
  GraphRow,
} from "../../../src/webview/graph/GraphRow.js";
import type { GraphCommitRowMessage } from "../../../src/protocol/graphExperienceProtocol.js";

const commitRow: GraphCommitRowMessage = {
  kind: "commit",
  rowIndex: 3,
  commitSha: "commit",
  parents: ["parent"],
  lanes: [
    { column: 0, expectedCommitSha: "other", colorIndex: 1 },
    { column: 1, expectedCommitSha: "commit", colorIndex: 7 },
  ],
  nextLanes: [{ column: 0, expectedCommitSha: "parent", colorIndex: 3 }],
  edges: [
    {
      parentSha: "parent",
      fromColumn: 1,
      toColumn: 0,
      colorIndex: 3,
      kind: "first-parent",
    },
  ],
  references: [],
  subject: "Lane identity",
};

describe("GraphRow", () => {
  afterEach(() => cleanup());

  it("renders the commit node on the lane matching its SHA", () => {
    const { container } = render(
      h(GraphRow, {
        row: commitRow,
        totalRows: 4,
        isSelected: false,
        rowRef: () => undefined,
        onSelect: () => undefined,
        onKeyDown: () => undefined,
      }),
    );
    const node =
      container.querySelector<SVGCircleElement>(".graph-commit-node");
    expect(node?.getAttribute("cx")).toBe("32");
    expect(node?.classList.contains("graph-lane-color-7")).toBe(true);
  });

  it("renders continuation edges as shifted lane curves", () => {
    const { container } = render(
      h(GraphRow, {
        row: {
          ...commitRow,
          lanes: [
            { column: 0, expectedCommitSha: "x", colorIndex: 1 },
            { column: 1, expectedCommitSha: "commit", colorIndex: 7 },
            { column: 2, expectedCommitSha: "y", colorIndex: 5 },
          ],
          nextLanes: [
            { column: 0, expectedCommitSha: "x", colorIndex: 1 },
            { column: 1, expectedCommitSha: "y", colorIndex: 5 },
            { column: 2, expectedCommitSha: "parent", colorIndex: 3 },
          ],
          edges: [
            ...commitRow.edges,
            {
              parentSha: "y",
              fromColumn: 2,
              toColumn: 1,
              colorIndex: 5,
              kind: "continuation",
            },
          ],
        },
        totalRows: 4,
        isSelected: false,
        rowRef: () => undefined,
        onSelect: () => undefined,
        onKeyDown: () => undefined,
      }),
    );
    const continuationPath = container.querySelector<SVGPathElement>(
      ".graph-lane-edge-continuation",
    );
    expect(continuationPath?.getAttribute("d")).toMatch(/^M 50 0 C/u);
    expect(
      container.querySelectorAll("line.graph-lane-line")[2]?.getAttribute("y2"),
    ).toBe("0");
  });

  it("includes commit context in the tree row accessible name", () => {
    expect(
      getGraphRowAccessibleLabel({
        ...commitRow,
        authorName: "Maintainer",
        commitDate: "2026-08-23T10:00:00Z",
        references: [
          {
            name: "refs/heads/main",
            targetSha: "commit",
            kind: "local",
          },
        ],
      }),
    ).toMatch(/Lane identity, commit commit, author Maintainer, committed/u);
    expect(
      getGraphRowAccessibleLabel({
        kind: "wip",
        rowIndex: 0,
        label: "Changes",
        stagedChangeCount: 1,
        unstagedChangeCount: 2,
        untrackedChangeCount: 3,
        lanes: [],
      }),
    ).toContain("Working tree");
  });
});
