import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { useThreadShells } from "~/state/entities";
import { readEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useTrackerEnvironmentId, useTrackerPortfolio } from "~/state/tracker";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";

import { owedThreadTitles } from "./tracker.logic";

/**
 * Renames each linked conversation on this host to its work's title. Mounted once with
 * the sidebar; each rename is tried once per title, so a refused rename cannot loop.
 */
export function TrackerTitleSync() {
  const environmentId = useTrackerEnvironmentId();
  const portfolio = useTrackerPortfolio(environmentId).value;
  const threads = useThreadShells(environmentId !== null);
  const updateMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const tried = useRef(new Set<string>());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keeps server-held thread titles in step with the hub's work titles, which change outside this app (agents rename records and link threads from the hub).
  useEffect(() => {
    if (environmentId === null || portfolio === null) return;
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const titles = new Map(
      threads
        .filter((thread) => thread.environmentId === environmentId)
        .map((thread) => [String(thread.id), thread.title]),
    );
    for (const rename of owedThreadTitles(portfolio, titles)) {
      const key = `${rename.threadId}\n${rename.title}`;
      if (tried.current.has(key)) continue;
      tried.current.add(key);
      const thread = threads.find(
        (entry) => entry.environmentId === environmentId && entry.id === rename.threadId,
      );
      if (thread === undefined) continue;
      void updateMetadata({
        environmentId,
        input: { threadId: thread.id, title: rename.title },
      });
    }
  }, [environmentId, portfolio, threads, updateMetadata]);

  return null;
}
