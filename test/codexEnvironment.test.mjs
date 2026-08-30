import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const sanitizedCommandPath = ".codex/environments/sanitized-command.sh";
const trackedEnvironmentPaths = [
  ".codex/environments/environment.toml",
  sanitizedCommandPath,
  ".codex/environments/setup.sh",
  ".codex/environments/run.sh",
  ".codex/environments/gitconfig",
  ".codex/environments/npmrc",
  "AGENTS.md",
];

test("keeps the project Codex environment portable and anonymous", () => {
  const trackedEnvironmentText = trackedEnvironmentPaths
    .map((trackedEnvironmentPath) => readFileSync(trackedEnvironmentPath, "utf8"))
    .join("\n");

  assert.doesNotMatch(trackedEnvironmentText, /\/Users\//u);
  assert.doesNotMatch(trackedEnvironmentText, /@[a-z0-9.-]+\.(com|net|org)\b/iu);
  assert.match(trackedEnvironmentText, /Repository Maintainer/);
  assert.match(trackedEnvironmentText, /repository-maintainer@overengineered\.invalid/);
});

test("removes inherited credentials and personal Git identity at runtime", () => {
  const inspectedEnvironment = JSON.parse(
    execFileSync(
      "bash",
      [
        sanitizedCommandPath,
        "node",
        "-e",
        "process.stdout.write(JSON.stringify({askPass:process.env.GIT_ASKPASS,author:process.env.GIT_AUTHOR_EMAIL,azure:process.env.AZURE_DEVOPS_EXT_PAT,gitConfigCount:process.env.GIT_CONFIG_COUNT,gitDirectory:process.env.GIT_DIR,gh:process.env.GH_TOKEN,home:process.env.HOME,nodeAuth:process.env.NODE_AUTH_TOKEN,prompt:process.env.GIT_TERMINAL_PROMPT,ssh:process.env.SSH_AUTH_SOCK,temporary:process.env.TMPDIR,user:process.env.USER}))",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GH_TOKEN: "inherited-secret",
          GIT_AUTHOR_EMAIL: "personal@example.com",
          GIT_ASKPASS: "/private/personal-askpass",
          GIT_CONFIG_COUNT: "3",
          GIT_CONFIG_KEY_0: "user.email",
          GIT_CONFIG_VALUE_0: "personal@example.com",
          GIT_CONFIG_KEY_1: "user.name",
          GIT_CONFIG_VALUE_1: "Personal Name",
          GIT_CONFIG_KEY_2: "credential.helper",
          GIT_CONFIG_VALUE_2: "personal-helper",
          GIT_DIR: "(null)",
          AZURE_DEVOPS_EXT_PAT: "inherited-azure-secret",
          NODE_AUTH_TOKEN: "inherited-npm-secret",
          SSH_AUTH_SOCK: "/private/personal-agent.sock",
        },
      },
    ),
  );

  assert.equal(inspectedEnvironment.author, undefined);
  assert.equal(inspectedEnvironment.askPass, undefined);
  assert.equal(inspectedEnvironment.azure, undefined);
  assert.equal(inspectedEnvironment.gh, undefined);
  assert.equal(inspectedEnvironment.gitConfigCount, undefined);
  assert.equal(inspectedEnvironment.gitDirectory, undefined);
  assert.equal(inspectedEnvironment.nodeAuth, undefined);
  assert.equal(inspectedEnvironment.prompt, "0");
  assert.equal(inspectedEnvironment.ssh, undefined);
  assert.equal(inspectedEnvironment.user, "repository-maintainer");
  assert.match(inspectedEnvironment.home, /\.codex-runtime\/home$/u);
  assert.match(inspectedEnvironment.temporary, /^\/tmp\/gito-codex-\d+$/u);
  assert.equal(
    execFileSync(
      "bash",
      [sanitizedCommandPath, "git", "-C", "/", "config", "--global", "user.email"],
      {
        encoding: "utf8",
      },
    ).trim(),
    "repository-maintainer@overengineered.invalid",
  );
});

test("allows a CI checkout without local Git identity", () => {
  const ciCheckoutRoot = mkdtempSync(join(tmpdir(), "gito-ci-checkout-"));
  const ciEnvironmentDirectory = join(ciCheckoutRoot, ".codex", "environments");

  try {
    mkdirSync(ciEnvironmentDirectory, { recursive: true });
    for (const environmentFileName of ["sanitized-command.sh", "gitconfig", "npmrc"]) {
      copyFileSync(
        join(".codex", "environments", environmentFileName),
        join(ciEnvironmentDirectory, environmentFileName),
      );
    }
    execFileSync("git", ["init", "--quiet", ciCheckoutRoot]);

    const inspectedEnvironment = JSON.parse(
      execFileSync(
        "bash",
        [
          join(ciEnvironmentDirectory, "sanitized-command.sh"),
          "node",
          "-e",
          "process.stdout.write(JSON.stringify({author:process.env.GIT_AUTHOR_EMAIL,user:process.env.USER}))",
        ],
        { encoding: "utf8" },
      ),
    );

    assert.equal(inspectedEnvironment.author, undefined);
    assert.equal(inspectedEnvironment.user, "repository-maintainer");
  } finally {
    rmSync(ciCheckoutRoot, { force: true, recursive: true });
  }
});
