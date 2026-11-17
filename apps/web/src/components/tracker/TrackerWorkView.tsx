import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, TrackerWorkDetail } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, MessageSquareIcon, PlayIcon } from "lucide-react";
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

  const launch = async (projectId: (typeof projects)[number]["id"]) => {
    setPending(true);
    try {
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
    } finally {
      setPending(false);
    }
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
          <MenuItem key={project.id} onClick={() => void launch(project.id)}>
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
  /** The panel keeps to progress and the next action; the page adds history. */
  density: "panel" | "page";
  actions?: ReactNode;
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
  const latestBrief = work.briefs[0] ?? null;
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
        {work.goal ? <p className="text-muted-foreground text-sm">{work.goal}</p> : null}
        <TrackerProgressBar progress={work.progress} colour={props.domainColour} />
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

      <Section title="Now">
        <ul className="flex flex-col gap-1.5 text-sm">
          <li>
            {phase === null ? (
              work.phases.length === 0 ? (
                <span className="text-muted-foreground">
                  A task with no phases. Status: {work.status}.
                </span>
              ) : (
                "Every phase is done."
              )
            ) : (
              <>
                <span className="font-mono text-muted-foreground text-xs">{phase.id}</span>{" "}
                {phase.title}
                <span className="text-muted-foreground"> · {phaseStatusLabel(phase)}</span>
              </>
            )}
          </li>
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

      <Section title="Conversation">
        <LinkedConversation environmentId={props.environmentId} work={work} />
        <div>
          <LaunchAgentButton environmentId={props.environmentId} work={work} />
        </div>
      </Section>

      {work.phases.length > 0 ? (
        <Section title="Roadmap">
          <ol className="flex flex-col">
            {work.phases.map((item) => (
              <li
                key={item.id}
                className="flex min-h-9 items-center gap-3 px-2 text-sm odd:bg-muted/40"
              >
                <span className="w-8 shrink-0 font-mono text-muted-foreground text-xs">
                  {item.id}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    item.status === "done" && "text-muted-foreground line-through",
                  )}
                >
                  {item.title}
                </span>
                <span className="shrink-0 text-muted-foreground text-xs">
                  {phaseStatusLabel(item)}
                </span>
                <span className="hidden w-20 shrink-0 text-right font-mono text-muted-foreground text-xs tabular-nums sm:block">
                  {item.done ?? item.planned ?? ""}
                </span>
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      {latestBrief ? (
        <Section title={props.density === "page" ? "Runs" : "Latest Run"}>
          <ul className="flex flex-col gap-3">
            {(props.density === "page" ? work.briefs.slice(0, 8) : [latestBrief]).map((brief) => (
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
