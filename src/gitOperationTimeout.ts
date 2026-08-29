export async function completeGitOperationBeforeTimeout<GitOperationResult>(
  gitOperation: Promise<GitOperationResult>,
  timeoutMilliseconds: number,
  operationName: string,
): Promise<GitOperationResult> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutFailure = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`${operationName} timed out after ${timeoutMilliseconds} ms.`)),
      timeoutMilliseconds,
    );
  });

  try {
    return await Promise.race([gitOperation, timeoutFailure]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}
