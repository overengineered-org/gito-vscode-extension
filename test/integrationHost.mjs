import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const isolatedHostLaunchArguments = [
  "--disable-crash-reporter",
  "--disable-telemetry",
  "--disable-workspace-trust",
  "--skip-welcome",
  "--use-inmemory-secretstorage",
];

export function initializeIsolatedUserData(userDataDirectory) {
  const userSettingsDirectory = resolve(userDataDirectory, "User");
  mkdirSync(userSettingsDirectory, { recursive: true });
  writeFileSync(
    resolve(userSettingsDirectory, "settings.json"),
    `${JSON.stringify(
      {
        "chat.disableAIFeatures": true,
        "extensions.autoCheckUpdates": false,
        "extensions.autoUpdate": false,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}
