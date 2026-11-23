import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import { LinkedWorkTitles, linkedWorkTitles, TrackerHub } from "./TrackerHub.ts";

/**
 * Keeps each thread linked to tracked work named after that work. Links and work titles
 * change outside T3 (the `tracker-link` CLI, agents renaming records), so this reads the
 * hub on a timer and after a link made here, not only when T3 makes the link.
 */
export class TrackerThreadTitles extends Context.Service<
  TrackerThreadTitles,
  {
    /** Renames each linked thread whose title differs from its work's. Never fails. */
    readonly sync: Effect.Effect<void>;
  }
>()("t3/tracker/TrackerThreadTitles") {}

const SYNC_INTERVAL = "1 minute";

const make = Effect.gen(function* () {
  const hub = yield* TrackerHub;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const linked = yield* LinkedWorkTitles;
  const random = yield* SecureRandom.SecureRandom;
  const permit = yield* Semaphore.make(1);

  const sync = Effect.gen(function* () {
    // An unreachable hub fails here, so titles and the last known links stay as they are.
    const titles = linkedWorkTitles(yield* hub.portfolio);
    linked.replace(titles);
    const current = yield* threads.getThreadTitles(
      [...titles.keys()].map((id) => ThreadId.make(id)),
    );
    for (const [id, title] of titles) {
      const threadId = ThreadId.make(id);
      const now = current[threadId];
      if (now === undefined || now === title) continue;
      // The same command a rename from the thread header sends.
      yield* threads
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`server:tracker-title:${yield* random.uuidV4()}`),
          threadId,
          title,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("tracker.thread-title.rename-failed", { threadId, cause }),
          ),
        );
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logDebug("tracker.thread-title.sync-skipped", { cause }),
    ),
    permit.withPermits(1),
    Effect.withSpan("TrackerThreadTitles.sync"),
  );

  yield* forkParked(sync.pipe(Effect.repeat(Schedule.spaced(SYNC_INTERVAL))));
  return TrackerThreadTitles.of({ sync });
});

export const layer = Layer.effect(TrackerThreadTitles, make);
