import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import { compareSidebarUserSections } from "./components/Sidebar.logic";
import { getClientSettings, persistClientSettingsUpdate } from "./hooks/useSettings";
import { toastManager } from "./components/ui/toast";

/**
 * User-named sidebar sections are a client setting keyed by scoped thread key.
 * The sidebar row menu, the chat header menu, and the move-to-section
 * keybinding all assign through this module. CRITICAL client preferences stay
 * until explicitly removed: an archived or unavailable shell is not proof of deletion.
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
  const name = section?.trim() ?? "";
  // Derive the edit after hydration and earlier queued writes, so startup
  // defaults cannot replace saved assignments or another pending move.
  void persistClientSettingsUpdate((settings) => {
    const next = { ...settings.sidebarThreadSections };
    if (name.length > 0) next[key] = name;
    else delete next[key];
    return { ...settings, sidebarThreadSections: next };
  }).catch(() => {
    toastManager.add({
      type: "error",
      title: "Section not saved",
      description: "Could not save the section assignment. Try moving the thread again.",
    });
  });
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
