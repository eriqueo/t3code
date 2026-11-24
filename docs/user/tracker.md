# Tracker

The Tracker shows the HWC tracker hub's tasks and projects inside T3 Code. The hub owns the
records; T3 Code reads them through its own server and stores no copy.

## Set the hub

The server reads the hub address from `T3CODE_TRACKER_HUB_URL`, then `TRACKER_URL`, and
otherwise uses `http://hwc-work:8765`. Each environment's server calls the hub itself, so a
remote browser needs no route to it.

## Browse work

Open **Tracker** from the sidebar footer or the command palette. Decisions that wait on you
come first, then live work by domain. Open a work item for its progress, roadmap and runs.
Decisions are answered on the hub; the links there open it.

## See a conversation's work

In a conversation, the tracker toggle in the title bar opens the linked work beside the chat.
An unlinked conversation lists active work instead. Pick one, then press **Link This
Conversation**. The linked conversation owns the work, and there is one. Your Link moves
ownership here from the earlier conversation, which then stops receiving your decisions; the
panel names what it replaces. If the hub still refuses, the panel names the conversation that
owns the work.

The **Ask the Agent** buttons send only from the conversation that owns the work. On work with
no conversation (never linked, or released when its conversation was settled) or work another
conversation owns, a press sends nothing and says so: link this conversation first, or open
the owner.

A linked conversation is named after its work, and keeps that name: the server renames it when
the link is made (here or with `tracker-link`) and within a minute of the work being renamed,
and title generation leaves it alone. A conversation whose link moves elsewhere or is released,
or whose work is finished, keeps the name it had.

## Start an agent

**Launch Agent** on a work item takes an optional note and a model (your most recent composer
pick by default), then asks the hub to start the agent in the work's own workspace. The new
conversation becomes the one that receives your decisions, and opens once it exists.

**Start fresh** on a conversation that owns a work item does the same with that conversation's
model, instead of the context handoff. If the hub cannot be reached, nothing starts.
