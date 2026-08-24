import type { ComponentChildren, Ref } from "preact";

import type {
  GraphCommitRowMessage,
  GraphRowMessage,
} from "../../protocol/graphExperienceProtocol.js";
import { formatGraphDate, formatShortSha } from "./graphVirtualizer.js";

interface GraphRowProps {
  readonly row: GraphRowMessage;
  readonly totalRows: number;
  readonly isSelected: boolean;
  readonly rowRef: Ref<HTMLDivElement>;
  readonly onSelect: (row: GraphRowMessage) => void;
  readonly onKeyDown: (event: KeyboardEvent, row: GraphRowMessage) => void;
}

const unavailableCommitSubjectLabel = "Commit subject unavailable";

export function getCommitSubjectLabel(subject: string | undefined): string {
  const trimmedSubject = subject?.trim();
  return trimmedSubject === undefined || trimmedSubject.length === 0
    ? unavailableCommitSubjectLabel
    : trimmedSubject;
}

function displayReferenceName(referenceName: string): string {
  return referenceName.replace(/^refs\/(heads|remotes|tags)\//u, "");
}

export function getGraphRowAccessibleLabel(row: GraphRowMessage): string {
  if (row.kind === "commit") {
    const authorName = row.authorName?.trim() || "Unknown author";
    const references =
      row.references.length === 0
        ? "No references"
        : `References ${row.references.map((reference) => reference.name).join(", ")}`;
    return `${getCommitSubjectLabel(row.subject)}, commit ${formatShortSha(row.commitSha)}, author ${authorName}, committed ${formatGraphDate(row.commitDate ?? row.authorDate)}, ${references}`;
  }
  if (row.kind === "wip")
    return `Working tree, ${row.label}, ${row.stagedChangeCount} staged, ${row.unstagedChangeCount} modified, ${row.untrackedChangeCount} untracked`;
  const worktreeStatus = [
    row.worktree.isPrimary === true ? "primary" : "additional",
    row.worktree.isLocked === true ? "locked" : undefined,
    row.worktree.isPrunable === true ? "prunable" : undefined,
  ]
    .filter((statusLabel): statusLabel is string => statusLabel !== undefined)
    .join(", ");
  return `Worktree ${row.worktree.path}, ${worktreeStatus} worktree, ${row.worktree.branchRefName ?? "detached"}`;
}

export function getGraphRowDomId(rowIndex: number): string {
  return `gito-graph-row-${rowIndex}`;
}

function ReferenceBadge({
  referenceName,
  kind,
  isHead,
}: {
  readonly referenceName: string;
  readonly kind?: "head" | "local" | "remote" | "tag" | "stash";
  readonly isHead?: boolean;
}) {
  const semanticKind = isHead === true ? "head" : (kind ?? "local");
  const referenceNameWithoutPrefix = displayReferenceName(referenceName);
  const referenceKindLabel =
    semanticKind === "head"
      ? "current branch"
      : semanticKind === "local"
        ? "branch"
        : semanticKind === "remote"
          ? "remote"
          : semanticKind === "tag"
            ? "tag"
            : "stash";
  const referenceIconName =
    semanticKind === "tag"
      ? "tag"
      : semanticKind === "stash"
        ? "archive"
        : semanticKind === "remote"
          ? "cloud"
          : "git-branch";
  return (
    <span
      aria-label={`${referenceKindLabel}: ${referenceNameWithoutPrefix}`}
      class={`graph-reference-badge graph-reference-${semanticKind}`}
      title={referenceName}
    >
      <span aria-hidden="true" class={`codicon codicon-${referenceIconName}`} />
      <span>{semanticKind === "head" ? "HEAD" : referenceKindLabel}</span>
      <span>{referenceNameWithoutPrefix}</span>
    </span>
  );
}

function GraphLaneDiagram({ row }: { readonly row: GraphRowMessage }) {
  const lanes = row.lanes;
  const nextLanes = row.kind === "commit" ? row.nextLanes : lanes;
  const edges = row.kind === "commit" ? row.edges : [];
  const continuationSourceColumns = new Set(
    edges
      .filter((edge) => edge.kind === "continuation")
      .map((edge) => edge.fromColumn),
  );
  const commitLane =
    row.kind === "commit"
      ? row.lanes.find((lane) => lane.expectedCommitSha === row.commitSha)
      : undefined;
  const laneCount = Math.max(
    1,
    ...lanes.map((lane) => lane.column + 1),
    ...nextLanes.map((lane) => lane.column + 1),
  );
  const laneWidth = Math.min(196, Math.max(28, laneCount * 18));
  const centerX = (column: number): number => column * 18 + 14;
  return (
    <svg
      aria-hidden="true"
      class="graph-lane-diagram"
      height="48"
      viewBox={`0 0 ${laneWidth} 48`}
      width={laneWidth}
    >
      {lanes.map((lane) => (
        <line
          class={`graph-lane-line graph-lane-color-${lane.colorIndex % 12}`}
          key={`lane-${lane.column}`}
          x1={centerX(lane.column)}
          x2={centerX(lane.column)}
          y1="0"
          y2={continuationSourceColumns.has(lane.column) ? "0" : "48"}
        />
      ))}
      {edges.map((edge) => (
        <path
          class={`graph-lane-edge${edge.kind === "continuation" ? " graph-lane-edge-continuation" : ""} graph-lane-color-${edge.colorIndex % 12}`}
          d={
            edge.kind === "continuation"
              ? `M ${centerX(edge.fromColumn)} 0 C ${centerX(edge.fromColumn)} 14, ${centerX(edge.toColumn)} 34, ${centerX(edge.toColumn)} 48`
              : `M ${centerX(edge.fromColumn)} 22 C ${centerX(edge.fromColumn)} 32, ${centerX(edge.toColumn)} 32, ${centerX(edge.toColumn)} 48`
          }
          key={`${edge.kind}-${edge.parentSha}-${edge.fromColumn}-${edge.toColumn}`}
        />
      ))}
      {row.kind === "commit" ? (
        <circle
          class={`graph-commit-node graph-lane-color-${commitLane?.colorIndex ?? 0}`}
          cx={centerX(commitLane?.column ?? 0)}
          cy="22"
          r="5"
        />
      ) : null}
    </svg>
  );
}

function CommitRowContent({ row }: { readonly row: GraphCommitRowMessage }) {
  const subject = getCommitSubjectLabel(row.subject);
  const author = row.authorName?.trim() || "Unknown author";
  return (
    <>
      <div class="graph-row-primary-line">
        <code class="graph-commit-sha">{formatShortSha(row.commitSha)}</code>
        <span class="graph-commit-subject" title={subject}>
          {subject}
        </span>
      </div>
      <div class="graph-row-secondary-line">
        <span>{author}</span>
        <span aria-hidden="true" class="graph-secondary-separator">
          ·
        </span>
        <time dateTime={row.commitDate ?? row.authorDate}>
          {formatGraphDate(row.commitDate ?? row.authorDate)}
        </time>
      </div>
      {row.references.length > 0 ? (
        <div class="graph-reference-list" aria-label="References">
          {row.references.slice(0, 6).map((reference) => (
            <ReferenceBadge
              key={reference.name}
              referenceName={reference.name}
              {...(reference.kind === undefined
                ? {}
                : { kind: reference.kind })}
              {...(reference.isHead === undefined
                ? {}
                : { isHead: reference.isHead })}
            />
          ))}
          {row.references.length > 6 ? (
            <span class="graph-reference-overflow">
              +{row.references.length - 6}
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function WipRowContent({
  row,
}: {
  readonly row: Extract<GraphRowMessage, { kind: "wip" }>;
}) {
  return (
    <>
      <div class="graph-row-primary-line">
        <span
          aria-hidden="true"
          class="graph-status-symbol codicon codicon-edit"
        />
        <span>{row.label}</span>
        <span class="graph-live-label">Working tree</span>
      </div>
      <div class="graph-row-secondary-line">
        <span>{row.stagedChangeCount} staged</span>
        <span>{row.unstagedChangeCount} modified</span>
        <span>{row.untrackedChangeCount} untracked</span>
      </div>
    </>
  );
}

function WorktreeRowContent({
  row,
}: {
  readonly row: Extract<GraphRowMessage, { kind: "worktree" }>;
}) {
  const pathSegments = row.worktree.path.split(/[\\/]/u);
  const directoryName = pathSegments.at(-1) || row.worktree.path;
  return (
    <>
      <div class="graph-row-primary-line">
        <span
          aria-hidden="true"
          class="graph-status-symbol codicon codicon-repo"
        />
        <span>Worktree {directoryName}</span>
        {row.worktree.isPrimary === true ? (
          <span class="graph-live-label">Primary</span>
        ) : null}
      </div>
      <div class="graph-row-secondary-line" title={row.worktree.path}>
        <span>{row.worktree.branchRefName ?? "Detached worktree"}</span>
        {row.worktree.isLocked === true ? <span>Locked</span> : null}
        {row.worktree.isPrunable === true ? <span>Prunable</span> : null}
      </div>
    </>
  );
}

export function GraphRow({
  row,
  totalRows,
  isSelected,
  rowRef,
  onSelect,
  onKeyDown,
}: GraphRowProps) {
  let rowContent: ComponentChildren;
  if (row.kind === "commit") rowContent = <CommitRowContent row={row} />;
  else if (row.kind === "wip") rowContent = <WipRowContent row={row} />;
  else rowContent = <WorktreeRowContent row={row} />;
  const rowLabel = getGraphRowAccessibleLabel(row);
  return (
    <div
      aria-label={rowLabel}
      aria-level={1}
      aria-posinset={row.rowIndex + 1}
      aria-rowindex={row.rowIndex + 2}
      aria-setsize={totalRows}
      aria-selected={isSelected}
      class={`graph-row graph-row-${row.kind}${isSelected ? " is-selected" : ""}`}
      data-row-index={row.rowIndex}
      id={getGraphRowDomId(row.rowIndex)}
      onClick={() => onSelect(row)}
      onFocus={() => onSelect(row)}
      onKeyDown={(event) => onKeyDown(event, row)}
      ref={rowRef}
      role="row"
      tabIndex={-1}
    >
      <div class="graph-lane-cell" role="gridcell">
        <GraphLaneDiagram row={row} />
      </div>
      <div class="graph-commit-cell" role="gridcell">
        {rowContent}
      </div>
      <div class="graph-row-action-cell" role="gridcell">
        <span aria-hidden="true" class="codicon codicon-chevron-right" />
      </div>
    </div>
  );
}

export type { GraphRowProps, GraphCommitRowMessage };
