import { createFileRoute } from "@tanstack/react-router";

import { TrackerPage } from "../components/tracker/TrackerPage";

export interface TrackerSearch {
  /** The open work item; absent shows the portfolio. */
  work?: string;
  domain?: string;
}

export const Route = createFileRoute("/_chat/tracker")({
  validateSearch: (raw: Record<string, unknown>): TrackerSearch => ({
    ...(typeof raw.work === "string" && raw.work ? { work: raw.work.slice(0, 128) } : {}),
    ...(typeof raw.domain === "string" && raw.domain ? { domain: raw.domain.slice(0, 64) } : {}),
  }),
  component: TrackerPage,
});
