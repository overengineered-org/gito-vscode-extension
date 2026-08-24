import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export const workspaceTrustStorageKey = "content.trust.model.key";
export const storageTargetMarkerKey = "__$__targetStorageMarker";
export const sqliteExecutableName = "sqlite3";

/**
 * Seed VS Code's application-shared Workspace Trust state for one disposable
 * fixture. The caller must provide an isolated shared-data directory.
 */
export async function seedTrustedWorkspace({
  repositoryPath,
  sharedDataDirectoryPath,
  executeSqlite,
}) {
  if (typeof executeSqlite !== "function") {
    throw new TypeError("seedTrustedWorkspace requires executeSqlite");
  }
  const sharedStorageDirectoryPath = join(
    sharedDataDirectoryPath,
    "sharedStorage",
  );
  const trustStorageDatabasePath = join(
    sharedStorageDirectoryPath,
    "state.vscdb",
  );
  await mkdir(sharedStorageDirectoryPath, { recursive: true });

  const trustStateValue = JSON.stringify({
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
  const targetStorageMarkerValue = JSON.stringify({
    [workspaceTrustStorageKey]: 1,
  });
  const sqliteSetupStatement = [
    "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);",
    `INSERT OR REPLACE INTO ItemTable(key, value) VALUES (${sqlStringLiteral(workspaceTrustStorageKey)}, ${sqlStringLiteral(trustStateValue)});`,
    `INSERT OR REPLACE INTO ItemTable(key, value) VALUES (${sqlStringLiteral(storageTargetMarkerKey)}, ${sqlStringLiteral(targetStorageMarkerValue)});`,
  ].join(" ");
  await executeSqlite(
    sqliteExecutableName,
    [trustStorageDatabasePath, sqliteSetupStatement],
    {
      shell: false,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  return {
    trustStorageDatabasePath,
    trustStorageKey: workspaceTrustStorageKey,
    trustStateValue,
  };
}

export function sqlStringLiteral(sqlValue) {
  return `'${sqlValue.replaceAll("'", "''")}'`;
}
