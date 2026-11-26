import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, TrackerCard, TrackerWorkDetail } from "@t3tools/contracts";
import { ArrowUpRightIcon } from "lucide-react";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { serverEnvironment } from "~/state/server";
import { errorText } from "~/state/tracker";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  cardStatusLabel,
  decisionCards,
  doneDecidingText,
  trackerCardSeen,
  trackerWhen,
} from "./tracker.logic";

type CardStatus = "open" | "approved" | "rejected" | null;

function CardField(props: { label: string; text: string }) {
  if (props.text === "") return null;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-muted-foreground text-xs uppercase tracking-wide">{props.label}</span>
      <p className="whitespace-pre-wrap text-sm">{props.text}</p>
    </div>
  );
}

/** One card, answered here as on the hub's Decisions tab. Bulk and review cards stay on the hub. */
function DecisionCard(props: {
  environmentId: EnvironmentId;
  work: TrackerWorkDetail;
  card: TrackerCard;
  canWrite: boolean;
}) {
  const { card } = props;
  const answer = useAtomCommand(serverEnvironment.trackerAnswerCard, { reportFailure: false });
  const gt = useGT();
  const resolve = useMessages();
  const [comment, setComment] = useState("");
  const [pending, setPending] = useState(false);
  const question = card.kind === "question";
  const decided = card.status !== "open";

  const submit = async (status: CardStatus) => {
    setPending(true);
    const result = await answer({
      environmentId: props.environmentId,
      input: { workId: props.work.id, card: trackerCardSeen(card), status, comment },
    });
    setPending(false);
    if (result._tag === "Success") {
      setComment("");
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Your answer was not saved"),
        description: errorText(squashAtomCommandFailure(result)),
      });
    }
  };

  const hasText = comment.trim() !== "";
  const busy = pending || !props.canWrite;

  return (
    <article
      className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm"
      data-tracker-card={card.id}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="font-mono text-muted-foreground">{card.id}</span>
        <span className="text-muted-foreground capitalize">{card.kind}</span>
        {card.phase ? <span className="text-muted-foreground">{card.phase}</span> : null}
        <span className={decided ? "text-success-foreground" : "text-warning-foreground"}>
          {cardStatusLabel(card, resolve)}
          {card.decidedAt ? ` · ${trackerWhen(card.decidedAt)}` : ""}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <h4 className="font-medium">{card.title}</h4>
        <p className="whitespace-pre-wrap text-sm">{card.ask}</p>
      </div>
      {decided ? null : (
        <>
          <CardField label={gt("Background")} text={card.context} />
          <CardField
            label={question ? gt("What your answer changes") : gt("If you approve")}
            text={card.plan}
          />
          <CardField label={gt("Risk", { $context: "decision card field" })} text={card.risk} />
        </>
      )}
      {card.recommend ? (
        <p className="text-sm">
          <span className="text-muted-foreground">
            <T>Recommendation:</T>{" "}
          </span>
          <span className="font-medium">{card.recommend}</span>
        </p>
      ) : null}
      {card.comments.length > 0 ? (
        <ul className="flex flex-col gap-1.5 border-border border-l-2 pl-3">
          {card.comments.map((entry) => (
            <li key={`${entry.at ?? ""}\n${entry.text}`} className="text-sm">
              <span className="text-muted-foreground text-xs">
                {entry.at
                  ? gt("You · {at}", { at: trackerWhen(entry.at) })
                  : gt("You", { $context: "author of a comment" })}
              </span>
              <p className="whitespace-pre-wrap">{entry.text}</p>
            </li>
          ))}
        </ul>
      ) : null}
      {card.answerable ? (
        <>
          <Textarea
            size="sm"
            value={comment}
            maxLength={4000}
            onChange={(event) => setComment(event.target.value)}
            placeholder={
              question
                ? gt("Your answer. It goes into the next prompt.")
                : gt("Comment or instruction (optional). It goes into the next prompt.")
            }
            aria-label={
              question
                ? gt("Answer {title}", { title: card.title })
                : gt("Comment on {title}", { title: card.title })
            }
          />
          <div className="flex flex-wrap items-center gap-2">
            {question ? (
              <Button size="sm" disabled={busy || !hasText} onClick={() => void submit(null)}>
                {decided ? (
                  <T>Add to the Answer</T>
                ) : (
                  <T context="verb: answer the question">Answer</T>
                )}
              </Button>
            ) : decided ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void submit("open")}
                >
                  <T>Reopen</T>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !hasText}
                  onClick={() => void submit(null)}
                >
                  <T>Save Comment</T>
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" disabled={busy} onClick={() => void submit("approved")}>
                  <T>Approve</T>
                </Button>
                <Button
                  size="sm"
                  variant="destructive-outline"
                  disabled={busy}
                  onClick={() => void submit("rejected")}
                >
                  <T>Reject</T>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || !hasText}
                  onClick={() => void submit(null)}
                >
                  <T>Comment Only</T>
                </Button>
              </>
            )}
            {pending ? (
              <span className="text-muted-foreground text-xs">
                <T>Saving…</T>
              </span>
            ) : null}
          </div>
        </>
      ) : (
        <div>
          <Button
            size="sm"
            variant="outline"
            render={
              <a
                href={`${props.work.hubUrl}/p/${encodeURIComponent(props.work.id)}/decisions?card=${encodeURIComponent(card.id)}`}
                target="_blank"
                rel="noreferrer"
              />
            }
          >
            <ArrowUpRightIcon />
            <T>Answer on the Hub</T>
          </Button>
          <p className="pt-1 text-muted-foreground text-xs">
            <T>This card has its own review form, which only the hub draws.</T>
          </p>
        </div>
      )}
    </article>
  );
}

/** "Done deciding": the hub queues the saved answers for the linked conversation. */
function DoneDeciding(props: {
  environmentId: EnvironmentId;
  work: TrackerWorkDetail;
  canWrite: boolean;
}) {
  const done = useAtomCommand(serverEnvironment.trackerDoneDeciding, { reportFailure: false });
  const gt = useGT();
  const resolve = useMessages();
  const [pending, setPending] = useState(false);
  const { handoff } = props.work;

  const submit = async () => {
    setPending(true);
    const result = await done({
      environmentId: props.environmentId,
      input: { workId: props.work.id, cards: props.work.cards.map(trackerCardSeen) },
    });
    setPending(false);
    if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Your answers were not sent"),
        description: errorText(squashAtomCommandFailure(result)),
      });
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-muted/40 p-3">
      <p className="min-w-0 flex-1 text-sm" role="status">
        {doneDecidingText(props.work, resolve)}
      </p>
      <Button
        size="sm"
        variant={handoff.waiting ? "outline" : "default"}
        disabled={pending || !props.canWrite || handoff.delivery === "pending"}
        onClick={() => void submit()}
      >
        {pending ? (
          <T>Sending…</T>
        ) : handoff.waiting ? (
          <T>Send Again</T>
        ) : (
          <T>Done Deciding: Wake the Agent</T>
        )}
      </Button>
    </div>
  );
}

/** The Decisions section of the full Tracker page: answer cards and wake the agent, in T3. */
export function TrackerDecisions(props: { environmentId: EnvironmentId; work: TrackerWorkDetail }) {
  const canWrite = useAtomValue(
    serverEnvironment.trackerAnswerCard.permissionAtom(props.environmentId),
  );
  const { open, decided } = decisionCards(props.work.cards);
  if (open.length === 0 && decided.length === 0 && !props.work.handoff.waiting) {
    return (
      <p className="text-muted-foreground text-sm">
        <T>Nothing is waiting on you.</T>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {open.map((card) => (
        <DecisionCard
          key={card.id}
          environmentId={props.environmentId}
          work={props.work}
          card={card}
          canWrite={canWrite}
        />
      ))}
      {decided.length > 0 || props.work.handoff.waiting ? (
        <DoneDeciding environmentId={props.environmentId} work={props.work} canWrite={canWrite} />
      ) : null}
      {decided.map((card) => (
        <DecisionCard
          key={card.id}
          environmentId={props.environmentId}
          work={props.work}
          card={card}
          canWrite={canWrite}
        />
      ))}
    </div>
  );
}
