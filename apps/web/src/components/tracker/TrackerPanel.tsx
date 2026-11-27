import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, TrackerPortfolio, TrackerWorkDetail } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, LinkIcon, PanelTopOpenIcon, UnlinkIcon } from "lucide-react";
import { T, useGT, useMessages, Var } from "gt-react";
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
  trackerActionRefusal,
  trackerActions,
  workMatchesQuery,
  workStatus,
  type TrackerAction,
  type TrackerActionId,
} from "./tracker.logic";
import { TrackerStatusText, TrackerWorkView } from "./TrackerWorkView";

export function TrackerHubNotice(props: { error: string; stale: boolean }) {
  return (
    <Alert variant="warning">
      <AlertTitle>
        {props.stale ? (
          <T>Showing the last answer from the tracker hub</T>
        ) : (
          <T>Tracker hub not reachable</T>
        )}
      </AlertTitle>
      <AlertDescription>
        <T>
          <Var>{props.error}</Var> This view retries by itself.
        </T>
      </AlertDescription>
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
  const gt = useGT();
  const [pending, setPending] = useState(false);
  const current = props.work.thread;

  const submit = async () => {
    setPending(true);
    const result = await link({
      environmentId: props.threadRef.environmentId,
      input: {
        workId: props.work.id,
        threadId: props.threadRef.threadId,
        // The server renames the conversation to the work's title once linked.
        title: props.work.title,
        expectedThreadId: current?.threadId ?? null,
      },
    });
    setPending(false);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: gt("Linked to {title}", { title: props.work.title }),
      });
      props.onLinked();
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not link this conversation"),
        description: errorText(squashAtomCommandFailure(result)),
      });
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div>
        <Button size="sm" disabled={pending || !canLink} onClick={() => void submit()}>
          <LinkIcon />
          {pending ? <T>Linking…</T> : <T>Link This Conversation</T>}
        </Button>
      </div>
      {current ? (
        <p className="text-muted-foreground text-xs">
          <T>
            Replaces <Var>{current.title || current.threadId}</Var> on <Var>{current.host}</Var>.
            Your decisions then come to this conversation instead.
          </T>
        </p>
      ) : null}
    </div>
  );
}

/**
 * The way out of a link: this conversation leaves the record, which then has no
 * conversation. Without it, moving onto another record was the only way to stop
 * showing a closed one (datax-v3-map, 2026-11-27).
 */
function UnlinkThisConversation(props: {
  threadRef: ScopedThreadRef;
  work: TrackerWorkDetail;
  onUnlinked: () => void;
}) {
  const unlink = useAtomCommand(serverEnvironment.trackerUnlinkThread, { reportFailure: false });
  const canUnlink = useAtomValue(
    serverEnvironment.trackerUnlinkThread.permissionAtom(props.threadRef.environmentId),
  );
  const gt = useGT();
  const [pending, setPending] = useState(false);

  const submit = async () => {
    setPending(true);
    const result = await unlink({
      environmentId: props.threadRef.environmentId,
      input: { workId: props.work.id, threadId: props.threadRef.threadId },
    });
    setPending(false);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: gt("Unlinked from {title}", { title: props.work.title }),
      });
      props.onUnlinked();
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not unlink this conversation"),
        description: errorText(squashAtomCommandFailure(result)),
      });
    }
  };

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending || !canUnlink}
      onClick={() => void submit()}
    >
      <UnlinkIcon />
      {pending ? <T>Unlinking…</T> : <T>Unlink This Conversation</T>}
    </Button>
  );
}

/** Buttons that ask the agent in this conversation to run a project skill on the linked record. */
function AgentActions(props: {
  threadRef: ScopedThreadRef;
  work: TrackerWorkDetail;
  onSend: (text: string) => Promise<void>;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const [sending, setSending] = useState<TrackerActionId | null>(null);
  const [triedRefused, setTriedRefused] = useState(false);
  // Read on every render, so the message clears once the hub names this thread the owner.
  const refusal = trackerActionRefusal(props.work, props.threadRef.threadId, resolve);

  const send = async (action: TrackerAction) => {
    if (refusal !== null) {
      setTriedRefused(true);
      return;
    }
    const label = resolve(action.label);
    if (action.confirm) {
      // Names the work item and its goal: Close Out ends the record, not this conversation.
      const approved = await requestConfirmDialog(
        gt(
          "{action} closes the work item {title}, not only this conversation. Its goal: {goal} The agent runs project-closeout, which removes its checkouts and scratch.",
          { action: label, title: props.work.title, goal: props.work.goal },
        ),
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
      toastManager.add({
        type: "success",
        title: gt("{action} sent to this conversation", { action: label }),
      });
    } else {
      toastManager.add({
        type: "error",
        title: gt("Could not send {action}", { action: label }),
        description: result,
      });
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <h3 className="border-border border-b pb-1 font-serif text-base">
        <T>Ask the Agent</T>
      </h3>
      <div className="flex flex-wrap gap-2">
        {trackerActions(props.work).map((action) => (
          <Button
            key={action.id}
            size="sm"
            variant={action.confirm ? "destructive-outline" : "outline"}
            disabled={sending !== null}
            onClick={() => void send(action)}
          >
            {sending === action.id ? <T>Sending…</T> : resolve(action.label)}
          </Button>
        ))}
      </div>
      {triedRefused && refusal !== null ? (
        <p role="status" className="text-muted-foreground text-xs">
          {refusal}
        </p>
      ) : null}
      {props.work.closeRefusal !== null ? (
        // The hub's own sentence for a standing record, in place of Close Out.
        <p className="text-muted-foreground text-xs">{props.work.closeRefusal}</p>
      ) : null}
    </section>
  );
}

function WorkPicker(props: { portfolio: TrackerPortfolio; onPick: (workId: string) => void }) {
  const gt = useGT();
  const resolve = useMessages();
  const [query, setQuery] = useState("");
  const works = props.portfolio.works.filter(
    (work) => work.status === "active" && workMatchesQuery(work, query),
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="font-serif text-lg">
          <T>This conversation is not linked</T>
        </h2>
        <p className="text-muted-foreground text-sm">
          <T>Pick the work it belongs to. Nothing changes on the hub until you press Link.</T>
        </p>
      </div>
      <input
        className="h-9 rounded-md border border-input bg-transparent px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:h-8 sm:text-sm"
        placeholder={gt("Filter work by name")}
        aria-label={gt("Filter work by name")}
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
              <TrackerStatusText {...workStatus(work, resolve)} />
            </button>
          </li>
        ))}
        {works.length === 0 ? (
          <li className="px-2 py-3 text-muted-foreground text-sm">
            <T>No active work matches.</T>
          </li>
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
  // Likewise an unlink, until the hub's next poll no longer lists the link.
  const [justUnlinkedId, setJustUnlinkedId] = useState<string | null>(null);
  const [browsingId, setBrowsingId] = useState<string | null>(null);
  const linkedId = (hubLinkedId === justUnlinkedId ? null : hubLinkedId) ?? justLinkedId;
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
                  <T>All Work</T>
                </Button>
              </div>
            ) : null}
            <TrackerWorkView
              environmentId={environmentId}
              work={work.value}
              density="panel"
              {...domainOf(portfolio.value, work.value.domain)}
              agentActions={
                // Shown on any record; each press checks that the record's own owner is
                // this thread, so a browsed, released or moved record never receives one.
                props.onSendToConversation ? (
                  <AgentActions
                    key={work.value.id}
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
                      onLinked={() => {
                        setJustUnlinkedId(null);
                        setJustLinkedId(shownId);
                      }}
                    />
                  ) : work.value.thread?.threadId === threadRef.threadId ? (
                    <UnlinkThisConversation
                      threadRef={threadRef}
                      work={work.value}
                      onUnlinked={() => {
                        setJustLinkedId(null);
                        setJustUnlinkedId(linkedId);
                        setBrowsingId(null);
                      }}
                    />
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void navigate({ to: "/tracker", search: { work: shownId } })}
                  >
                    <PanelTopOpenIcon />
                    <T>Open Tracker</T>
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
