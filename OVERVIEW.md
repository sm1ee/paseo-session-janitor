session-janitor archives finished subagents after a quiet period and deletes archived sessions after a retention period. The default is six hours before archiving and three days before deletion. Main sessions are only archived by you. A separate action lets you review and permanently delete a stopped session and its children immediately.

The sidebar shortcut appears on desktop and web. In the iOS and Android apps, open the screen from the Command Center.

The plugin starts in preview mode. Open session-janitor to review scheduled actions and reasons for keeping sessions, then enable automatic cleanup in its settings. Existing archives get a full retention period when automation is enabled. Cleanup runs every five minutes while the daemon is running, even with the app closed.

Protect a session to exclude it and its children, or postpone cleanup for 24 hours. Active sessions, pending approvals, open session tabs, and known pinned workspaces are excluded. The paired session-recovery plugin also protects pending recovery and its descendants. By default, archived subagents are kept until all their parents are archived. Paseo cannot tell whether a parent has finished using a result; the archiving delay is based on inactivity.

Idle, failed, and closed stored sessions can be checked without starting their provider. A stored running or initializing session stays protected. Finished children remain visible in Paseo's subagent count until their parents are inactive and the quiet period has passed.

Permanent deletion removes Paseo session records and Paseo conversation history. Project files and worktrees stay in place. Provider CLI history may remain. Only Paseo-managed sessions are covered.

Requires stable Paseo 0.11.4 or later. Background workspaces and their sessions are included on 0.12. Metadata and cleanup history stay on the daemon machine. The plugin authenticates to its own local daemon and does not send data to an external service. If a separate cleaner is installed, review it before enabling this plugin.
