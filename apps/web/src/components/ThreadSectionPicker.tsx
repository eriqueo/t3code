import type { ScopedThreadRef } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { readThreadShell } from "../state/entities";
import {
  listThreadSectionNames,
  readThreadSection,
  setThreadSection,
  useThreadSectionPickerStore,
} from "../threadSections";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

/** Picks or names the sidebar section for one thread. Mounted once per layout. */
export function ThreadSectionPicker() {
  const target = useThreadSectionPickerStore((store) => store.target);
  const close = useThreadSectionPickerStore((store) => store.close);
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      {target ? (
        <ThreadSectionPickerContent
          key={`${target.environmentId}:${target.threadId}`}
          target={target}
          onDone={close}
        />
      ) : null}
    </Dialog>
  );
}

function ThreadSectionPickerContent(props: { target: ScopedThreadRef; onDone: () => void }) {
  const sections = useClientSettings((s) => s.sidebarThreadSections);
  const sectionNames = listThreadSectionNames(sections);
  const currentSection = readThreadSection(props.target);
  const gt = useGT();
  const [name, setName] = useState("");
  const title = readThreadShell(props.target)?.title ?? gt("this thread");
  const choose = (section: string | null) => {
    setThreadSection(props.target, section);
    props.onDone();
  };
  return (
    <DialogPopup className="max-w-md">
      <DialogHeader>
        <DialogTitle>
          <T>Move to section</T>
        </DialogTitle>
        <DialogDescription>
          {currentSection
            ? gt('"{title}" is in {section}.', { title, section: currentSection })
            : gt('Choose a sidebar section for "{title}".', { title })}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="space-y-3">
          {sectionNames.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {sectionNames.map((section) => (
                <Button
                  key={section}
                  size="sm"
                  variant={section === currentSection ? "secondary" : "outline"}
                  disabled={section === currentSection}
                  onClick={() => choose(section)}
                >
                  {section}
                </Button>
              ))}
            </div>
          ) : null}
          <Input
            autoFocus
            aria-label={gt("New section name")}
            placeholder={gt("New section name")}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && name.trim().length > 0) {
                event.preventDefault();
                choose(name);
              }
            }}
          />
        </div>
      </DialogPanel>
      <DialogFooter>
        {currentSection ? (
          <Button variant="ghost" className="me-auto" onClick={() => choose(null)}>
            <T>Remove from section</T>
          </Button>
        ) : null}
        <Button variant="outline" onClick={props.onDone}>
          <T>Cancel</T>
        </Button>
        <Button disabled={name.trim().length === 0} onClick={() => choose(name)}>
          <T context="verb: move the thread into the section">Move</T>
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}
