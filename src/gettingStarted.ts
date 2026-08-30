export async function openGettingStartedOnFirstActivation(
  gettingStartedPreviouslyOpened: boolean,
  openGettingStartedWalkthrough: () => PromiseLike<unknown>,
  rememberGettingStartedOpened: () => PromiseLike<void>,
): Promise<void> {
  if (gettingStartedPreviouslyOpened) {
    return;
  }
  await openGettingStartedWalkthrough();
  await rememberGettingStartedOpened();
}
