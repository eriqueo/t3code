import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import { compareSidebarUserSections } from "./components/Sidebar.logic";
import { getClientSettings, persistClientSettingsPatch } from "./hooks/useSettings";

/**
 * User-named sidebar sections are a client setting keyed by scoped thread key.
 * The sidebar row menu, the chat header menu, and the move-to-section
 * keybinding all assign through this module.
 */

export function listThreadSectionNames(sections: Readonly<Record<string, string>>): string[] {
  return [...new Set(Object.values(sections))].toSorted(compareSidebarUserSections);
}

export function readThreadSection(threadRef: ScopedThreadRef): string | null {
  return getClientSettings().sidebarThreadSections[scopedThreadKey(threadRef)] ?? null;
}

/** Assigns a thread to a section, or clears it with null or a blank name. */
export function setThreadSection(threadRef: ScopedThreadRef, section: string | null): void {
  const key = scopedThreadKey(threadRef);
  const current = getClientSettings().sidebarThreadSections;
  const name = section?.trim() ?? "";
  if ((current[key] ?? "") === name) return;
  const next = { ...current };
  if (name.length > 0) next[key] = name;
  else delete next[key];
  void persistClientSettingsPatch({ sidebarThreadSections: next });
}

/** Drops assignments for threads that no longer exist. */
export function pruneThreadSections(liveThreadKeys: ReadonlySet<string>): void {
  const current = getClientSettings().sidebarThreadSections;
  const stale = Object.keys(current).filter((key) => !liveThreadKeys.has(key));
  if (stale.length === 0) return;
  const next = { ...current };
  for (const key of stale) delete next[key];
  void persistClientSettingsPatch({ sidebarThreadSections: next });
}

/** Applies a "Move to section" menu choice. Returns false for ids it does not own. */
export function handleThreadSectionMenuAction(threadRef: ScopedThreadRef, id: string): boolean {
  if (id === "section" || id === "section:new") {
    useThreadSectionPickerStore.getState().open(threadRef);
    return true;
  }
  if (id === "section:clear") {
    setThreadSection(threadRef, null);
    return true;
  }
  if (id.startsWith("section:set:")) {
    setThreadSection(threadRef, id.slice("section:set:".length));
    return true;
  }
  return false;
}

interface ThreadSectionPickerStore {
  readonly target: ScopedThreadRef | null;
  readonly open: (threadRef: ScopedThreadRef) => void;
  readonly close: () => void;
}

export const useThreadSectionPickerStore = create<ThreadSectionPickerStore>((set) => ({
  target: null,
  open: (threadRef) => set({ target: threadRef }),
  close: () => set({ target: null }),
}));
