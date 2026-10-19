import { REVIEW_PROVIDER_INSTANCE_ID } from "@t3tools/contracts";

/** Selection, persisted run and active session each constrain workspace effects. */
export const isReviewInstance = (...instances: ReadonlyArray<string | null | undefined>) =>
  instances.some((instance) => instance === REVIEW_PROVIDER_INSTANCE_ID);
