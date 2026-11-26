import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, TrackerWatch, TrackerWorkDetail } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, FileTextIcon, MessageSquareIcon, PlayIcon } from "lucide-react";
import { T, useGT, useMessages, Var } from "gt-react";
import { type FormEvent, type ReactNode, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { cn, randomUUID } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { errorText } from "~/state/tracker";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";

import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { TrackerDecisions } from "./TrackerDecisions";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useTrackerAgentStart, useTrackerModelChoice } from "./useTrackerAgentStart";
import {
  currentPhase,
  decisionCards,
  phaseStatusLabel,
  progressFraction,
  trackerDocUrl,
  trackerSummary,
  resumableThreadId,
  watchStateLabel,
  workStatus,
  type TrackerTone,
} from "./tracker.logic";

const TONE_CLASS: Record<TrackerTone, string> = {
  attention: "text-warning-foreground",
  problem: "text-destructive-foreground",
  quiet: "text-muted-foreground",
  ok: "text-success-foreground",
};

export function TrackerStatusText(props: { label: string; tone: TrackerTone }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs", TONE_CLASS[props.tone])}>
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {props.label}
    </span>
  );
}

/** Phases done out of phases planned. Work without phases renders nothing: it has no percentage. */
export function TrackerProgressBar(props: {
  progress: { done: number; total: number };
  colour: string | null;
}) {
  const gt = useGT();
  const fraction = progressFraction(props.progress);
  if (fraction === null) return null;
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={props.progress.total}
        aria-valuenow={props.progress.done}
        aria-label={gt("Phases done")}
      >
        <div
          className="h-full rounded-full bg-primary"
          style={{
            width: `${fraction * 100}%`,
            ...(props.colour ? { backgroundColor: props.colour } : {}),
          }}
        />
      </div>
      <span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
        {props.progress.done}/{props.progress.total}
      </span>
    </div>
  );
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="border-border border-b pb-1 font-serif text-base">{props.title}</h3>
      {props.children}
    </section>
  );
}

const watchTime = (iso: string) =>
  new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/**
 * What the agent waits on outside the hub (tracker watches). The hub host checks each
 * one and wakes this record's conversation, ending its T3 snooze; Eric can drop a watch.
 * To quiet the conversation meanwhile he snoozes the thread itself, so there is no
 * second snooze here.
 */
function TrackerWatches(props: { environmentId: EnvironmentId; work: TrackerWorkDetail }) {
  const update = useAtomCommand(serverEnvironment.trackerUpdateWatch, { reportFailure: false });
  const gt = useGT();
  const resolve = useMessages();
  const [pending, setPending] = useState<string | null>(null);

  const cancel = async (watch: TrackerWatch) => {
    const approved = await requestConfirmDialog(
      gt("Stop waiting for {pullRequest}? The agent will not be woken.", {
        pullRequest: `${watch.repo}#${watch.number}`,
      }),
      { variant: "destructive" },
    );
    if (approved !== true) return;
    setPending(watch.id);
    const result = await update({
      environmentId: props.environmentId,
      input: { workId: props.work.id, watch: watch.id, action: "cancel" },
    });
    setPending(null);
    if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Not saved"),
        description: errorText(squashAtomCommandFailure(result)),
      });
    }
  };

  return (
    <ul className="flex flex-col gap-3">
      {props.work.watches.map((watch) => (
        <li key={watch.id} className="flex flex-col gap-1.5" data-tracker-watch={watch.id}>
          <p className="text-sm">
            {gt("{pullRequest} to merge", { pullRequest: `${watch.repo}#${watch.number}` })}
            <span className="block text-muted-foreground text-xs">
              {watchStateLabel(watch, watchTime, resolve)}
              {watch.note ? ` · ${watch.note}` : ""}
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={pending !== null}
              onClick={() => void cancel(watch)}
            >
              <T>Cancel</T>
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** One line under the title in the sidebar: the tagline, else the goal cut to fit; hover shows the goal. */
function TrackerSummaryLine(props: { work: TrackerWorkDetail }) {
  const line = trackerSummary(props.work);
  if (line === "") return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<p className="truncate text-muted-foreground text-sm" data-tracker-summary />}
      >
        {line}
      </TooltipTrigger>
      <TooltipPopup side="bottom" className="max-w-80">
        {props.work.goal || line}
      </TooltipPopup>
    </Tooltip>
  );
}

/** The hub starts the agent in the record's workspace and moves the record to its conversation. */
function LaunchAgentButton(props: { environmentId: EnvironmentId; work: TrackerWorkDetail }) {
  const canStart = useAtomValue(
    serverEnvironment.trackerStartAgent.permissionAtom(props.environmentId),
  );
  const startAgent = useTrackerAgentStart();
  const model = useTrackerModelChoice(props.environmentId);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const gt = useGT();
  const noteId = `tracker-launch-note-${props.work.id}`;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setOpen(false);
    setPending(true);
    void startAgent(props.environmentId, {
      workId: props.work.id,
      key: randomUUID(),
      ...(note.trim() === "" ? {} : { request: note.trim() }),
      ...(model.selection === null ? {} : { model: model.selection }),
    })
      .then((started) => {
        if (started) setNote("");
      })
      .finally(() => setPending(false));
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button size="sm" disabled={pending || !canStart}>
            <PlayIcon />
            {pending ? <T>Starting Agent…</T> : <T>Launch Agent</T>}
          </Button>
        }
      />
      <PopoverPopup align="start" width="md">
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={noteId}>
              <T>Note for the agent</T>
            </Label>
            <Textarea
              id={noteId}
              rows={3}
              maxLength={2000}
              placeholder={gt("Optional")}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          {model.picker === null ? null : (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm">
                <T>Model</T>
              </span>
              <div>{model.picker}</div>
            </div>
          )}
          <p className="text-muted-foreground text-xs">
            <T>Your decisions then go to the new conversation.</T>
          </p>
          <div>
            <Button type="submit" size="sm">
              <PlayIcon />
              <T>Start Agent</T>
            </Button>
          </div>
        </form>
      </PopoverPopup>
    </Popover>
  );
}

function LinkedConversation(props: { environmentId: EnvironmentId; work: TrackerWorkDetail }) {
  const navigate = useNavigate();
  const thread = props.work.thread;
  const resumableId = resumableThreadId(props.work);
  const threadRef =
    resumableId === null ? null : scopeThreadRef(props.environmentId, ThreadId.make(resumableId));
  const shell = useThreadShell(threadRef);

  if (thread === null) {
    return (
      <p className="text-muted-foreground text-sm">
        <T>No conversation is linked yet.</T>
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{shell?.title ?? (thread.title || thread.threadId)}</p>
        <p className="text-muted-foreground text-xs">
          {threadRef !== null && shell === null ? (
            <T>
              Receives your decisions · <Var>{thread.host}</Var> · not found in this environment
            </T>
          ) : (
            <T>
              Receives your decisions · <Var>{thread.host}</Var>
            </T>
          )}
        </p>
      </div>
      {threadRef !== null && shell !== null ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(threadRef),
            })
          }
        >
          <MessageSquareIcon />
          <T>Open Conversation</T>
        </Button>
      ) : null}
    </div>
  );
}

export function TrackerWorkView(props: {
  environmentId: EnvironmentId;
  work: TrackerWorkDetail;
  domainColour: string | null;
  domainLabel: string | null;
  /** The panel keeps to the roadmap and agent actions; the page adds the conversation and history. */
  density: "panel" | "page";
  actions?: ReactNode;
  /** Buttons that ask the agent to work on this record, shown under the roadmap. */
  agentActions?: ReactNode;
}) {
  const { work } = props;
  const gt = useGT();
  const resolve = useMessages();
  const status = workStatus(
    {
      waitingOnYou: work.waitingOnYou,
      overdue: false,
      status: work.status,
      state: "",
    },
    resolve,
  );
  const navigate = useNavigate();
  const phase = currentPhase(work.phases);
  const { open: openCards, decided: decidedCards } = decisionCards(work.cards);
  // Decisions are answered on the full Tracker page inside T3, not in a browser.
  const openDecisions = () => void navigate({ to: "/tracker", search: { work: work.id } });
  const hubPage = `${work.hubUrl}/p/${encodeURIComponent(work.id)}`;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {props.domainLabel ? (
            <span
              className="font-medium uppercase tracking-wide"
              style={props.domainColour ? { color: props.domainColour } : undefined}
            >
              {props.domainLabel}
            </span>
          ) : null}
          <TrackerStatusText {...status} />
        </div>
        <h2 className={cn("font-serif", props.density === "page" ? "text-2xl" : "text-lg")}>
          {work.title}
        </h2>
        {props.density === "page" ? (
          work.goal ? (
            <p className="text-muted-foreground text-sm">{work.goal}</p>
          ) : null
        ) : (
          <TrackerSummaryLine work={work} />
        )}
        <TrackerProgressBar progress={work.progress} colour={props.domainColour} />
        {work.needsReview ? (
          <TrackerStatusText
            tone="attention"
            label={gt("Record needs review: {reasons}", {
              reasons: work.needsReview.reasons.join("; "),
            })}
          />
        ) : null}
        {work.trains.map((train) => (
          <p
            key={train.repo}
            className="text-muted-foreground text-xs"
            data-tracker-train={train.repo}
          >
            <span className="block">
              {gt("Waiting for the train: {repo} ({waiting} waiting)", {
                repo: train.repo,
                waiting: train.waiting,
              })}
            </span>
            <span className="block break-all font-mono">{train.check}</span>
          </p>
        ))}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {props.actions}
          <Button
            size="sm"
            variant="ghost"
            render={<a href={`${hubPage}/overview`} target="_blank" rel="noreferrer" />}
          >
            <ArrowUpRightIcon />
            <T>Open on Hub</T>
          </Button>
        </div>
      </header>

      {work.docs.length > 0 ? (
        <Section title={gt("Docs")}>
          <div className="flex flex-wrap gap-2">
            {work.docs.map((doc) => (
              <Button
                key={doc.path}
                size="sm"
                variant="outline"
                render={
                  <a
                    href={trackerDocUrl(work.hubUrl, work.id, doc.path)}
                    target="_blank"
                    rel="noreferrer"
                  />
                }
              >
                <FileTextIcon />
                {doc.label}
              </Button>
            ))}
          </div>
        </Section>
      ) : null}

      {props.density === "page" ? (
        openCards.length > 0 || decidedCards.length > 0 || work.handoff.waiting ? (
          <Section title={gt("Decisions")}>
            <TrackerDecisions environmentId={props.environmentId} work={work} />
          </Section>
        ) : null
      ) : openCards.length > 0 || (decidedCards.length > 0 && !work.handoff.waiting) ? (
        <Section title={gt("Waiting on You")}>
          <ul className="flex flex-col gap-1.5 text-sm">
            {openCards.map((card) => (
              <li key={card.id} className="flex items-baseline gap-2">
                <span className="text-warning-foreground">
                  <T>Decide:</T>
                </span>
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left underline-offset-4 hover:underline"
                  onClick={openDecisions}
                >
                  {card.title}
                </button>
              </li>
            ))}
            {openCards.length === 0 ? (
              <li>
                <button
                  type="button"
                  className="text-left underline-offset-4 hover:underline"
                  onClick={openDecisions}
                >
                  <T>Answered, not sent yet: press Done Deciding</T>
                </button>
              </li>
            ) : null}
          </ul>
        </Section>
      ) : null}

      <Section title={gt("Roadmap")}>
        {work.phases.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            <T>
              A task with no phases. Status: <Var>{work.status}</Var>.
            </T>
          </p>
        ) : (
          <ol className="flex flex-col">
            {work.phases.map((item) => {
              const isCurrent = item.id === phase?.id;
              return (
                <li
                  key={item.id}
                  aria-current={isCurrent ? "step" : undefined}
                  className={cn(
                    "flex min-h-9 items-center gap-3 rounded-md px-2 py-1.5 text-sm",
                    isCurrent ? "bg-accent ring-1 ring-primary ring-inset" : "odd:bg-muted/40",
                  )}
                >
                  <span className="w-8 shrink-0 font-mono text-muted-foreground text-xs">
                    {item.id}
                  </span>
                  <span
                    className={cn(
                      // Wraps rather than truncates: the roadmap is read at a glance.
                      "min-w-0 flex-1 text-pretty",
                      item.status === "done" && "text-muted-foreground line-through",
                      isCurrent && "font-medium",
                    )}
                  >
                    {item.title}
                  </span>
                  {isCurrent ? (
                    <span className="shrink-0 font-medium text-primary text-xs">
                      <T context="roadmap: the phase being worked on">Now</T>
                    </span>
                  ) : null}
                  {/* Strike-through and "Now" carry status; only a wait says something new. */}
                  {item.status === "waiting" ? (
                    <span className="shrink-0 text-warning-foreground text-xs">
                      {phaseStatusLabel(item, resolve)}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
        {phase === null && work.phases.length > 0 ? (
          <p className="text-muted-foreground text-sm">
            <T>Every phase is done.</T>
          </p>
        ) : null}
      </Section>

      {work.watches.length > 0 ? (
        <Section title={gt("Waiting For")}>
          <TrackerWatches environmentId={props.environmentId} work={work} />
        </Section>
      ) : null}

      {props.agentActions}

      {props.density === "page" ? (
        <Section title={gt("Conversation")}>
          <LinkedConversation environmentId={props.environmentId} work={work} />
          <div>
            <LaunchAgentButton environmentId={props.environmentId} work={work} />
          </div>
        </Section>
      ) : null}

      {/* The sidebar judges progress from the roadmap; the run journal lives on the page. */}
      {props.density === "page" && work.briefs.length > 0 ? (
        <Section title={gt("Runs", { $context: "agent run history" })}>
          <ul className="flex flex-col gap-3">
            {work.briefs.slice(0, 8).map((brief) => (
              <li key={brief.id} className="flex flex-col gap-0.5 text-sm">
                <p>
                  {brief.title}
                  <span className="pl-2 font-mono text-muted-foreground text-xs tabular-nums">
                    {brief.date}
                  </span>
                </p>
                <p className="text-muted-foreground">{brief.summary}</p>
                {brief.wrong.map((entry) => (
                  <p key={entry} className="text-destructive-foreground text-xs">
                    <T>
                      Went wrong: <Var>{entry}</Var>
                    </T>
                  </p>
                ))}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}
