import { z } from "zod";

import { gitoProtocolVersion } from "./repositoryHomeProtocol.js";

export { gitoProtocolVersion };

export const graphScopeSchema = z.enum([
  "all",
  "current",
  "local",
  "remote",
  "tags",
  "stashes",
  "worktrees",
]);

export const graphFilterSchema = z
  .object({
    scope: graphScopeSchema.optional(),
    text: z.string().max(240).optional(),
    authorEmail: z.string().max(320).optional(),
    authorName: z.string().max(240).optional(),
    commitShas: z.array(z.string().min(1).max(64)).max(500).optional(),
    referenceNames: z.array(z.string().min(1).max(512)).max(500).optional(),
    since: z.string().max(80).optional(),
    until: z.string().max(80).optional(),
  })
  .strict();

const graphLaneSchema = z
  .object({
    column: z.number().int().nonnegative(),
    expectedCommitSha: z.string().min(1),
    colorIndex: z.number().int().nonnegative(),
  })
  .strict();

const graphLaneEdgeSchema = z
  .object({
    parentSha: z.string().min(1),
    fromColumn: z.number().int().nonnegative(),
    toColumn: z.number().int().nonnegative(),
    colorIndex: z.number().int().nonnegative(),
    kind: z.enum(["first-parent", "merge-parent", "continuation"]),
  })
  .strict();

const graphReferenceSchema = z
  .object({
    name: z.string().min(1),
    targetSha: z.string().min(1),
    kind: z.enum(["head", "local", "remote", "tag", "stash"]).optional(),
    isHead: z.boolean().optional(),
    upstreamRefName: z.string().min(1).optional(),
  })
  .strict();

const graphWorktreeSchema = z
  .object({
    path: z.string().min(1),
    headSha: z.string().min(1),
    branchRefName: z.string().min(1).optional(),
    isPrimary: z.boolean().optional(),
    isLocked: z.boolean().optional(),
    isPrunable: z.boolean().optional(),
  })
  .strict();

const graphCommitRowSchema = z
  .object({
    kind: z.literal("commit"),
    rowIndex: z.number().int().nonnegative(),
    commitSha: z.string().min(1),
    parents: z.array(z.string().min(1)),
    lanes: z.array(graphLaneSchema),
    nextLanes: z.array(graphLaneSchema),
    edges: z.array(graphLaneEdgeSchema),
    references: z.array(graphReferenceSchema),
    subject: z.string().optional(),
    authorName: z.string().optional(),
    authorEmail: z.string().optional(),
    authorDate: z.string().optional(),
    commitDate: z.string().optional(),
  })
  .strict();

const graphWipRowSchema = z
  .object({
    kind: z.literal("wip"),
    rowIndex: z.number().int().nonnegative(),
    label: z.string().min(1),
    stagedChangeCount: z.number().int().nonnegative(),
    unstagedChangeCount: z.number().int().nonnegative(),
    untrackedChangeCount: z.number().int().nonnegative(),
    lanes: z.array(graphLaneSchema),
  })
  .strict();

const graphWorktreeRowSchema = z
  .object({
    kind: z.literal("worktree"),
    rowIndex: z.number().int().nonnegative(),
    worktree: graphWorktreeSchema,
    anchorCommitSha: z.string().min(1).optional(),
    lanes: z.array(graphLaneSchema),
  })
  .strict();

export const graphRowSchema = z.discriminatedUnion("kind", [
  graphCommitRowSchema,
  graphWipRowSchema,
  graphWorktreeRowSchema,
]);

export const graphPageSchema = z
  .object({
    rows: z.array(graphRowSchema).max(2_000),
    nextCursor: z
      .object({
        snapshotKey: z.string().min(1),
        rowOffset: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    hasMore: z.boolean(),
    totalRows: z.number().int().nonnegative(),
    totalCommits: z.number().int().nonnegative(),
    truncated: z.boolean(),
    snapshotKey: z.string().min(1),
  })
  .strict();

export const graphMinimapBucketSchema = z
  .object({
    bucketIndex: z.number().int().nonnegative(),
    startRow: z.number().int().nonnegative(),
    endRow: z.number().int().nonnegative(),
    commitCount: z.number().int().nonnegative(),
    mergeCount: z.number().int().nonnegative(),
    referenceCount: z.number().int().nonnegative(),
    colorCounts: z.array(z.number().int().nonnegative()).max(32),
  })
  .strict();

export const graphChangedLineMetricsSchema = z
  .object({
    commitSha: z.string().min(1),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    changedFileCount: z.number().int().nonnegative(),
    binaryFileCount: z.number().int().nonnegative(),
    truncated: z.boolean().optional(),
  })
  .strict();

export const graphSummarySchema = z
  .object({
    repositoryRoot: z.string().min(1),
    repositoryDisplayName: z.string().min(1),
    currentBranchName: z.string().optional(),
    totalCommits: z.number().int().nonnegative(),
    totalReferences: z.number().int().nonnegative(),
    totalWorktrees: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export const graphActionSchema = z.enum([
  "openCommit",
  "openDiff",
  "compareWithParent",
  "checkoutReference",
  "showBranchStatus",
]);

export const graphOperationScopeSchema = z.enum([
  "summary",
  "query",
  "minimap",
  "metrics",
  "action",
]);

export const graphWebviewToExtensionMessageSchema = z.discriminatedUnion(
  "messageType",
  [
    z
      .object({
        protocolVersion: z.literal(gitoProtocolVersion),
        messageType: z.literal("graphReady"),
      })
      .strict(),
    z
      .object({
        protocolVersion: z.literal(gitoProtocolVersion),
        messageType: z.literal("graphQuery"),
        requestId: z.number().int().nonnegative(),
        cursor: z.string().min(1).optional(),
        pageSize: z.number().int().positive().max(500),
        append: z.boolean(),
        filter: graphFilterSchema,
        includeWip: z.boolean(),
        includeWorktrees: z.boolean(),
      })
      .strict(),
    z
      .object({
        protocolVersion: z.literal(gitoProtocolVersion),
        messageType: z.literal("graphMinimap"),
        requestId: z.number().int().nonnegative(),
        bucketCount: z.number().int().positive().max(240),
        filter: graphFilterSchema,
        includeWip: z.boolean(),
        includeWorktrees: z.boolean(),
      })
      .strict(),
    z
      .object({
        protocolVersion: z.literal(gitoProtocolVersion),
        messageType: z.literal("graphMetrics"),
        requestId: z.number().int().nonnegative(),
        commitSha: z.string().min(1).max(64),
      })
      .strict(),
    z
      .object({
        protocolVersion: z.literal(gitoProtocolVersion),
        messageType: z.literal("graphCancel"),
        requestId: z.number().int().nonnegative(),
      })
      .strict(),
    z
      .object({
        protocolVersion: z.literal(gitoProtocolVersion),
        messageType: z.literal("graphAction"),
        requestId: z.number().int().nonnegative(),
        action: graphActionSchema,
        commitSha: z.string().min(1).max(64).optional(),
        parentSha: z.string().min(1).max(64).optional(),
        referenceName: z.string().min(1).max(512).optional(),
      })
      .strict(),
  ],
);

export const graphExtensionToWebviewMessageSchema = z.discriminatedUnion(
  "messageType",
  [
    z
      .object({
        protocolVersion: z.literal(gitoProtocolVersion),
        messageType: z.literal("graphReady"),
        summary: graphSummarySchema,
      })
      .strict(),
    z
      .object({
        protocolVersion: z.literal(gitoProtocolVersion),
        messageType: z.literal("graphPageLoaded"),
        requestId: z.number().int().nonnegative(),
        append: z.boolean(),
        page: graphPageSchema,
      })
      .strict(),
    z
      .object({
        protocolVersion: z.literal(gitoProtocolVersion),
        messageType: z.literal("graphMinimapLoaded"),
        requestId: z.number().int().nonnegative(),
        buckets: z.array(graphMinimapBucketSchema).max(240),
      })
      .strict(),
    z
      .object({
        protocolVersion: z.literal(gitoProtocolVersion),
        messageType: z.literal("graphMetricsLoaded"),
        requestId: z.number().int().nonnegative(),
        metrics: graphChangedLineMetricsSchema.nullable(),
      })
      .strict(),
    z
      .object({
        protocolVersion: z.literal(gitoProtocolVersion),
        messageType: z.literal("graphActionCompleted"),
        requestId: z.number().int().nonnegative(),
        action: graphActionSchema,
        announcement: z.string().min(1),
      })
      .strict(),
    z
      .object({
        protocolVersion: z.literal(gitoProtocolVersion),
        messageType: z.literal("graphOperationFailed"),
        requestId: z.number().int().nonnegative().optional(),
        operation: graphOperationScopeSchema.optional(),
        userMessage: z.string().min(1),
      })
      .strict(),
  ],
);

export type GraphFilterMessage = z.infer<typeof graphFilterSchema>;
export type GraphCommitRowMessage = z.infer<typeof graphCommitRowSchema>;
export type GraphRowMessage = z.infer<typeof graphRowSchema>;
export type GraphPageMessage = z.infer<typeof graphPageSchema>;
export type GraphMinimapBucketMessage = z.infer<
  typeof graphMinimapBucketSchema
>;
export type GraphChangedLineMetricsMessage = z.infer<
  typeof graphChangedLineMetricsSchema
>;
export type GraphSummaryMessage = z.infer<typeof graphSummarySchema>;
export type GraphAction = z.infer<typeof graphActionSchema>;
export type GraphOperationScope = z.infer<typeof graphOperationScopeSchema>;
export type GraphWebviewToExtensionMessage = z.infer<
  typeof graphWebviewToExtensionMessageSchema
>;
export type GraphExtensionToWebviewMessage = z.infer<
  typeof graphExtensionToWebviewMessageSchema
>;
