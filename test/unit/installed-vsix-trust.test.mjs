import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import {
  seedTrustedWorkspace,
  sqliteExecutableName,
  sqlStringLiteral,
  storageTargetMarkerKey,
  workspaceTrustStorageKey,
} from "../../scripts/installed-vsix-trust.mjs";

test("builds isolated trust storage for the exact repository URI", async () => {
  const isolatedRootPath = join(
    tmpdir(),
    `gito-installed-vsix-trust-test-${process.pid}`,
  );
  const sqliteCalls = [];
  const sharedDataDirectoryPath = join(isolatedRootPath, "shared-data");
  const repositoryPath = join(isolatedRootPath, "repository", "fixture");

  try {
    const trustStorage = await seedTrustedWorkspace({
      repositoryPath,
      sharedDataDirectoryPath,
      executeSqlite: async (...sqliteArguments) => {
        sqliteCalls.push(sqliteArguments);
      },
    });

    assert.equal(
      trustStorage.trustStorageDatabasePath,
      join(sharedDataDirectoryPath, "sharedStorage", "state.vscdb"),
    );
    assert.equal(trustStorage.trustStorageKey, workspaceTrustStorageKey);
    assert.deepEqual(JSON.parse(trustStorage.trustStateValue), {
      uriTrustInfo: [
        {
          uri: {
            scheme: "file",
            authority: "",
            path: repositoryPath,
            query: "",
            fragment: "",
          },
          trusted: true,
        },
      ],
    });
    assert.equal(sqliteCalls.length, 1);
    assert.equal(sqliteCalls[0][0], sqliteExecutableName);
    assert.deepEqual(sqliteCalls[0][1].slice(0, 1), [
      trustStorage.trustStorageDatabasePath,
    ]);
    assert.match(sqliteCalls[0][1][1], /CREATE TABLE IF NOT EXISTS ItemTable/u);
    assert.match(sqliteCalls[0][1][1], /content\.trust\.model\.key/u);
    assert.match(
      sqliteCalls[0][1][1],
      new RegExp(storageTargetMarkerKey.replaceAll("$", "\\$"), "u"),
    );
    assert.equal(sqliteCalls[0][2].shell, false);
  } finally {
    await rm(isolatedRootPath, { recursive: true, force: true });
  }
});

test("escapes SQL literals without changing trust payload data", () => {
  assert.equal(sqlStringLiteral("fixture's path"), "'fixture''s path'");
});

test("does not silently omit the exact trust state", async () => {
  await assert.rejects(
    seedTrustedWorkspace({
      repositoryPath: "/tmp/repository",
      sharedDataDirectoryPath: "/tmp/shared-data",
    }),
    /requires executeSqlite/u,
  );
});
