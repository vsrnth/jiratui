# Jira Desk TUI

A keyboard-first, read-only Jira Cloud client built with OpenTUI and TypeScript on Bun 1.4.
Presentation, application policy, bounded Jira transport, ADF projection, and local caching are
separate TypeScript modules in one process.

## Requirements

- Bun 1.4.x
- an Atlassian Cloud API token with `read:jira-user` and `read:jira-work`

## Run

```sh
bun install
bun start
```

The onboarding form masks the token, accepts paste, and can remember the login securely in the OS
keyring. `Ctrl-G` clears the token field, and `Esc` cancels an in-flight connection. Alternatively
provide the complete configuration tuple before starting:

```sh
export JIRA_BASE_URL=https://example.atlassian.net
export JIRA_CLOUD_ID=your-cloud-id
export JIRA_SITE_ID=example.atlassian.net
export JIRA_EMAIL=you@example.com
export JIRA_API_TOKEN=...
bun start
```

The default view is `(assignee = currentUser() OR watcher = currentUser())`, ordered by newest
update. In Issues, use `/` for local search, `s` for the local status filter, `l` for exact-key
lookup, `Enter` for detail, `r` to refresh, `?` for help, and `q` to quit.

Press `2` for Updates. Its `u` (Unread/All), `m` (toggle read), `M` (mark displayed read),
`Space`/`o` (expand), and `r` (local status message) controls do not contact Jira. Updates are
grouped from accepted snapshots with a quiet baseline; the bounded ledger and its read/expanded
state persist account- and site-scoped in the owner-only SQLite workspace cache across sessions.
Jira operations remain read-only, and local mark/read/expand actions never acknowledge Jira
notifications. `Enter` selects an update's issue and opens its existing read-only detail view.

Open Settings with `4`; press `f`, then `y`, to remove the saved keychain login without ending the
current Jira session.

In Settings, select `Jira scope` and press `Space` or `Enter` to edit the workspace JQL. Typing and
paste are supported up to 2,000 UTF-8 bytes. `Ctrl-s` validates and refreshes the candidate scope
before saving it; `Esc` closes the editor or cancels an in-flight save, and `x` restores the active
scope. A failed switch keeps the current workspace active and retains the attempted JQL for repair.

Appearance controls are local previews until explicitly saved: use `j`/`k` (or arrows) to select
`Theme`, `No color`, or `ASCII-only`, then press `Space` or `Enter` to preview a change. Press
`Ctrl-s` to atomically save the draft, `Ctrl-r` to reload saved preferences, or `x` to restore the
active value. `System` follows the detected terminal theme and falls back to Dark when detection is
unavailable. Team member configuration is currently shown as a read-only summary.

Credentials never enter argv, renderer snapshots, diagnostics, or cache files. The custom token
editor is masked and clears its buffer immediately after a connection attempt. On macOS and Linux,
remember login uses Bun's native secrets API; if it is unavailable the session still connects
and displays a safe warning.

### Saved login security

`Remember securely` is enabled by default. Jira Desk stores one schema-versioned credential under
service `dev.jiradesk.JiraDesk` using `Bun.secrets`, which maps to macOS Keychain and Linux
libsecret. The token is never placed in subprocess arguments. SQLite contains normalized issue
summaries only. There is deliberately no plaintext credential fallback, and macOS unrestricted
keychain access is explicitly disabled.

On Linux, a Secret Service implementation such as GNOME Keyring or KWallet must be running. On
macOS, Keychain may request access on first use. Without the platform service, the active session
remains usable but the next run returns to onboarding. Bun's native secrets implementation zeros
its password memory after use; the app additionally minimizes secret copies, clears its editable
token buffer immediately, drops credential references on failure/exit, and never logs or renders
them.
