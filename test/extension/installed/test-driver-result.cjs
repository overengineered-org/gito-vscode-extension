function parseCompletedTestDriverResult(serializedResult) {
  let parsedResult;
  try {
    parsedResult = JSON.parse(serializedResult);
  } catch {
    return undefined;
  }
  if (
    parsedResult === null ||
    typeof parsedResult !== "object" ||
    Array.isArray(parsedResult) ||
    typeof parsedResult.passed !== "boolean"
  )
    return undefined;
  return parsedResult;
}

module.exports = { parseCompletedTestDriverResult };
