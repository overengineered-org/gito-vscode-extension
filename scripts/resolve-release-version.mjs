import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { Writable } from "node:stream";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import semanticRelease from "semantic-release";

const repositoryRoot = resolve(import.meta.dirname, "..");
const sourceRepositoryRoot = resolve(
  process.env.GITO_RELEASE_RESOLVER_REPOSITORY || repositoryRoot,
);
const releaseConfiguration = createRequire(import.meta.url)(
  resolve(repositoryRoot, "release.config.cjs"),
);
const semanticReleasePluginRoot = resolve(repositoryRoot, "node_modules");
const versionResolverPluginNames = new Set([
  "@semantic-release/commit-analyzer",
  "@semantic-release/release-notes-generator",
]);
const semanticReleasePlugins = releaseConfiguration.plugins
  .filter(([pluginName]) => versionResolverPluginNames.has(pluginName))
  .map(([pluginName, pluginOptions = {}]) => [
    resolve(semanticReleasePluginRoot, pluginName),
    pluginOptions,
  ]);
if (semanticReleasePlugins.length !== versionResolverPluginNames.size) {
  throw new Error(
    "Release version resolver requires commit-analyzer and release-notes-generator plugins.",
  );
}

function runGit(argumentsList, workingDirectory) {
  execFileSync("git", argumentsList, {
    cwd: workingDirectory,
    stdio: "ignore",
  });
}

function createSilentOutput() {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

async function resolveReleaseVersion() {
  const temporaryRepositoryRoot = await mkdtemp(
    join(tmpdir(), "gito-release-version-"),
  );
  const bareRepositoryPath = join(temporaryRepositoryRoot, "remote.git");
  const workingRepositoryPath = join(temporaryRepositoryRoot, "working");

  try {
    runGit(
      ["init", "--bare", "--initial-branch=main", bareRepositoryPath],
      sourceRepositoryRoot,
    );
    runGit(
      [
        "push",
        `file://${bareRepositoryPath}`,
        "HEAD:refs/heads/main",
        "--tags",
      ],
      sourceRepositoryRoot,
    );
    runGit(
      [
        "clone",
        "--branch",
        "main",
        `file://${bareRepositoryPath}`,
        workingRepositoryPath,
      ],
      sourceRepositoryRoot,
    );
    await cp(
      resolve(sourceRepositoryRoot, "package.json"),
      resolve(workingRepositoryPath, "package.json"),
    );

    const resolverEnvironment = { ...process.env };
    delete resolverEnvironment.GITHUB_ACTION;
    const releaseResult = await semanticRelease(
      {
        branches: releaseConfiguration.branches,
        tagFormat: releaseConfiguration.tagFormat,
        plugins: semanticReleasePlugins,
        repositoryUrl: `file://${bareRepositoryPath}`,
        dryRun: true,
        ci: false,
      },
      {
        cwd: workingRepositoryPath,
        env: resolverEnvironment,
        stdout: createSilentOutput(),
        stderr: createSilentOutput(),
      },
    );
    const releaseVersion = releaseResult?.nextRelease?.version ?? "";
    if (releaseVersion.length > 0) process.stdout.write(`${releaseVersion}\n`);
  } finally {
    await rm(temporaryRepositoryRoot, { recursive: true, force: true });
  }
}

await resolveReleaseVersion();
