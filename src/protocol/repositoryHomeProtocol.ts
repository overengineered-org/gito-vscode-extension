import { z } from "zod";

export const gitoProtocolVersion = 1 as const;
export const cloudProviderIdSchema = z.literal("github");
export const providerFilterSchema = z.enum(["all", "github"]);
export const repositoryHomeFocusTargetSchema = z.literal("pullRequests");

export type RepositoryHomeFocusTarget = z.infer<
  typeof repositoryHomeFocusTargetSchema
>;

const repositorySelectionSchema = z
  .object({
    repositoryRoot: z.string().min(1),
    repositoryDisplayName: z.string().min(1),
  })
  .strict();

const repositoryHealthSchema = z
  .object({
    branchName: z.string(),
    uncommittedChangeCount: z.number().int().nonnegative(),
    aheadCount: z.number().int().nonnegative(),
    behindCount: z.number().int().nonnegative(),
    lastSuccessfulFetchAt: z.string().datetime().optional(),
  })
  .strict();

const commitActivityDaySchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    commitCount: z.number().int().nonnegative(),
  })
  .strict();

export const pullRequestIdentitySchema = z
  .object({
    providerId: cloudProviderIdSchema,
    repositoryOwner: z.string().min(1),
    repositoryName: z.string().min(1),
    repositoryProject: z.string().min(1).optional(),
    pullRequestNumber: z.number().int().positive(),
  })
  .strict();

const pullRequestSummarySchema = pullRequestIdentitySchema
  .extend({
    title: z.string().min(1),
    authorDisplayName: z.string().min(1),
    updatedAt: z.string().datetime(),
    commentCount: z.number().int().nonnegative(),
    isAuthoredByCurrentUser: z.boolean(),
    reviewRequestedFromCurrentUser: z.boolean(),
    isDraft: z.boolean(),
    state: z.enum([
      "ready",
      "changesRequested",
      "checksRunning",
      "draft",
      "blocked",
    ]),
    completedReviewCount: z.number().int().nonnegative(),
    requiredReviewCount: z.number().int().nonnegative(),
  })
  .strict();

export const pullRequestDetailsSchema = pullRequestSummarySchema
  .extend({
    bodyText: z.string(),
    sourceBranchName: z.string().min(1),
    targetBranchName: z.string().min(1),
    canonicalUrl: z.string().url(),
  })
  .strict();

const cloudDashboardSchema = z
  .object({
    providerId: cloudProviderIdSchema,
    providerDisplayName: z.string().min(1),
    connectionState: z.enum([
      "disconnected",
      "connecting",
      "connected",
      "failed",
    ]),
    accountDisplayName: z.string().min(1).optional(),
    pullRequests: z.array(pullRequestSummarySchema),
    fetchedAt: z.string().datetime().optional(),
    cacheStatus: z.enum(["fresh", "stale"]).optional(),
    staleReason: z
      .enum([
        "rateLimit",
        "server",
        "network",
        "timeout",
        "rateLimited",
        "serverFailure",
        "networkFailure",
      ])
      .optional(),
  })
  .strict();

const selectedRepositorySnapshotSchema = repositorySelectionSchema
  .extend({
    repositoryHealth: repositoryHealthSchema,
    commitActivity: z
      .object({
        days: z.array(commitActivityDaySchema).max(371),
        totalCommitCount: z.number().int().nonnegative(),
        safetyCapReached: z.boolean(),
        outputTruncated: z.boolean().optional(),
      })
      .strict(),
    cloudDashboards: z.array(cloudDashboardSchema).max(2),
  })
  .strict();

export const repositoryHomeSnapshotSchema = z
  .object({
    requestGeneration: z.number().int().nonnegative(),
    repositories: z.array(repositorySelectionSchema),
    selectedRepository: selectedRepositorySnapshotSchema.nullable(),
    providerFilter: providerFilterSchema,
    loadingSections: z.array(
      z.enum(["localSummary", "commitActivity", "github"]),
    ),
    sectionErrors: z.array(
      z
        .object({
          section: z.enum(["localSummary", "commitActivity", "github"]),
          userMessage: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export const extensionToWebviewMessageSchema = z.discriminatedUnion(
  "messageType",
  [
    z
      .object({
        protocolVersion: z.literal(gitoProtocolVersion),
        messageType: z.literal("repositoryHomeChanged"),
        repositoryHomeSnapshot: repositoryHomeSnapshotSchema,
        focusTarget: repositoryHomeFocusTargetSchema.optional(),
      })
      .strict(),
    z
      .object({
        protocolVersion: z.literal(gitoProtocolVersion),
        messageType: z.literal("operationFailed"),
        operationName: z.enum([
          "ready",
          "refreshDashboard",
          "selectRepository",
          "setProviderFilter",
          "connectProvider",
          "disconnectProvider",
          "openPullRequestDetails",
          "checkoutPullRequest",
          "openExternalPullRequest",
          "repositoryHomeChanged",
        ]),
        userMessage: z.string().min(1),
      })
      .strict(),
    z
      .object({
        protocolVersion: z.literal(gitoProtocolVersion),
        messageType: z.literal("operationCompleted"),
        operationName: z.enum([
          "ready",
          "refreshDashboard",
          "selectRepository",
          "setProviderFilter",
          "connectProvider",
          "disconnectProvider",
          "openPullRequestDetails",
          "checkoutPullRequest",
          "openExternalPullRequest",
        ]),
        announcement: z.string().min(1),
      })
      .strict(),
    z
      .object({
        protocolVersion: z.literal(gitoProtocolVersion),
        messageType: z.literal("pullRequestDetailsLoaded"),
        requestGeneration: z.number().int().nonnegative(),
        pullRequestIdentity: pullRequestIdentitySchema,
        pullRequestDetails: pullRequestDetailsSchema,
      })
      .strict(),
  ],
);

export const webviewToExtensionMessageSchema = z.discriminatedUnion(
  "messageType",
  [
    z
      .object({
        protocolVersion: z.literal(gitoProtocolVersion),
        messageType: z.literal("ready"),
      })
      .strict(),
    z
      .object({
        protocolVersion: z.literal(gitoProtocolVersion),
        messageType: z.literal("refreshDashboard"),
      })
      .strict(),
    z
      .object({
        protocolVersion: z.literal(gitoProtocolVersion),
        messageType: z.literal("selectRepository"),
        repositoryRoot: z.string().min(1),
      })
      .strict(),
    z
      .object({
        protocolVersion: z.literal(gitoProtocolVersion),
        messageType: z.literal("setProviderFilter"),
        providerFilter: providerFilterSchema,
      })
      .strict(),
    z
      .object({
        protocolVersion: z.literal(gitoProtocolVersion),
        messageType: z.literal("connectProvider"),
        providerId: cloudProviderIdSchema,
      })
      .strict(),
    z
      .object({
        protocolVersion: z.literal(gitoProtocolVersion),
        messageType: z.literal("disconnectProvider"),
        providerId: cloudProviderIdSchema,
      })
      .strict(),
    z
      .object({
        protocolVersion: z.literal(gitoProtocolVersion),
        messageType: z.enum([
          "openPullRequestDetails",
          "checkoutPullRequest",
          "openExternalPullRequest",
        ]),
        pullRequestIdentity: pullRequestIdentitySchema,
      })
      .strict(),
  ],
);

export type RepositoryHomeSnapshot = z.infer<
  typeof repositoryHomeSnapshotSchema
>;
export type PullRequestIdentity = z.infer<typeof pullRequestIdentitySchema>;
export type PullRequestDetails = z.infer<typeof pullRequestDetailsSchema>;
export type ExtensionToWebviewMessage = z.infer<
  typeof extensionToWebviewMessageSchema
>;
export type WebviewToExtensionMessage = z.infer<
  typeof webviewToExtensionMessageSchema
>;
