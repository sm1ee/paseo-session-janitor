Session janitor archives finished subagents after a quiet period and deletes archived sessions after a retention period. The default is six hours before archiving and three days before deletion. Main sessions are only archived by you. A separate action lets you review and permanently delete a stopped session and its children immediately.

The plugin starts in preview mode. Open Session janitor to review scheduled actions and reasons for keeping sessions, then enable automatic cleanup in its settings. Existing archives get a full retention period when automation is enabled. Cleanup runs every five minutes while the daemon is running, even with the app closed.

Protect a session to exclude it and its children, or postpone cleanup for 24 hours. Active sessions, pending approvals, open session tabs, and known pinned workspaces are excluded. By default, archived subagents are kept until all their parents are archived. Paseo cannot tell whether a parent has finished using a result; the archiving delay is based on inactivity.

Permanent deletion removes Paseo session records and Paseo conversation history. Project files and worktrees stay in place. Provider CLI history may remain. Only Paseo-managed sessions are covered.

Requires Paseo 0.11.4 through 0.11.x. Metadata and cleanup history stay on the daemon machine. The plugin authenticates to its own local daemon and does not send data to an external service. If a separate cleaner is installed, review it before enabling this plugin.
