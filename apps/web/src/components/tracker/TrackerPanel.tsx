import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, TrackerPortfolio, TrackerWorkDetail } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, LinkIcon, PanelTopOpenIcon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { serverEnvironment } from "~/state/server";
import { errorText, useTrackerPortfolio, useTrackerWork } from "~/state/tracker";
import { useAtomCommand } from "~/state/use-atom-command";

import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import {
  linkedWorkIdForThread,
  trackerActionMessage,
  trackerActions,
  workStatus,
  type TrackerAction,
  type TrackerActionId,
} from "./tracker.logic";
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
        // TrackerTitleSync renames the conversation to the work's title once linked.
        title: props.work.title,
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

/** Buttons that ask the agent in this conversation to run a project skill on the linked record. */
function AgentActions(props: {
  threadRef: ScopedThreadRef;
  work: TrackerWorkDetail;
  onSend: (text: string) => Promise<void>;
}) {
  const [sending, setSending] = useState<TrackerActionId | null>(null);

  const send = async (action: TrackerAction) => {
    if (action.confirm) {
      const approved = await requestConfirmDialog(
        `${action.label} ${props.work.title}? The agent runs project-closeout, which closes the record.`,
        { variant: "destructive" },
      );
      if (approved !== true) return;
    }
    setSending(action.id);
    const result = await props
      .onSend(trackerActionMessage(action.id, props.work.id, props.threadRef.threadId))
      .then(
        () => null,
        (error: unknown) => errorText(error),
      );
    setSending(null);
    if (result === null) {
      toastManager.add({ type: "success", title: `${action.label} sent to this conversation` });
    } else {
      toastManager.add({
        type: "error",
        title: `Could not send ${action.label}`,
        description: result,
      });
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <h3 className="border-border border-b pb-1 font-serif text-base">Ask the Agent</h3>
      <div className="flex flex-wrap gap-2">
        {trackerActions(props.work).map((action) => (
          <Button
            key={action.id}
            size="sm"
            variant={action.confirm ? "destructive-outline" : "outline"}
            disabled={sending !== null}
            onClick={() => void send(action)}
          >
            {sending === action.id ? "Sending…" : action.label}
          </Button>
        ))}
      </div>
    </section>
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

export function TrackerPanel(props: {
  threadRef: ScopedThreadRef;
  /** Sends a message into this conversation, queued behind a running turn; absent before the thread starts. */
  onSendToConversation: ((text: string) => Promise<void>) | undefined;
}) {
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
              agentActions={
                // Only once the hub itself names this thread: an optimistic or browsed
                // record must never receive an action meant for the linked one.
                hubLinkedId === shownId && props.onSendToConversation ? (
                  <AgentActions
                    threadRef={threadRef}
                    work={work.value}
                    onSend={props.onSendToConversation}
                  />
                ) : null
              }
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
