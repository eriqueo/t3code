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
Conversation**. The hub keeps one link per work item: linking replaces the earlier
conversation as the place your decisions are delivered, and the panel names what it replaces.

## Start an agent

**Launch Agent** on a work item opens a new draft in the project you choose, with the hub's
next prompt in the composer. Nothing starts until you send it.
