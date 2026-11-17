import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { useThreadShells } from "~/state/entities";
import { readEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useTrackerEnvironmentIds, useTrackerPortfolio } from "~/state/tracker";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";

import { owedThreadTitles } from "./tracker.logic";

/** Mounted once with the sidebar: one title sync per machine that can reach the hub. */
export function TrackerTitleSync() {
  const environmentIds = useTrackerEnvironmentIds();
  return environmentIds.map((environmentId) => (
    <EnvironmentTitleSync key={environmentId} environmentId={environmentId} />
  ));
}

/**
 * Renames each linked conversation on one machine to its work's title; that machine's
 * server reports its own links. Each rename is tried once per title, so a refused one cannot loop.
 */
function EnvironmentTitleSync({ environmentId }: { environmentId: EnvironmentId }) {
  const portfolio = useTrackerPortfolio(environmentId).value;
  const threads = useThreadShells();
  const updateMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const tried = useRef(new Set<string>());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keeps server-held thread titles in step with the hub's work titles, which change outside this app (agents rename records and link threads from the hub).
  useEffect(() => {
    if (portfolio === null) return;
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
