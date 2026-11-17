import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, TrackerPortfolio, TrackerWorkDetail } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, LinkIcon, PanelTopOpenIcon } from "lucide-react";
import { useState } from "react";

import { useThreadShell } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { errorText, useTrackerPortfolio, useTrackerWork } from "~/state/tracker";
import { useAtomCommand } from "~/state/use-atom-command";

import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { linkedWorkIdForThread, workStatus } from "./tracker.logic";
import { TrackerStatusText, TrackerWorkView } from "./TrackerWorkView";

export function TrackerHubNotice(props: { error: string; stale: boolean }) {
  return (
    <Alert variant="warning">
      <AlertTitle>
        {props.stale ? "Showing the last answer from the tracker hub" : "Tracker hub not reachable"}
      </AlertTitle>
      <AlertDescription>{props.error} This view retries by itself.</AlertDescription>
    </Alert>
  );
}

export function domainOf(portfolio: TrackerPortfolio | null, domainId: string | null) {
  const domain = portfolio?.domains.find((entry) => entry.id === domainId) ?? null;
  return { domainLabel: domain?.label ?? domainId, domainColour: domain?.colour ?? null };
}

function LinkThisConversation(props: {
  threadRef: ScopedThreadRef;
  work: TrackerWorkDetail;
  onLinked: () => void;
}) {
  const shell = useThreadShell(props.threadRef);
  const link = useAtomCommand(serverEnvironment.trackerLinkThread, { reportFailure: false });
  const canLink = useAtomValue(
    serverEnvironment.trackerLinkThread.permissionAtom(props.threadRef.environmentId),
  );
  const [pending, setPending] = useState(false);
  const current = props.work.thread;

  const submit = async () => {
    setPending(true);
    const result = await link({
      environmentId: props.threadRef.environmentId,
      input: {
        workId: props.work.id,
        threadId: props.threadRef.threadId,
        title: shell?.title ?? "",
        expectedThreadId: current?.threadId ?? null,
      },
    });
    setPending(false);
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: `Linked to ${props.work.title}` });
      props.onLinked();
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Could not link this conversation",
        description: errorText(squashAtomCommandFailure(result)),
      });
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div>
        <Button size="sm" disabled={pending || !canLink} onClick={() => void submit()}>
          <LinkIcon />
          {pending ? "Linking…" : "Link This Conversation"}
        </Button>
      </div>
      {current ? (
        <p className="text-muted-foreground text-xs">
          Replaces {current.title || current.threadId} on {current.host}. Your decisions then come
          to this conversation instead.
        </p>
      ) : null}
    </div>
  );
}

function WorkPicker(props: { portfolio: TrackerPortfolio; onPick: (workId: string) => void }) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const works = props.portfolio.works.filter(
    (work) =>
      work.status === "active" &&
      (needle === "" || `${work.title} ${work.id}`.toLowerCase().includes(needle)),
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="font-serif text-lg">This conversation is not linked</h2>
        <p className="text-muted-foreground text-sm">
          Pick the work it belongs to. Nothing changes on the hub until you press Link.
        </p>
      </div>
      <input
        className="h-9 rounded-md border border-input bg-transparent px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:h-8 sm:text-sm"
        placeholder="Filter work by name"
        aria-label="Filter work by name"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <ul className="flex flex-col">
        {works.map((work) => (
          <li key={work.id}>
            <button
              type="button"
              className="flex min-h-11 w-full items-center gap-3 rounded-md px-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none sm:min-h-9"
              onClick={() => props.onPick(work.id)}
            >
              <span className="min-w-0 flex-1 truncate">{work.title}</span>
              <TrackerStatusText {...workStatus(work)} />
            </button>
          </li>
        ))}
        {works.length === 0 ? (
          <li className="px-2 py-3 text-muted-foreground text-sm">No active work matches.</li>
        ) : null}
      </ul>
    </div>
  );
}

export function TrackerPanel(props: { threadRef: ScopedThreadRef }) {
  const { threadRef } = props;
  const environmentId = threadRef.environmentId;
  const navigate = useNavigate();
  const portfolio = useTrackerPortfolio(environmentId);
  const hubLinkedId = linkedWorkIdForThread(portfolio.value, threadRef.threadId);
  // The hub's link list refreshes on its own timer; hold a fresh link until it agrees.
  const [justLinkedId, setJustLinkedId] = useState<string | null>(null);
  const [browsingId, setBrowsingId] = useState<string | null>(null);
  const linkedId = hubLinkedId ?? justLinkedId;
  const shownId = linkedId ?? browsingId;
  const work = useTrackerWork(environmentId, shownId);
  const error = portfolio.error ?? work.error;

  return (
    <div className="scrollbar-gutter-both h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
        {error ? (
          <TrackerHubNotice error={error} stale={portfolio.value !== null || work.value !== null} />
        ) : null}
        {shownId === null ? (
          portfolio.value ? (
            <WorkPicker portfolio={portfolio.value} onPick={setBrowsingId} />
          ) : portfolio.loading ? (
            <Skeleton className="h-40 w-full" />
          ) : null
        ) : work.value && work.value.id === shownId ? (
          <>
            {linkedId === null ? (
              <div>
                <Button size="sm" variant="ghost" onClick={() => setBrowsingId(null)}>
                  <ArrowLeftIcon />
                  All Work
                </Button>
              </div>
            ) : null}
            <TrackerWorkView
              environmentId={environmentId}
              work={work.value}
              density="panel"
              {...domainOf(portfolio.value, work.value.domain)}
              actions={
                <>
                  {linkedId === null ? (
                    <LinkThisConversation
                      threadRef={threadRef}
                      work={work.value}
                      onLinked={() => setJustLinkedId(shownId)}
                    />
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void navigate({ to: "/tracker", search: { work: shownId } })}
                  >
                    <PanelTopOpenIcon />
                    Open Tracker
                  </Button>
                </>
              }
            />
          </>
        ) : work.loading ? (
          <Skeleton className="h-64 w-full" />
        ) : null}
      </div>
    </div>
  );
}
