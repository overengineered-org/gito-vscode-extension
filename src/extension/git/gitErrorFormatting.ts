const credentialQueryParameterNames =
  "access[_-]?token|api[_-]?key|auth(?:orization)?|client[_-]?secret|credential|id[_-]?token|key|oauth[_-]?token|pass(?:word|wd|phrase)?|private[_-]?key|refresh[_-]?token|sas|secret|session(?:[_-]?token)?|shared[_-]?access[_-]?signature|sig(?:nature)?|token|x[_-]?api[_-]?key|x[_-]?(?:amz|goog)[_-](?:credential|signature|security[_-]?token)";

const structuredCredentialNames =
  "access[_-]?token|api[_-]?key|client[_-]?secret|credential|id[_-]?token|key|oauth[_-]?token|pass(?:word|wd|phrase)?|private[_-]?key|refresh[_-]?token|sas|secret|session(?:[_-]?token)?|shared[_-]?access[_-]?signature|sig(?:nature)?|token|x[_-]?api[_-]?key|x[_-]?(?:amz|goog)[_-](?:credential|signature|security[_-]?token)";

const unlabelledCredentialNames =
  "access\\s+token|api\\s+key|client\\s+secret|credential|id\\s+token|oauth\\s+token|pass(?:word|phrase)?|private\\s+key|refresh\\s+token|secret|session(?:\\s+token)?|signature|token|x[_-]?api[_-]?key";
const credentialQueryParameterNamePattern = new RegExp(
  `^(?:${credentialQueryParameterNames})$`,
  "iu",
);
const opaqueCredentialValue = "opaque(?:[-_][a-z0-9]+)+|[A-Za-z0-9_-]{20,}";

export const genericGitFailureMessage =
  "Git operation failed. Check the repository and Git output, then try again.";

export function isCredentialQueryParameterName(parameterName: string): boolean {
  return credentialQueryParameterNamePattern.test(parameterName);
}

function redactAuthorizationValue(
  _match: string,
  prefix: string,
  doubleQuotedValue?: string,
  singleQuotedValue?: string,
  unquotedValue?: string,
): string {
  const authorizationValue =
    doubleQuotedValue ?? singleQuotedValue ?? unquotedValue ?? "";
  const authorizationScheme = /^(Bearer|Basic)\s+/iu.exec(
    authorizationValue,
  )?.[1];
  const redactedValue =
    authorizationScheme === undefined
      ? "[redacted]"
      : `${authorizationScheme} [redacted]`;
  if (doubleQuotedValue !== undefined) return `${prefix}"${redactedValue}"`;
  if (singleQuotedValue !== undefined) return `${prefix}'${redactedValue}'`;
  return `${prefix}${redactedValue}`;
}

/** Redact credentials before a diagnostic becomes user-visible state. */
export function redactGitErrorMessage(
  errorMessage: string,
  sensitiveValues: readonly string[] = [],
): string {
  const redactedSensitiveValues = sensitiveValues.reduce(
    (currentMessage, sensitiveValue) => {
      if (sensitiveValue.length === 0) return currentMessage;
      const encodedSensitiveValue = encodeURIComponent(sensitiveValue);
      return currentMessage
        .split(sensitiveValue)
        .join("[redacted]")
        .split(encodedSensitiveValue)
        .join("[redacted]");
    },
    errorMessage,
  );

  return redactedSensitiveValues
    .replace(
      /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi,
      "$1[redacted]@",
    )
    .replace(
      new RegExp(
        "([?&](?:" + credentialQueryParameterNames + ")=)[^&#\\s]+",
        "gi",
      ),
      "$1[redacted]",
    )
    .replace(
      /(\bauthorization\b['"]?\s*[:=]\s*)(["'])(Bearer|Basic)\s+[^"']*\2/giu,
      "$1$2$3 [redacted]$2",
    )
    .replace(
      /(\bauthorization\b['"]?\s*[:=]\s*)(Bearer|Basic)\s+[^\s,;}&\]]+/giu,
      "$1$2 [redacted]",
    )
    .replace(
      /(\bauthorization\b['"]?\s*[:=]\s*)(?!\[redacted\])(?:"([^"]*)"|'([^']*)'|([^\r\n,;&}\]]+))/giu,
      redactAuthorizationValue,
    )
    .replace(/(Bearer\s+)[^\s,;}'"]+/gi, "$1[redacted]")
    .replace(/(Basic\s+)[^\s,;}'"]+/gi, "$1[redacted]")
    .replace(
      new RegExp(
        "(\\b(?:" +
          structuredCredentialNames +
          ")\\b['\"]?\\s*[:=]\\s*)(?:\"([^\"]*)\"|'([^']*)'|([^\\s,;}&]+))",
        "gi",
      ),
      (
        _match: string,
        prefix: string,
        doubleQuotedValue?: string,
        singleQuotedValue?: string,
      ) =>
        `${prefix}${doubleQuotedValue === undefined ? (singleQuotedValue === undefined ? "[redacted]" : "'[redacted]'") : '"[redacted]"'}`,
    )
    .replace(
      /\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[baprs]-|npm_)[A-Za-z0-9_-]+/g,
      "[redacted]",
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/gu,
      "[redacted]",
    )
    .replace(
      /(?:[A-Za-z]:)?\/(?:[^\s/:]+\/)*(?:[^\s/]+\.(?:pem|key|env))(?:\b|$)/giu,
      "[redacted-path]",
    )
    .replace(/\bopaque(?:[-_][a-z0-9]+)+\b/giu, "[redacted]");
}

/** Return a redacted Git message, or a safe generic fallback. */
export function formatGitErrorForUser(
  error: unknown,
  fallbackMessage = genericGitFailureMessage,
  sensitiveValues: readonly string[] = [],
): string {
  if (!(error instanceof Error) || error.message.trim().length === 0) {
    return fallbackMessage;
  }
  const redactedMessage = redactGitErrorMessage(
    error.message,
    sensitiveValues,
  ).trim();
  if (
    new RegExp(
      "\\b(?:" +
        unlabelledCredentialNames +
        ')\\b[\'"]?\\s+\\s*(?:"(?:' +
        opaqueCredentialValue +
        ")\"|'(?:" +
        opaqueCredentialValue +
        ")'|(?:" +
        opaqueCredentialValue +
        "))",
      "iu",
    ).test(error.message)
  )
    return fallbackMessage;
  return redactedMessage.length > 0 ? redactedMessage : fallbackMessage;
}
