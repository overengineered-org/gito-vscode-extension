import type {
  GraphActionContextProvider,
  GraphExperienceActions,
  GraphExperienceTypedActions,
} from "./graphExperienceModels.js";

/**
 * Adapts typed service boundaries to the controller's transport-safe action
 * callbacks. Repository identity is read for every action, so a stale panel
 * cannot apply a diff, compare, or operation to a newly selected repository.
 */
export function createGraphExperienceActions(options: {
  readonly contextProvider: GraphActionContextProvider;
  readonly typedActions: GraphExperienceTypedActions;
}): GraphExperienceActions {
  const invokeWithCommit = async (
    action: keyof Pick<
      GraphExperienceTypedActions,
      "openCommit" | "openDiff" | "compareWithParent"
    >,
    commitSha: string,
    cancellationSignal: AbortSignal,
    parentSha?: string,
  ): Promise<void> => {
    throwIfActionCancelled(cancellationSignal);
    const context =
      await options.contextProvider.getContext(cancellationSignal);
    throwIfActionCancelled(cancellationSignal);
    await context.assertCurrent?.();
    const actionContext = { ...context, cancellationSignal };
    if (action === "compareWithParent")
      await options.typedActions.compareWithParent(
        actionContext,
        commitSha,
        parentSha,
      );
    else await options.typedActions[action](actionContext, commitSha);
    throwIfActionCancelled(cancellationSignal);
    await context.assertCurrent?.();
  };
  const invokeWithReference = async (
    action: keyof Pick<
      GraphExperienceTypedActions,
      "checkoutReference" | "showBranchStatus"
    >,
    referenceName: string,
    cancellationSignal: AbortSignal,
  ): Promise<void> => {
    throwIfActionCancelled(cancellationSignal);
    const context =
      await options.contextProvider.getContext(cancellationSignal);
    throwIfActionCancelled(cancellationSignal);
    await context.assertCurrent?.();
    await options.typedActions[action](
      { ...context, cancellationSignal },
      referenceName,
    );
    throwIfActionCancelled(cancellationSignal);
    await context.assertCurrent?.();
  };
  return {
    openCommit: (commitSha, cancellationSignal) =>
      invokeWithCommit("openCommit", commitSha, cancellationSignal),
    openDiff: (commitSha, cancellationSignal) =>
      invokeWithCommit("openDiff", commitSha, cancellationSignal),
    compareWithParent: (commitSha, cancellationSignal, parentSha) =>
      invokeWithCommit(
        "compareWithParent",
        commitSha,
        cancellationSignal,
        parentSha,
      ),
    checkoutReference: (referenceName, cancellationSignal) =>
      invokeWithReference(
        "checkoutReference",
        referenceName,
        cancellationSignal,
      ),
    showBranchStatus: (referenceName, cancellationSignal) =>
      invokeWithReference(
        "showBranchStatus",
        referenceName,
        cancellationSignal,
      ),
  };
}

function throwIfActionCancelled(cancellationSignal: AbortSignal): void {
  if (!cancellationSignal.aborted) return;
  throw new DOMException("Graph action cancelled", "AbortError");
}
