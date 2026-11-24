import type { TestRunReceipt } from "@t3tools/contracts";

export const testRunAtTime = (receipt: TestRunReceipt, at: string): TestRunReceipt =>
  receipt.state === "running" && at > receipt.deadlineAt
    ? { ...receipt, state: "outcome_unknown", reason: "deadline_elapsed" }
    : receipt;
