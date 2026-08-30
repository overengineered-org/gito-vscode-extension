const pullRequestTitle = process.env.PULL_REQUEST_TITLE ?? "";
const conventionalTitle =
  /^(feat|fix|perf|refactor|docs|test|build|ci|chore)(\([a-z0-9-]+\))?!?: .+/;

if (!conventionalTitle.test(pullRequestTitle)) {
  throw new Error(`PR title must use Conventional Commits: ${pullRequestTitle}`);
}

console.log(`Valid Conventional Commit title: ${pullRequestTitle}`);
