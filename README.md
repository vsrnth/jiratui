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

The onboarding form masks the token and can save it in the OS keyring. Alternatively provide the
complete configuration tuple before starting:

```sh
export JIRA_BASE_URL=https://example.atlassian.net
export JIRA_CLOUD_ID=your-cloud-id
export JIRA_SITE_ID=example.atlassian.net
export JIRA_EMAIL=you@example.com
export JIRA_API_TOKEN=...
bun start
```

The default view is `(assignee = currentUser() OR watcher = currentUser())`, ordered by newest
update. Use `/` for local search, `l` for exact-key lookup, `Enter` for detail, `r` to refresh,
`?` for help, and `q` to quit.

Open Settings with `4`; press `f`, then `y`, to remove the saved keychain login without ending the
current Jira session.

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
