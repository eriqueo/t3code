import { REVIEW_PROVIDER_INSTANCE_ID, type OrchestrationThread } from "@t3tools/contracts";

/** Both the selected and active instance constrain server-owned workspace effects. */
export const isReviewThread = (
  thread: Pick<OrchestrationThread, "modelSelection" | "session"> | undefined,
): boolean =>
  thread?.modelSelection.instanceId === REVIEW_PROVIDER_INSTANCE_ID ||
  thread?.session?.providerInstanceId === REVIEW_PROVIDER_INSTANCE_ID;
