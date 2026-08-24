import { Buffer } from "node:buffer";

const githubTokenPattern =
  /\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{20,}\b/u;
const gitlabTokenPattern = /\bglpat-[A-Za-z0-9_-]{20,}\b/u;
const openAiTokenPattern = /\bsk-[A-Za-z0-9]{20,}\b/u;
const slackTokenPattern = /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u;
const awsAccessKeyPattern = /\bAKIA[0-9A-Z]{16}\b/u;
const npmTokenPattern = /\bnpm_[A-Za-z0-9]{20,}\b/u;
const privateKeyPattern = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u;

// New Azure DevOps PATs are 84 alphanumeric characters with AZDO at indexes
// 76-79. Legacy 52-character PATs are only treated as credentials when they
// are assigned to an Azure/VSCE-specific variable, avoiding random-string
// false positives in source and packaged assets.
const azureDevOpsSignedPatPattern = /\b[A-Za-z0-9]{76}AZDO[A-Za-z0-9]{4}\b/u;
const azureDevOpsPatAssignmentPattern =
  /\b(?:AZDO_PAT|AZURE_DEVOPS_EXT_PAT|AZURE_DEVOPS_PAT|SYSTEM_ACCESSTOKEN|VSS_NUGET_ACCESSTOKEN|VSCE_PAT)\b\s*[:=]\s*["']?[A-Za-z0-9]{52}(?:[A-Za-z0-9]{32})?(?![A-Za-z0-9])["']?/iu;

export const credentialPatterns = [
  githubTokenPattern,
  gitlabTokenPattern,
  openAiTokenPattern,
  slackTokenPattern,
  awsAccessKeyPattern,
  npmTokenPattern,
  azureDevOpsSignedPatPattern,
  azureDevOpsPatAssignmentPattern,
  privateKeyPattern,
];

export function findCredentialPattern(text) {
  for (const credentialPattern of credentialPatterns) {
    credentialPattern.lastIndex = 0;
    if (credentialPattern.test(text)) return credentialPattern;
  }
  return undefined;
}

export function assertCredentialFreeText(text, displayPath) {
  if (findCredentialPattern(text) !== undefined) {
    throw new Error(
      `Credential-shaped value found in current-tree file ${displayPath}.`,
    );
  }
}

/** Scan all bytes with bounded memory, including files larger than 20 MiB. */
export async function scanReadableForCredentials(readable, displayPath) {
  let overlapText = "";
  for await (const chunk of readable) {
    const chunkText = Buffer.isBuffer(chunk)
      ? chunk.toString("utf8")
      : String(chunk);
    const scanText = overlapText + chunkText;
    assertCredentialFreeText(scanText, displayPath);
    overlapText = scanText.slice(-4096);
  }
}
