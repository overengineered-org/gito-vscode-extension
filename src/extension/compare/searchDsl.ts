import type { CompareCommit, CompareCommitFile } from "./compareModels.js";

export type SearchField =
  "message" | "author" | "sha" | "file" | "patch" | "date" | "ref" | "@me";

export type SearchComparisonOperator =
  "contains" | "equals" | "after" | "before" | "on-or-after" | "on-or-before";

export interface SearchClause {
  readonly field: SearchField;
  readonly value: string;
  readonly operator: SearchComparisonOperator;
}

export interface SearchIdentity {
  readonly name?: string;
  readonly email?: string;
}

export interface SearchQueryOptions {
  readonly matchCase?: boolean;
  readonly regex?: boolean;
  readonly matchAll?: boolean;
  readonly currentUser?: SearchIdentity;
  readonly cancellationSignal?: AbortSignal;
}

export interface SearchQuery extends Required<
  Pick<SearchQueryOptions, "matchCase" | "regex" | "matchAll">
> {
  readonly clauses: readonly SearchClause[];
  readonly currentUser?: SearchIdentity;
  readonly source: string;
}

export interface SearchDocument {
  readonly commitSha: string;
  readonly shortSha: string;
  readonly subject: string;
  readonly body?: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorDate: string;
  readonly commitDate?: string;
  readonly refs: readonly string[];
  readonly files: readonly SearchFile[];
  readonly patch?: string;
}

export interface SearchFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly status?: string;
}

export class SearchQueryError extends Error {
  public constructor(
    message: string,
    public readonly position?: number,
  ) {
    super(message);
    this.name = "SearchQueryError";
  }
}

const searchFieldAliases: ReadonlyMap<string, SearchField> = new Map([
  ["message", "message"],
  ["msg", "message"],
  ["subject", "message"],
  ["author", "author"],
  ["by", "author"],
  ["sha", "sha"],
  ["commit", "sha"],
  ["file", "file"],
  ["path", "file"],
  ["patch", "patch"],
  ["diff", "patch"],
  ["date", "date"],
  ["author-date", "date"],
  ["ref", "ref"],
  ["refs", "ref"],
  ["@me", "@me"],
]);

export function parseSearchQuery(
  source: string,
  options: SearchQueryOptions = {},
): SearchQuery {
  const clauses: SearchClause[] = [];
  for (const token of tokenizeSearchQuery(source)) {
    const separatorIndex = token.text.indexOf(":");
    const prefix =
      token.text === "@me"
        ? "@me"
        : separatorIndex < 0
          ? undefined
          : token.text.slice(0, separatorIndex);
    const rawValue =
      token.text === "@me"
        ? ""
        : separatorIndex < 0
          ? token.text
          : token.text.slice(separatorIndex + 1);
    const field =
      prefix === undefined
        ? "message"
        : searchFieldAliases.get(prefix.toLowerCase());
    if (field === undefined) {
      throw new SearchQueryError(
        `Unknown search field '${prefix}'.`,
        token.position,
      );
    }
    if (rawValue.length === 0 && field !== "@me") {
      throw new SearchQueryError(
        `Search field '${field}' needs a value.`,
        token.position,
      );
    }
    const { operator, value } = parseSearchValue(
      field,
      rawValue,
      token.position,
    );
    clauses.push({ field, value, operator });
  }
  if (options.regex) {
    for (const clause of clauses) {
      if (clause.field === "date") continue;
      try {
        compileSafePattern(clause.value, options.matchCase ?? false);
      } catch (error: unknown) {
        throw new SearchQueryError(
          `Invalid regular expression for ${clause.field}: ${error instanceof Error ? error.message : String(error)}.`,
        );
      }
    }
  }
  if (
    clauses.some((clause) => clause.field === "@me") &&
    options.currentUser === undefined
  ) {
    throw new SearchQueryError(
      "The @me search field requires the current user's name or email.",
    );
  }
  return {
    clauses,
    matchCase: options.matchCase ?? false,
    regex: options.regex ?? false,
    matchAll: options.matchAll ?? false,
    ...(options.currentUser === undefined
      ? {}
      : { currentUser: options.currentUser }),
    source,
  };
}

export function searchDocumentMatches(
  document: SearchDocument | CompareCommit,
  query: SearchQuery,
  cancellationSignal?: AbortSignal,
): boolean {
  if (cancellationSignal?.aborted) throw cancelledSearchError();
  if (
    query.clauses.some((clause) => clause.field === "@me") &&
    query.currentUser === undefined
  ) {
    throw new SearchQueryError(
      "The @me search field requires the current user's name or email.",
    );
  }
  if (query.clauses.length === 0) return true;
  const normalizedDocument: SearchDocument = document;
  const matches = query.clauses.map((clause) =>
    matchSearchClause(normalizedDocument, clause, query, cancellationSignal),
  );
  return query.matchAll ? matches.every(Boolean) : matches.some(Boolean);
}

export function filterSearchDocuments<T extends SearchDocument>(
  documents: readonly T[],
  query: SearchQuery,
  cancellationSignal?: AbortSignal,
): readonly T[] {
  const matchingDocuments: T[] = [];
  for (const document of documents) {
    if (cancellationSignal?.aborted) throw cancelledSearchError();
    if (searchDocumentMatches(document, query, cancellationSignal)) {
      matchingDocuments.push(document);
    }
  }
  return matchingDocuments;
}

function matchSearchClause(
  document: SearchDocument,
  clause: SearchClause,
  query: SearchQuery,
  cancellationSignal?: AbortSignal,
): boolean {
  if (clause.field === "@me") {
    const identity = query.currentUser;
    if (identity === undefined) {
      throw new SearchQueryError(
        "The @me search field requires the current user's name or email.",
      );
    }
    return (
      (identity.email !== undefined &&
        compareSearchText(
          document.authorEmail,
          identity.email,
          query,
          "equals",
          cancellationSignal,
        )) ||
      (identity.name !== undefined &&
        compareSearchText(
          document.authorName,
          identity.name,
          query,
          "equals",
          cancellationSignal,
        ))
    );
  }
  if (clause.field === "date") {
    return matchDate(document.authorDate, clause);
  }
  const values = searchableValues(document, clause.field);
  return values.some((value) =>
    compareSearchText(
      value,
      clause.value,
      query,
      clause.operator,
      cancellationSignal,
    ),
  );
}

function searchableValues(
  document: SearchDocument,
  field: Exclude<SearchField, "date" | "@me">,
): readonly string[] {
  switch (field) {
    case "message":
      return [document.subject, document.body ?? ""];
    case "author":
      return [document.authorName, document.authorEmail];
    case "sha":
      return [document.commitSha, document.shortSha];
    case "file":
      return document.files.flatMap((file) =>
        file.previousPath === undefined
          ? [file.path]
          : [file.path, file.previousPath],
      );
    case "patch":
      return [document.patch ?? ""];
    case "ref":
      return document.refs;
  }
}

function compareSearchText(
  actual: string,
  expected: string,
  query: SearchQuery,
  operator: SearchComparisonOperator,
  cancellationSignal?: AbortSignal,
): boolean {
  if (cancellationSignal?.aborted) throw cancelledSearchError();
  if (query.regex && operator !== "equals") {
    const boundedActual = actual.slice(0, maximumRegexInputCharacters);
    return safePatternMatches(
      boundedActual,
      cachedSafePattern(query, expected),
    );
  }
  const left = query.matchCase ? actual : actual.toLocaleLowerCase();
  const right = query.matchCase ? expected : expected.toLocaleLowerCase();
  switch (operator) {
    case "equals":
      return left === right;
    case "contains":
      return left.includes(right);
    case "after":
      return left > right;
    case "before":
      return left < right;
    case "on-or-after":
      return left >= right;
    case "on-or-before":
      return left <= right;
  }
}

function matchDate(actual: string, clause: SearchClause): boolean {
  const actualDate = actual.slice(0, 10);
  const actualOrdinal = numericDateOrdinal(actualDate);
  const expectedOrdinal = numericDateOrdinal(clause.value);
  switch (clause.operator) {
    case "equals":
    case "contains":
      return actualOrdinal === expectedOrdinal;
    case "after":
      return actualOrdinal > expectedOrdinal;
    case "before":
      return actualOrdinal < expectedOrdinal;
    case "on-or-after":
      return actualOrdinal >= expectedOrdinal;
    case "on-or-before":
      return actualOrdinal <= expectedOrdinal;
  }
}

const maximumRegexPatternCharacters = 512;
const maximumRegexInputCharacters = 256 * 1024;
const maximumRegexWorkUnits = 1_000_000;
interface SafePatternToken {
  readonly kind: "literal" | "wildcard";
  readonly value?: string;
}

interface SafePattern {
  readonly tokens: readonly SafePatternToken[];
  readonly anchoredStart: boolean;
  readonly anchoredEnd: boolean;
  readonly matchCase: boolean;
}

const compiledSafePatternCache = new WeakMap<
  SearchQuery,
  Map<string, SafePattern>
>();

function cachedSafePattern(query: SearchQuery, pattern: string): SafePattern {
  let queryPatternCache = compiledSafePatternCache.get(query);
  if (queryPatternCache === undefined) {
    queryPatternCache = new Map();
    compiledSafePatternCache.set(query, queryPatternCache);
  }
  const cacheKey = `${query.matchCase ? "case" : "fold"}\0${pattern}`;
  const cached = queryPatternCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const compiled = compileSafePattern(pattern, query.matchCase);
  queryPatternCache.set(cacheKey, compiled);
  return compiled;
}

/**
 * Compile a deliberately small, linear-time search pattern language.
 *
 * Supported: literals, escaped literals, `.` (one character), and `^`/`$`
 * anchors. Quantifiers, groups, alternation, and character classes are
 * rejected instead of handing attacker-controlled text to JavaScript's
 * backtracking RegExp engine.
 */
function compileSafePattern(pattern: string, matchCase: boolean): SafePattern {
  if (pattern.length > maximumRegexPatternCharacters) {
    throw new SearchQueryError(
      `Regular expressions are limited to ${maximumRegexPatternCharacters} characters.`,
    );
  }
  const tokens: SafePatternToken[] = [];
  let anchoredStart = false;
  let anchoredEnd = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    if (character === "\\") {
      const escapedCharacter = pattern[index + 1];
      if (escapedCharacter === undefined) {
        throw new SearchQueryError("Regular expression ends with an escape.");
      }
      tokens.push({
        kind: "literal",
        value: normalizePatternText(escapedCharacter, matchCase),
      });
      index += 1;
      continue;
    }
    if (character === "^" && index === 0) {
      anchoredStart = true;
      continue;
    }
    if (character === "$" && index === pattern.length - 1) {
      anchoredEnd = true;
      continue;
    }
    if (character === ".") {
      tokens.push({ kind: "wildcard" });
      continue;
    }
    if ("^$*+?{}[]()|".includes(character)) {
      throw new SearchQueryError(
        "Only literals, escaped literals, '.', '^', and '$' are supported in regex search.",
      );
    }
    tokens.push({
      kind: "literal",
      value: normalizePatternText(character, matchCase),
    });
  }
  return { tokens, anchoredStart, anchoredEnd, matchCase };
}

function normalizePatternText(text: string, matchCase: boolean): string {
  return matchCase ? text : text.toLocaleLowerCase();
}

function safePatternMatches(actual: string, pattern: SafePattern): boolean {
  const normalizedActual = normalizePatternText(actual, pattern.matchCase);
  if (pattern.tokens.length === 0) {
    return normalizedActual.length === 0;
  }
  const literalTokens = pattern.tokens.filter(
    (token): token is SafePatternToken & { readonly value: string } =>
      token.kind === "literal" && token.value !== undefined,
  );
  if (literalTokens.length === pattern.tokens.length) {
    const literalPattern = literalTokens.map((token) => token.value).join("");
    if (pattern.anchoredStart && pattern.anchoredEnd)
      return normalizedActual === literalPattern;
    if (pattern.anchoredStart)
      return normalizedActual.startsWith(literalPattern);
    if (pattern.anchoredEnd) return normalizedActual.endsWith(literalPattern);
    return kmpContains(normalizedActual, literalPattern);
  }
  const minimumLength = pattern.tokens.length;
  const firstStart = pattern.anchoredStart ? 0 : 0;
  const lastStart = pattern.anchoredStart
    ? 0
    : normalizedActual.length - minimumLength;
  const workUnits = Math.max(lastStart + 1, 0) * pattern.tokens.length;
  if (workUnits > maximumRegexWorkUnits) {
    throw new SearchQueryError(
      "Regular expression search exceeds the bounded work budget.",
    );
  }
  for (let startIndex = firstStart; startIndex <= lastStart; startIndex += 1) {
    if (
      pattern.anchoredEnd &&
      startIndex + pattern.tokens.length !== normalizedActual.length
    ) {
      continue;
    }
    let matches = true;
    for (
      let tokenIndex = 0;
      tokenIndex < pattern.tokens.length;
      tokenIndex += 1
    ) {
      const token = pattern.tokens[tokenIndex];
      if (
        token === undefined ||
        (token.kind === "literal" &&
          normalizedActual[startIndex + tokenIndex] !== token.value)
      ) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function kmpContains(actual: string, pattern: string): boolean {
  if (pattern.length === 0) return true;
  const prefixLengths = new Array<number>(pattern.length).fill(0);
  for (let patternIndex = 1, prefixLength = 0; patternIndex < pattern.length;) {
    if (pattern[patternIndex] === pattern[prefixLength]) {
      prefixLengths[patternIndex] = ++prefixLength;
      patternIndex += 1;
    } else if (prefixLength > 0) {
      prefixLength = prefixLengths[prefixLength - 1] ?? 0;
    } else {
      prefixLengths[patternIndex] = 0;
      patternIndex += 1;
    }
  }
  for (let actualIndex = 0, patternIndex = 0; actualIndex < actual.length;) {
    if (actual[actualIndex] === pattern[patternIndex]) {
      actualIndex += 1;
      patternIndex += 1;
      if (patternIndex === pattern.length) return true;
    } else if (patternIndex > 0) {
      patternIndex = prefixLengths[patternIndex - 1] ?? 0;
    } else {
      actualIndex += 1;
    }
  }
  return false;
}

function numericDateOrdinal(dateText: string): number {
  const digits = dateText.slice(0, 10).replaceAll("-", "");
  const ordinal = Number(digits);
  return Number.isSafeInteger(ordinal) ? ordinal : Number.NaN;
}

function cancelledSearchError(): DOMException {
  return new DOMException("Search request cancelled", "AbortError");
}

function parseSearchValue(
  field: SearchField,
  rawValue: string,
  position: number,
): Pick<SearchClause, "operator" | "value"> {
  if (field !== "date") return { operator: "contains", value: rawValue };
  const operatorMatch = /^(>=|<=|>|<|=)?(.+)$/.exec(rawValue);
  const operatorText = operatorMatch?.[1] ?? "";
  const value = operatorMatch?.[2] ?? "";
  if (
    value.length === 0 ||
    !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) ||
    !isValidCalendarDate(value.slice(0, 10))
  ) {
    throw new SearchQueryError(
      "Date search expects YYYY-MM-DD, optionally prefixed by >, >=, <, <=, or =.",
      position,
    );
  }
  const operator: SearchComparisonOperator =
    operatorText === ">"
      ? "after"
      : operatorText === "<"
        ? "before"
        : operatorText === ">="
          ? "on-or-after"
          : operatorText === "<="
            ? "on-or-before"
            : operatorText === "="
              ? "equals"
              : "contains";
  return { operator, value: value.slice(0, 10) };
}

function isValidCalendarDate(dateText: string): boolean {
  const dateParts = dateText.split("-").map(Number);
  const year = dateParts[0];
  const month = dateParts[1];
  const day = dateParts[2];
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1
  ) {
    return false;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

interface SearchToken {
  readonly text: string;
  readonly position: number;
}

function tokenizeSearchQuery(source: string): readonly SearchToken[] {
  const tokens: SearchToken[] = [];
  let tokenStart = -1;
  let tokenText = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (escaped) {
      tokenText += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quoted) {
      escaped = true;
      continue;
    }
    if (character === '"') {
      if (tokenStart < 0) tokenStart = index;
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(character)) {
      if (tokenStart >= 0) {
        tokens.push({ text: tokenText, position: tokenStart });
        tokenStart = -1;
        tokenText = "";
      }
      continue;
    }
    if (tokenStart < 0) tokenStart = index;
    tokenText += character;
  }
  if (escaped)
    throw new SearchQueryError(
      "Search query ends with an escape.",
      source.length - 1,
    );
  if (quoted)
    throw new SearchQueryError(
      "Search query has an unclosed quote.",
      source.length - 1,
    );
  if (tokenStart >= 0) tokens.push({ text: tokenText, position: tokenStart });
  return tokens;
}

export function searchFileValues(
  files: readonly CompareCommitFile[],
): readonly SearchFile[] {
  return files.map((file) => ({
    path: file.path,
    ...(file.previousPath === undefined
      ? {}
      : { previousPath: file.previousPath }),
    status: file.status,
  }));
}
