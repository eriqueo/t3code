import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, TrackerWorkDetail } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, FileTextIcon, MessageSquareIcon, PlayIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { cn } from "~/lib/utils";
import { useProjects, useThreadShell } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { errorText } from "~/state/tracker";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";

import { Button } from "../ui/button";
import { Menu, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import {
  currentPhase,
  phaseStatusLabel,
  progressFraction,
  trackerDocUrl,
  resumableThreadId,
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
        aria-label="Phases done"
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

function LaunchAgentButton(props: { environmentId: EnvironmentId; work: TrackerWorkDetail }) {
  const projects = useProjects().filter(
    (project) => project.environmentId === props.environmentId && project.isScratch !== true,
  );
  const readPrompt = useAtomCommand(serverEnvironment.trackerLaunchPrompt, {
    reportFailure: false,
  });
  const newThread = useNewThreadHandler();
  const [pending, setPending] = useState(false);

  const openDraft = async (projectId: (typeof projects)[number]["id"]) => {
    const prompt = await readPrompt({
      environmentId: props.environmentId,
      input: { workId: props.work.id },
    });
    if (prompt._tag !== "Success") {
      if (!isAtomCommandInterrupted(prompt)) {
        toastManager.add({
          type: "error",
          title: "Could not read the next prompt",
          description: errorText(squashAtomCommandFailure(prompt)),
        });
      }
      return;
    }
    // Opens a draft only: the agent starts when Eric sends it, with the project,
    // model and workspace he sees in the composer.
    await newThread(scopeProjectRef(props.environmentId, projectId), {
      prompt: prompt.value.text,
    });
  };

  // React Compiler cannot compile try/finally, so the pending flag clears on the promise.
  const launch = (projectId: (typeof projects)[number]["id"]) => {
    setPending(true);
    void openDraft(projectId).finally(() => setPending(false));
  };

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="sm" disabled={pending || projects.length === 0}>
            <PlayIcon />
            {pending ? "Preparing…" : "Launch Agent"}
          </Button>
        }
      />
      <MenuPopup align="start">
        <MenuGroupLabel>Start a draft in</MenuGroupLabel>
        {projects.map((project) => (
          <MenuItem key={project.id} onClick={() => launch(project.id)}>
            {project.title}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
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
    return <p className="text-muted-foreground text-sm">No conversation is linked yet.</p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{shell?.title ?? (thread.title || thread.threadId)}</p>
        <p className="text-muted-foreground text-xs">
          Receives your decisions · {thread.host}
          {threadRef !== null && shell === null ? " · not found in this environment" : ""}
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
          Open Conversation
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
  const status = workStatus({
    waitingOnYou: work.waitingOnYou,
    overdue: false,
    status: work.status,
    state: "",
  });
  const phase = currentPhase(work.phases);
  const openCards = work.cards.filter((card) => card.status === "open");
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
          <span className="text-muted-foreground capitalize">{work.kind ?? "work"}</span>
          <TrackerStatusText {...status} />
        </div>
        <h2 className={cn("font-serif", props.density === "page" ? "text-2xl" : "text-lg")}>
          {work.title}
        </h2>
        {work.goal && props.density === "page" ? (
          <p className="text-muted-foreground text-sm">{work.goal}</p>
        ) : null}
        <TrackerProgressBar progress={work.progress} colour={props.domainColour} />
        {work.needsReview ? (
          <TrackerStatusText
            tone="attention"
            label={`Record needs review: ${work.needsReview.reasons.join("; ")}`}
          />
        ) : null}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {props.actions}
          <Button
            size="sm"
            variant="ghost"
            render={<a href={`${hubPage}/overview`} target="_blank" rel="noreferrer" />}
          >
            <ArrowUpRightIcon />
            Open on Hub
          </Button>
        </div>
      </header>

      {work.docs.length > 0 ? (
        <Section title="Docs">
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

      {openCards.length > 0 ? (
        <Section title="Waiting on You">
          <ul className="flex flex-col gap-1.5 text-sm">
            {openCards.map((card) => (
              <li key={card.id} className="flex items-baseline gap-2">
                <span className="text-warning-foreground">Decide:</span>
                <a
                  className="min-w-0 flex-1 underline-offset-4 hover:underline"
                  href={`${hubPage}/decisions`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {card.title}
                </a>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Roadmap">
        {work.phases.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            A task with no phases. Status: {work.status}.
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
                    <span className="shrink-0 font-medium text-primary text-xs">Now</span>
                  ) : null}
                  {/* Strike-through and "Now" carry status; only a wait says something new. */}
                  {item.status === "waiting" ? (
                    <span className="shrink-0 text-warning-foreground text-xs">
                      {phaseStatusLabel(item)}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
        {phase === null && work.phases.length > 0 ? (
          <p className="text-muted-foreground text-sm">Every phase is done.</p>
        ) : null}
      </Section>

      {props.agentActions}

      {props.density === "page" ? (
        <Section title="Conversation">
          <LinkedConversation environmentId={props.environmentId} work={work} />
          <div>
            <LaunchAgentButton environmentId={props.environmentId} work={work} />
          </div>
        </Section>
      ) : null}

      {/* The sidebar judges progress from the roadmap; the run journal lives on the page. */}
      {props.density === "page" && work.briefs.length > 0 ? (
        <Section title="Runs">
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
                    Went wrong: {entry}
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
