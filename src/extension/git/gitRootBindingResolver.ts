import {
  resolveGitRootBinding,
  validateGitExecutablePath,
  withGitRootBinding,
  type GitRootBindingIdentity,
  type GitRootBindingResolutionOptions,
} from "./gitCommandRunner.js";

/** Resolves the exact Git executable selected by the active Git provider. */
export type GitRootBindingExecutablePathResolver = () => Promise<
  string | undefined
>;

/** Root-binding options that cannot replace the configured executable. */
export type ConfiguredGitRootBindingOptions = Omit<
  GitRootBindingResolutionOptions,
  "gitExecutablePath"
>;

export type GitRootBindingResolveFunction = (
  repositoryRoot: string,
  expectedIdentity?: GitRootBindingIdentity,
  resolutionOptions?: GitRootBindingResolutionOptions,
) => Promise<GitRootBindingIdentity>;

export type GitRootBindingWithFunction = <T>(
  repositoryRoot: string,
  expectedIdentity: GitRootBindingIdentity | undefined,
  operation: () => Promise<T>,
  resolutionOptions?: GitRootBindingResolutionOptions,
) => Promise<T>;

export interface GitRootBindingResolverDependencies {
  /** Test seam for root discovery; production uses the command-runner helper. */
  readonly resolveRootBinding?: GitRootBindingResolveFunction;
  /** Test seam for the descriptor-bound operation scope. */
  readonly withRootBinding?: GitRootBindingWithFunction;
}

/**
 * Binds every root discovery to one validated executable selected at call time.
 *
 * The executable resolver is intentionally optional at construction so a
 * misconfigured composition fails closed when a Git operation is attempted.
 */
export class GitRootBindingResolver {
  private readonly resolveRootBinding: GitRootBindingResolveFunction;
  private readonly withRootBinding: GitRootBindingWithFunction;

  public constructor(
    private readonly gitExecutablePathResolver?: GitRootBindingExecutablePathResolver,
    dependencies: GitRootBindingResolverDependencies = {},
  ) {
    this.resolveRootBinding =
      dependencies.resolveRootBinding ?? resolveGitRootBinding;
    this.withRootBinding = dependencies.withRootBinding ?? withGitRootBinding;
  }

  /** Resolves and validates the current root identity. */
  public async resolve(
    repositoryRoot: string,
    expectedIdentity?: GitRootBindingIdentity,
    options: ConfiguredGitRootBindingOptions = {},
  ): Promise<GitRootBindingIdentity> {
    const gitExecutablePath = await this.resolveConfiguredGitExecutablePath();
    return this.resolveRootBinding(repositoryRoot, expectedIdentity, {
      ...options,
      gitExecutablePath,
    });
  }

  /** Asserts that the current root still matches the expected identity. */
  public async assert(
    repositoryRoot: string,
    expectedIdentity: GitRootBindingIdentity,
    options: ConfiguredGitRootBindingOptions = {},
  ): Promise<GitRootBindingIdentity> {
    return this.resolve(repositoryRoot, expectedIdentity, options);
  }

  /** Runs an operation while rechecking the same root with the same executable. */
  public async withBinding<T>(
    repositoryRoot: string,
    expectedIdentity: GitRootBindingIdentity,
    operation: () => Promise<T>,
    options: ConfiguredGitRootBindingOptions = {},
  ): Promise<T> {
    const gitExecutablePath = await this.resolveConfiguredGitExecutablePath();
    return this.withRootBinding(repositoryRoot, expectedIdentity, operation, {
      ...options,
      gitExecutablePath,
    });
  }

  private async resolveConfiguredGitExecutablePath(): Promise<string> {
    if (this.gitExecutablePathResolver === undefined) {
      throw new Error(
        "Configured Git executable resolver is required; root binding failed closed.",
      );
    }
    const configuredGitExecutablePath = await this.gitExecutablePathResolver();
    if (typeof configuredGitExecutablePath !== "string") {
      throw new Error(
        "Configured Git executable path is unavailable; root binding failed closed.",
      );
    }
    return validateGitExecutablePath(configuredGitExecutablePath);
  }
}

export { GitRootBindingResolver as ConfiguredGitRootBindingResolver };
