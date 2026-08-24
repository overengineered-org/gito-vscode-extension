export const githubDashboardQuery = /* GraphQL */ `
  query GitHubRepositoryDashboard(
    $owner: String!
    $repository: String!
    $pullRequestCursor: String
  ) {
    viewer {
      id
      login
      name
    }
    rateLimit {
      limit
      remaining
      resetAt
      used
    }
    repository(owner: $owner, name: $repository) {
      pullRequests(
        first: 100
        after: $pullRequestCursor
        states: OPEN
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          number
          title
          updatedAt
          isDraft
          url
          author {
            login
            ... on User {
              name
            }
          }
          comments {
            totalCount
          }
          reviewDecision
          mergeable
          mergeStateStatus
          statusCheckRollup {
            state
          }
          reviewRequests(first: 100) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              requestedReviewer {
                ... on User {
                  login
                }
                ... on Team {
                  slug
                }
              }
            }
          }
          reviews(
            first: 100
            states: [APPROVED, CHANGES_REQUESTED, DISMISSED]
          ) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              author {
                login
              }
              state
              submittedAt
            }
          }
          headRefName
          baseRefName
        }
      }
    }
  }
`;

export const githubCurrentUserQuery = /* GraphQL */ `
  query GitHubCurrentUser {
    viewer {
      id
      login
      name
    }
    rateLimit {
      limit
      remaining
      resetAt
      used
    }
  }
`;

export const githubPullRequestDetailsQuery = /* GraphQL */ `
  query GitHubPullRequestDetails(
    $owner: String!
    $repository: String!
    $pullRequestNumber: Int!
  ) {
    viewer {
      id
      login
      name
    }
    rateLimit {
      limit
      remaining
      resetAt
      used
    }
    repository(owner: $owner, name: $repository) {
      pullRequest(number: $pullRequestNumber) {
        number
        title
        body
        updatedAt
        isDraft
        url
        author {
          login
          ... on User {
            name
          }
        }
        comments {
          totalCount
        }
        reviewDecision
        mergeable
        mergeStateStatus
        statusCheckRollup {
          state
        }
        reviewRequests(first: 100) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            requestedReviewer {
              ... on User {
                login
              }
              ... on Team {
                slug
              }
            }
          }
        }
        reviews(first: 100, states: [APPROVED, CHANGES_REQUESTED, DISMISSED]) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            author {
              login
            }
            state
            submittedAt
          }
        }
        headRefName
        baseRefName
      }
    }
  }
`;

export const githubPullRequestReviewPageQuery = /* GraphQL */ `
  query GitHubPullRequestReviewPage(
    $owner: String!
    $repository: String!
    $pullRequestNumber: Int!
    $reviewRequestsCursor: String
    $reviewsCursor: String
  ) {
    repository(owner: $owner, name: $repository) {
      pullRequest(number: $pullRequestNumber) {
        reviewRequests(first: 100, after: $reviewRequestsCursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            requestedReviewer {
              ... on User {
                login
              }
              ... on Team {
                slug
              }
            }
          }
        }
        reviews(
          first: 100
          after: $reviewsCursor
          states: [APPROVED, CHANGES_REQUESTED, DISMISSED]
        ) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            author {
              login
            }
            state
            submittedAt
          }
        }
      }
    }
  }
`;
