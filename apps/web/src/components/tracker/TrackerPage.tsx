import type { EnvironmentId, TrackerPortfolio } from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";

import { useTrackerEnvironmentId, useTrackerPortfolio, useTrackerWork } from "~/state/tracker";

import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { domainSections, workStatus, type TrackerDomainSection } from "./tracker.logic";
import { domainOf, TrackerHubNotice } from "./TrackerPanel";
import { TrackerProgressBar, TrackerStatusText, TrackerWorkView } from "./TrackerWorkView";

function useTrackerNavigation() {
  const navigate = useNavigate();
  const search = useSearch({ from: "/_chat/tracker" });
  return {
    search,
    openWork: (work: string) => void navigate({ to: "/tracker", search: { ...search, work } }),
    closeWork: () =>
      void navigate({
        to: "/tracker",
        search: search.domain === undefined ? {} : { domain: search.domain },
      }),
    setDomain: (domain: string | null) =>
      void navigate({ to: "/tracker", search: domain === null ? {} : { domain } }),
  };
}

function WaitingOnYou(props: { portfolio: TrackerPortfolio; onOpen: (workId: string) => void }) {
  const items = props.portfolio.attention;
  return (
    <section className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <h2 className="border-border border-b pb-1 font-serif text-lg">Waiting on You</h2>
      {items.length === 0 ? (
        <p className="pt-3 text-muted-foreground text-sm">Nothing needs your decision.</p>
      ) : (
        <ul className="flex flex-col pt-1">
          {items.map((item) => (
            <li
              key={item.key}
              className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-sm sm:min-h-9"
            >
              <span className="min-w-0 flex-1">
                {item.title}
                <span className="text-muted-foreground"> · {item.workTitle}</span>
              </span>
              {item.due ? (
                <span
                  className={
                    item.expired
                      ? "font-mono text-destructive-foreground text-xs tabular-nums"
                      : "font-mono text-muted-foreground text-xs tabular-nums"
                  }
                >
                  {item.expired ? "Expired " : "Due "}
                  {item.due}
                </span>
              ) : null}
              <Button size="xs" variant="outline" onClick={() => props.onOpen(item.workId)}>
                Open
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DomainFilter(props: {
  portfolio: TrackerPortfolio;
  active: string | null;
  onChange: (domain: string | null) => void;
}) {
  const sections = domainSections(props.portfolio, null);
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by domain">
      <Button
        size="xs"
        variant={props.active === null ? "secondary" : "ghost"}
        aria-pressed={props.active === null}
        onClick={() => props.onChange(null)}
      >
        All
      </Button>
      {sections.map((section) => (
        <Button
          key={section.id}
          size="xs"
          variant={props.active === section.id ? "secondary" : "ghost"}
          aria-pressed={props.active === section.id}
          onClick={() => props.onChange(section.id)}
        >
          <span
            aria-hidden
            className="size-2 rounded-full bg-muted-foreground"
            style={section.colour ? { backgroundColor: section.colour } : undefined}
          />
          {section.label}
          <span className="font-mono text-muted-foreground tabular-nums">
            {section.works.length}
          </span>
        </Button>
      ))}
    </div>
  );
}

function DomainSection(props: { section: TrackerDomainSection; onOpen: (workId: string) => void }) {
  const { section } = props;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline gap-3 border-border border-b pb-1">
        <h2
          className="font-serif text-lg"
          style={section.colour ? { color: section.colour } : undefined}
        >
          {section.label}
        </h2>
        <span className="text-muted-foreground text-xs">
          {section.works.length} live
          {section.needYou > 0 ? ` · ${section.needYou} waiting on you` : ""}
        </span>
      </div>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {section.works.map((work) => (
          <li key={work.id}>
            <button
              type="button"
              className="flex h-full min-h-24 w-full flex-col gap-2 rounded-2xl border border-border bg-card p-3 text-left shadow-sm transition-colors duration-100 hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              onClick={() => props.onOpen(work.id)}
            >
              <span className="line-clamp-2 font-medium text-sm">{work.title}</span>
              <TrackerStatusText {...workStatus(work)} />
              <span className="mt-auto block w-full">
                <TrackerProgressBar progress={work.progress} colour={section.colour} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function WorkDetail(props: {
  environmentId: EnvironmentId;
  workId: string;
  portfolio: TrackerPortfolio | null;
  onBack: () => void;
}) {
  const work = useTrackerWork(props.environmentId, props.workId);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button size="sm" variant="ghost" onClick={props.onBack}>
          <ArrowLeftIcon />
          All Work
        </Button>
      </div>
      {work.error ? <TrackerHubNotice error={work.error} stale={work.value !== null} /> : null}
      {work.value && work.value.id === props.workId ? (
        <TrackerWorkView
          environmentId={props.environmentId}
          work={work.value}
          density="page"
          {...domainOf(props.portfolio, work.value.domain)}
        />
      ) : work.loading ? (
        <Skeleton className="h-80 w-full" />
      ) : null}
    </div>
  );
}

export function TrackerPage() {
  const environmentId = useTrackerEnvironmentId();
  const portfolio = useTrackerPortfolio(environmentId);
  const { search, openWork, closeWork, setDomain } = useTrackerNavigation();

  if (environmentId === null) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
        <Empty className="flex-1">
          <EmptyHeader className="max-w-md">
            <EmptyTitle>Tracker is not available here</EmptyTitle>
            <EmptyDescription>
              This environment's server does not serve the tracker. Update it, then reopen this
              page.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </SidebarInset>
    );
  }

  const sections = portfolio.value ? domainSections(portfolio.value, search.domain ?? null) : [];

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 pt-12 pb-10 sm:px-8">
          {search.work === undefined ? (
            <>
              <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <h1 className="font-serif text-3xl">Tracker</h1>
                {portfolio.value ? (
                  <span className="text-muted-foreground text-sm">
                    {portfolio.value.works.filter((work) => work.status === "active").length} live
                    {portfolio.value.liveCap === null
                      ? ""
                      : ` · ${portfolio.value.liveProjects} of ${portfolio.value.liveCap} project slots`}
                  </span>
                ) : null}
              </header>
              {portfolio.error ? (
                <TrackerHubNotice error={portfolio.error} stale={portfolio.value !== null} />
              ) : null}
              {portfolio.value ? (
                <>
                  <WaitingOnYou portfolio={portfolio.value} onOpen={openWork} />
                  <DomainFilter
                    portfolio={portfolio.value}
                    active={search.domain ?? null}
                    onChange={setDomain}
                  />
                  {sections.map((section) => (
                    <DomainSection key={section.id} section={section} onOpen={openWork} />
                  ))}
                  {sections.length === 0 ? (
                    <p className="text-muted-foreground text-sm">No live work in this domain.</p>
                  ) : null}
                </>
              ) : portfolio.loading ? (
                <Skeleton className="h-96 w-full" />
              ) : null}
            </>
          ) : (
            <WorkDetail
              environmentId={environmentId}
              workId={search.work}
              portfolio={portfolio.value}
              onBack={closeWork}
            />
          )}
        </div>
      </div>
    </SidebarInset>
  );
}
