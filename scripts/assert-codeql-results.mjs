import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function collectUnsuppressedCodeqlFindings(codeqlSarifDocuments) {
  return codeqlSarifDocuments.flatMap((codeqlSarifDocument) =>
    (codeqlSarifDocument.runs ?? []).flatMap((codeqlRun) =>
      (codeqlRun.results ?? [])
        .filter((codeqlFinding) => (codeqlFinding.suppressions ?? []).length === 0)
        .map((codeqlFinding) => ({
          message: codeqlFinding.message?.text ?? "CodeQL finding without a message",
          ruleIdentifier: codeqlFinding.ruleId ?? "unknown-rule",
          sourceLocation:
            codeqlFinding.locations?.[0]?.physicalLocation?.artifactLocation?.uri ??
            "unknown-location",
        })),
    ),
  );
}

function assertCodeqlResults(codeqlResultsDirectory) {
  const codeqlResultFileNames = readdirSync(codeqlResultsDirectory)
    .filter((codeqlResultFileName) => codeqlResultFileName.endsWith(".sarif"))
    .sort();
  if (codeqlResultFileNames.length === 0) {
    throw new Error(`No CodeQL SARIF results found in ${codeqlResultsDirectory}`);
  }

  const codeqlSarifDocuments = codeqlResultFileNames.map((codeqlResultFileName) =>
    JSON.parse(readFileSync(resolve(codeqlResultsDirectory, codeqlResultFileName), "utf8")),
  );
  const unsuppressedCodeqlFindings = collectUnsuppressedCodeqlFindings(codeqlSarifDocuments);
  if (unsuppressedCodeqlFindings.length > 0) {
    const findingSummary = unsuppressedCodeqlFindings
      .slice(0, 20)
      .map(
        ({ message, ruleIdentifier, sourceLocation }) =>
          `${ruleIdentifier} at ${sourceLocation}: ${message}`,
      )
      .join("\n");
    throw new Error(
      `CodeQL found ${unsuppressedCodeqlFindings.length} unsuppressed alert(s):\n${findingSummary}`,
    );
  }

  console.log(`CodeQL passed across ${codeqlResultFileNames.length} SARIF result files.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const codeqlResultsDirectory = process.argv[2];
  if (!codeqlResultsDirectory) {
    throw new Error("Usage: node scripts/assert-codeql-results.mjs <results-directory>");
  }
  assertCodeqlResults(resolve(codeqlResultsDirectory));
}
