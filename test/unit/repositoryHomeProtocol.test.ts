import { describe, expect, it } from "vitest";
import {
  extensionToWebviewMessageSchema,
  gitoProtocolVersion,
  webviewToExtensionMessageSchema,
} from "../../src/protocol/repositoryHomeProtocol.js";

describe("repository Home protocol", () => {
  it("accepts the versioned ready message", () => {
    expect(
      webviewToExtensionMessageSchema.parse({
        protocolVersion: gitoProtocolVersion,
        messageType: "ready",
      }),
    ).toEqual({
      protocolVersion: 1,
      messageType: "ready",
    });
  });

  it("rejects excess fields", () => {
    expect(() =>
      webviewToExtensionMessageSchema.parse({
        protocolVersion: 1,
        messageType: "ready",
        accessToken: "forbidden",
      }),
    ).toThrow();
  });

  it("rejects access tokens from every webview action", () => {
    expect(() =>
      webviewToExtensionMessageSchema.parse({
        protocolVersion: 1,
        messageType: "connectProvider",
        providerId: "github",
        accessToken: "forbidden",
      }),
    ).toThrow();
  });

  it("preserves stale cloud dashboard metadata in the versioned snapshot", () => {
    expect(
      extensionToWebviewMessageSchema.parse({
        protocolVersion: gitoProtocolVersion,
        messageType: "repositoryHomeChanged",
        repositoryHomeSnapshot: {
          requestGeneration: 7,
          repositories: [
            {
              repositoryRoot: "/workspace/gito",
              repositoryDisplayName: "gito",
            },
          ],
          selectedRepository: {
            repositoryRoot: "/workspace/gito",
            repositoryDisplayName: "gito",
            repositoryHealth: {
              branchName: "main",
              uncommittedChangeCount: 0,
              aheadCount: 0,
              behindCount: 0,
            },
            commitActivity: {
              days: [],
              totalCommitCount: 0,
              safetyCapReached: false,
            },
            cloudDashboards: [
              {
                providerId: "github",
                providerDisplayName: "GitHub",
                connectionState: "connected",
                accountDisplayName: "Octocat",
                pullRequests: [],
                fetchedAt: "2030-01-01T00:00:00.000Z",
                cacheStatus: "stale",
                staleReason: "rateLimit",
              },
            ],
          },
          providerFilter: "all",
          loadingSections: [],
          sectionErrors: [],
        },
      }),
    ).toMatchObject({
      repositoryHomeSnapshot: {
        selectedRepository: {
          cloudDashboards: [{ cacheStatus: "stale", staleReason: "rateLimit" }],
        },
      },
    });
  });

  it("accepts a truthful commit-activity output truncation state", () => {
    const parsedMessage = extensionToWebviewMessageSchema.parse({
      protocolVersion: gitoProtocolVersion,
      messageType: "repositoryHomeChanged",
      repositoryHomeSnapshot: {
        requestGeneration: 1,
        repositories: [],
        selectedRepository: {
          repositoryRoot: "/workspace/gito",
          repositoryDisplayName: "gito",
          repositoryHealth: {
            branchName: "main",
            uncommittedChangeCount: 0,
            aheadCount: 0,
            behindCount: 0,
          },
          commitActivity: {
            days: [],
            totalCommitCount: 12,
            safetyCapReached: false,
            outputTruncated: true,
          },
          cloudDashboards: [],
        },
        providerFilter: "all",
        loadingSections: [],
        sectionErrors: [],
      },
    });

    expect(parsedMessage).toMatchObject({
      repositoryHomeSnapshot: {
        selectedRepository: {
          commitActivity: { outputTruncated: true, safetyCapReached: false },
        },
      },
    });
  });

  it("rejects excess fields on loaded detail payloads", () => {
    expect(() =>
      extensionToWebviewMessageSchema.parse({
        protocolVersion: 1,
        messageType: "pullRequestDetailsLoaded",
        requestGeneration: 1,
        pullRequestIdentity: {
          providerId: "github",
          repositoryOwner: "octocat",
          repositoryName: "Hello-World",
          pullRequestNumber: 7,
        },
        pullRequestDetails: {
          providerId: "github",
          repositoryOwner: "octocat",
          repositoryName: "Hello-World",
          pullRequestNumber: 7,
          title: "Details",
          authorDisplayName: "Octocat",
          updatedAt: "2030-01-01T00:00:00.000Z",
          commentCount: 0,
          isAuthoredByCurrentUser: false,
          reviewRequestedFromCurrentUser: false,
          isDraft: false,
          state: "ready",
          completedReviewCount: 0,
          requiredReviewCount: 0,
          bodyText: "",
          sourceBranchName: "feature/details",
          targetBranchName: "main",
          canonicalUrl: "https://github.com/octocat/Hello-World/pull/7",
          accessToken: "forbidden",
        },
      }),
    ).toThrow();
  });

  it("preserves a typed pull-request focus target", () => {
    expect(
      extensionToWebviewMessageSchema.parse({
        protocolVersion: gitoProtocolVersion,
        messageType: "repositoryHomeChanged",
        focusTarget: "pullRequests",
        repositoryHomeSnapshot: {
          requestGeneration: 0,
          repositories: [],
          selectedRepository: null,
          providerFilter: "all",
          loadingSections: [],
          sectionErrors: [],
        },
      }),
    ).toMatchObject({ focusTarget: "pullRequests" });
  });
});
