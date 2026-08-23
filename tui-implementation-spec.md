# Jira Desk terminal UI implementation specification

Status: implementation-ready design for a Rust terminal shell over the current Jira Desk core.

This document describes the contracts that already exist in Jira Desk and a presentation model for
a terminal UI (TUI). It is deliberately written so that a second implementer can build the shell
without reading the GPUI layout code first. `Current contract` means behaviour that is already
implemented and must remain true. `TUI presentation recommendation` means a proposed way to expose
that contract in a terminal; the recommendation is not an excuse to move business rules into the
renderer.

## 1. Purpose, audience, scope, and terminology

The purpose is to make a keyboard-first terminal client for the same Jira Desk workspace. The TUI
must reuse the framework-free domain, application, Jira, HTTP, and SQLite crates. It must not create
a second interpretation of Jira membership, synchronization, writes, rich text limits, or
credential handling.

The audience is an implementer familiar with Rust async applications and terminal rendering, but
not necessarily with GPUI. The target is Linux terminal/TTY Phase 1. The TUI MUST run without a
Wayland compositor, GPUI runtime, window server or graphical display; it may run over SSH or on a
local virtual console. macOS remains outside the current runtime target.

In scope:

- secure onboarding and saved-login startup;
- one authenticated workspace with assigned-or-watched Issues;
- exact-key lookup, local search and status filtering;
- issue detail, comments, ADF text, attachment metadata and explicit downloads;
- Local updates, grouped read state, and Team tracker;
- Settings, JQL scope editing, team identity editing, theme/capability preferences and diagnostics;
- automatic and manual synchronization with cancellation, stale-result protection and honest
  outcomes;
- explicit comment, assignee and workflow-status writes.

Out of scope unless a later decision changes the contract:

- arbitrary Jira issue edits, deletes, attachments mutations, bulk writes or automatic writes;
- opening browser links from the TUI; links remain visibly inert;
- a rich comment editor (comments remain plain text serialized as one Jira ADF paragraph);
- a new local cache format or a second business-rule implementation;
- macOS support, self-hosted Jira, or arbitrary Media Services URL access;
- an unattended terminal screenshot/desktop portal workflow.

Terminology:

- **site**: stable `JiraSiteId`, normally the validated Atlassian hostname and the SQLite partition.
- **Cloud ID**: Atlassian gateway tenant identifier, separate from `JiraSiteId`.
- **account ID**: stable typed Jira identity. Never use it as a display label.
- **user set**: a persisted cache/membership partition. The primary set is scope plus authenticated
  account; the team set is a separate assignee-only partition.
- **snapshot**: one normalized `jira_domain::Issue` value.
- **feed event**: one locally derived `UpdateEvent`; it is not Jira's notification inbox.
- **generation**: monotonically increasing shell request identity used to reject late results.
- **unknown outcome**: a confirmed write may have reached Jira but the client cannot know whether it
  committed. It requires refresh/reconciliation before another attempt.
- **frame**: the complete terminal render for one state at one terminal size and capability set.

## 2. Current architecture and reusable seams

### 2.1 Dependency direction

The existing architecture is intentionally shell-independent:

```text
apps/tui (new terminal adapter) ─┐
apps/gpui (existing desktop adapter) ─┴─> crates/workspace (required shared composition)
                                             │ constructs application services with ports
                                             v
                                      crates/application ───> crates/domain
                                             ^   ^   ^
                         application ports  │   │   │
                                             │   │   │ implemented by adapters
                         crates/jira-http ───┘   │   └── desktop-notifications
                         crates/storage ─────────┘
                         crates/jira: pure JSON/JQL mapper used by jira-http
```

The arrows point inward: adapters implement application ports; the application calls those ports.
`crates/application` MUST NOT depend on `crates/jira-http` or `crates/storage`; those crates depend
on application/domain contracts to implement the ports. `crates/domain` has no HTTP, SQLite,
terminal or UI dependency. `crates/application` has no executor, database, HTTP or UI dependency;
it owns orchestration and ports. `crates/jira` maps JSON/JQL at a pure boundary. `crates/jira-http`
owns the Tokio worker runtime and transport limits. `crates/storage` owns the SQLite worker thread,
schema and transactions. GPUI and the TUI are sibling adapters, not dependencies of one another.

### 2.2 Exact reusable modules and interfaces

| Existing path | Symbols / responsibility | TUI rule |
| --- | --- | --- |
| `crates/domain/src/value.rs` | `AccountId`, `IssueId`, `IssueKey`, `JiraSiteId`, `UserSetId`, `Timestamp` | Use typed values in state and commands; do not pass raw IDs across the shell boundary. |
| `crates/domain/src/issue.rs` | `Issue`, `Status`, `Priority`, `IssueLifecycle`, `IssueField` | Render normalized snapshots; preserve stable issue ID and complete issue key. |
| `crates/domain/src/issue_detail.rs` | `IssueDetailCore`, `IssueDetail`, `IssueComment`, `AttachmentMetadata` | Keep detail/comments in memory; cache only what the existing storage port persists. |
| `crates/domain/src/rich_text.rs` | `RichTextDocument`, `RichBlock`, `RichInline`, `RichMark`, `RichImage`, `RichAttachmentCard` | Render the bounded projection; never parse raw ADF in the TUI. |
| `crates/domain/src/update_event.rs` | `UpdateEvent`, `UpdateKind`, `UpdateReadState`, `NotificationDelivery` | Group by stable issue ID; read state is local. |
| `crates/application/src/ports.rs` | `JiraReadPort`, `JiraCommentWritePort`, `JiraIssueEditPort`, `IssueCachePort`, `IssueEditCachePort`, `UpdateFeedPort`, `UserSetPort`, `NotificationPort`, `Clock`, `ApplicationEventSink` | Construct services with these ports. Do not bypass them from a renderer. |
| `crates/application/src/model.rs` | `SyncRequest`, `SyncMode`, `SyncState`, `SyncCommit`, `IssueFetchRequest`, `IssueDetailRequest`, `IssueLocator`, `IssueListQuery`, `UpdateFeedQuery` | Commands and reducers may mirror these types, but application requests remain authoritative. |
| `crates/application/src/sync.rs` | `SyncService`, `SyncConfig` | Use for baseline, incremental and reconciliation. Its commit is the durable boundary. |
| `crates/application/src/polling.rs` | `DefaultPollingPolicy` | Use the policy; shell owns timer, pause, cancellation and visible status. |
| `crates/application/src/issue_detail.rs` | `IssueDetailService`, `IssueDetailConfig` | Fetch core plus all bounded comment pages; guard selected issue/generation in shell. |
| `crates/application/src/comment.rs` | `CommentService`, `MAX_COMMENT_CHARS`, `MAX_COMMENT_BYTES` | Validate then dispatch exactly one confirmed comment write. |
| `crates/application/src/issue_edit.rs` | `IssueEditService`, `ISSUE_EDIT_CACHE_TTL`, `MAX_ASSIGNABLE_USER_SEARCH_LIMIT`, `MAX_ISSUE_TRANSITIONS` | Read options through service; confirmation and exactly-once writes stay in shell/application boundary. |
| `crates/application/src/issue_media.rs` | `IssueMediaService`, `IssueMediaConfig`, `DEFAULT_MAX_ATTACHMENT_IMAGE_BYTES`, `DEFAULT_MAX_ATTACHMENT_DOWNLOAD_BYTES` | Use for bounded image reads and explicit downloads. |
| `crates/application/src/issue_diff.rs` | `DefaultIssueDiffer`, `enrich_with_changelog` | Never duplicate field-change or generic-fallback logic in the TUI. |
| `crates/application/src/feed.rs` | `UpdateFeedService` | Query/mark local update events through the port. |
| `crates/application/src/user_sets.rs` | `UserSetService` | Preserve set validation and site isolation. |
| `apps/gpui/src/config.rs` | `startup_from_environment`, `live_session_from_manual_configuration`, `ensure_authenticated_user`, `StartupSelection`, `LiveSession` | Extract these into the required `crates/workspace` bootstrap; do not copy credential validation. |
| `apps/gpui/src/credential_store.rs` | `SavedCredentials`, `load_saved_credentials`, `save_credentials`, `delete_saved_credentials` | Move/reuse this keyring adapter in `crates/workspace`; its private token fields and redacted errors are required. |
| `apps/gpui/src/local_data.rs` | `open_store`, `load_preferences`, `save_preferences`, `LocalPreferences`, XDG directory guards | Move/reuse these bounded, atomic local-data interfaces in `crates/workspace`. |
| `apps/gpui/src/live_workspace.rs` | `LiveWorkspace`, `CachedWorkspace`, `RefreshResult`, `lookup_issue`, `fetch_issue_detail`, `refresh`, `refresh_automatically`, `refresh_team`, `mark_read`, `mark_all_read`, write wrappers | Extract this framework-free façade into `crates/workspace`; shells must not call SQLite/Jira directly. |
| `apps/gpui/src/presentation/issues.rs` | `IssueViewModel`, `IssueDetailViewModel`, `CommentViewModel`, `AttachmentViewModel`, `issue_views_for_filter` | Reuse pure presentation mapping or extract to a shared crate. It resolves display names and formats fields. |
| `apps/gpui/src/presentation/updates.rs` | `UpdateGroupViewModel`, `update_groups_for_events`, `describe_update_with_directory` | Reuse grouping and compact generic-activity wording. |
| `apps/gpui/src/presentation/identity.rs` | `IdentityDirectory` | Display names win; fallback is `Unassigned`, `Unknown user`, or `Unknown author`, never an opaque account ID. |
| `apps/gpui/src/presentation/format.rs` | timestamp/date/byte formatting | Extract pure formatters; include local timezone and explicit UTC offset. |
| `apps/gpui/src/team_table.rs` | `TeamTicketRow`, `TeamTicketTableDelegate`, stable row-to-`IssueId` mapping | Reuse row derivation/sort semantics; replace table renderer with list/grid views. |
| `apps/gpui/src/rich_text_view.rs` | bounded renderer constants, `render_rich_text`, image states, inert link treatment | Reuse bounds and projection; create terminal renderer over domain nodes. |
| `apps/gpui/src/dashboard/media.rs` | `sanitized_attachment_filename`, image aggregate limits, portal download flow | Reuse sanitization and limits. The XDG portal is desktop behaviour; see Section 12 for TUI download policy. |
| `apps/gpui/src/diagnostics.rs` | `DiagnosticsSink`, bounded privacy-safe event schema | Reuse or extract sink; no raw strings, URLs, filenames, credentials or bodies. |
| `crates/jira/src/jql.rs` | `scoped_issues_jql`, `enhanced_search_request`, `bulk_changelog_request`, `MAX_ISSUE_IDS` | Generate JQL only through this pure adapter. User scope is 2,000 bytes and cannot contain `ORDER BY`; adapter adds ordering. |
| `crates/jira/src/mapping.rs` | `IssueMapper`, ADF projection and media candidate resolution | Keep transport-neutral mapping and placeholders. |
| `crates/jira-http/src/lib.rs` | `JiraHttpClient`, `JiraHttpConfig`, `ApiTokenCredentials`, read/write port implementations | Keep HTTP, authentication, timeouts, redirects and response caps behind ports. |
| `crates/storage/src/sqlite.rs` | `SqliteStore`, `commit_sync`, feed/membership/edit cache persistence | Keep the worker-thread adapter and transaction semantics. |
| `crates/desktop-notifications/src/lib.rs` | Freedesktop best-effort `NotificationPort` | MAY be wired to the TUI; accepted means daemon accepted, not that a banner was rendered. |

The existing `apps/gpui/src/app_shell.rs` and `dashboard.rs` are useful behavioural references but
must not become TUI dependencies merely to get state. The current GPUI `Dashboard` state fields
(`detail_generation`, `remote_lookup_generation`, `comment_generation`, `issue_edit_generation`,
`attachment_download_generation`, cancellation tokens and task handles) are the geometry and
lifecycle lessons to preserve in a shell-neutral reducer.

### 2.3 Framework-free façade seam

`crates/workspace` is the required shared crate for a releasable TUI. It contains the extracted
framework-free bootstrap/session constructor, credential-store and local-data adapters, the
`LiveWorkspace` façade, and pure presentation/formatting/view-model modules. It owns `Arc` service
instances and exposes public async methods matching the current façade. `apps/gpui` and `apps/tui`
depend on this crate; neither binary may be imported by the other.

`crates/workspace` composes application services and injects implementations of
`JiraReadPort`, the dedicated write ports, cache ports and notification ports. It does not
implement those adapter ports and does not contain HTTP, SQLite, or terminal code. The concrete
implementations remain in `crates/jira-http`, `crates/storage`, and
`crates/desktop-notifications`.

Direct construction of the same ports from `apps/tui` is permitted only for an unreleasable spike
or a test fixture. It MUST NOT be used by the releasable TUI binary.

## 3. Recommended TUI workspace and dependency rules

Add a workspace member `apps/tui` with a binary crate. A Rust implementation may use crossterm for
terminal lifecycle/input and ratatui (or another deliberately selected renderer) for frame
composition. The renderer is replaceable; domain and application crates are not.

```text
apps/tui/src/
  main.rs              // process boundary and panic-safe terminal restore
  cli.rs               // non-secret flags, --help, --version, optional diagnostics switches
  bootstrap.rs         // env/keyring/manual onboarding and workspace construction
  runtime.rs           // async executor, event loop, task registry and event channel
  state.rs              // RootState, screen state, reducer, generations, command outcomes
  commands.rs          // typed key/action commands and confirmation policy
  events.rs            // input, resize, timer, task result, capability events
  layout.rs            // pure terminal breakpoints and pane allocation
  render/
    mod.rs
    shell.rs
    onboarding.rs
    issues.rs
    detail.rs
    updates.rs
    team.rs
    settings.rs
    rich_text.rs
    widgets.rs
  input.rs             // key decoding, focus, command palette and optional mouse
  terminal.rs          // raw mode, alternate screen, cursor, cleanup
  secure_input.rs      // masked token editor or external secure prompt
  notifications.rs     // in-app events and optional desktop notification adapter
```

Dependency rules:

1. `state`, `commands`, `layout`, and all render modules may depend on domain view values and
   shell-owned state, but never on `jira-http`, `rusqlite`, keyring internals or raw JSON.
2. `bootstrap` may depend on config/keyring/storage adapters and application constructors; it must
   return redacted typed outcomes.
3. `runtime` owns async task spawning and translates completions into typed `events`; tasks never
   mutate terminal widgets directly.
4. `render` is pure with respect to network and persistence. A key handler dispatches a command;
   the reducer decides whether a service call is allowed.
5. The domain and application crates remain free of crossterm, ratatui, OpenTUI, Node, TypeScript,
   GPUI, HTTP and SQLite dependencies.
6. `apps/tui` must not fork JQL, pagination, rich-text parsing, response validation, or write
   retry logic.

Phase 1 extraction is mandatory for a releasable second shell. Before the TUI release, create the
required `crates/workspace` crate described in Section 2.3. It contains the framework-free
bootstrap/session constructor, credential-store adapter, XDG/local-data adapter, `LiveWorkspace`
façade, and pure presentation/formatting/view-model modules. It MUST expose public shell-facing
interfaces and MUST NOT live only in the `apps/gpui` binary. `apps/gpui` and `apps/tui` MUST both
depend on `crates/workspace`; the TUI MUST NOT depend on a binary crate or import GPUI code.
Temporary duplication or a direct `apps/tui` construction of the same ports is not a releasable
Phase 1 architecture.

### Optional OpenTUI/TypeScript alternative

OpenTUI MAY be used as a presentation shell if a TypeScript ecosystem is preferred. It MUST keep
the Rust application/domain core behind a small typed IPC seam (for example a line-delimited JSON
protocol over stdin/stdout or a local Unix socket). TypeScript may own keymaps, focus, layout and
frame rendering; it MUST NOT reimplement sync modes, membership, JQL, ADF parsing, SQLite writes,
credential handling, media limits, or Jira write policy.

The IPC protocol should use versioned tagged messages such as `BootstrapState`, `WorkspaceSnapshot`,
`IssueDetail`, `UpdateGroup`, `TaskProgress`, `TaskOutcome`, and `CommandAccepted`/`CommandRejected`.
IDs and operation generations must be explicit fields. Secrets MUST NOT travel over a shell command
line or be echoed to the TypeScript renderer. OpenTUI's `Input` does not provide the required
password masking; an OpenTUI implementation MUST use a custom secret editor or an external secure
prompt and pass the token only once through the Rust bootstrap boundary. Rust remains the only
process allowed to call Jira or mutate SQLite.

### OpenTUI-specific implementation

This subsection applies only if the optional OpenTUI shell is selected. Bun `>=1.3` is preferred for
the runtime/toolchain. A Node alternative MUST use exactly Node `26.4`, ESM modules and experimental
FFI only behind a small, tested native bridge; do not silently target an arbitrary Node version.

The OpenTUI process MUST:

- enter the alternate screen and restore it in `finally`, including when IPC, rendering or key
  handling throws;
- use demand-driven rendering. State/IPC events, key actions, theme changes and `SIGWINCH` mark a
  frame dirty; an idle loop MUST NOT continuously redraw or spin the CPU;
- treat `theme_mode` as an explicit terminal-renderer event/state (`System` is the default). The
  terminal/OpenTUI renderer detects the system palette and emits `theme_mode`; the TypeScript shell
  subscribes and updates its `System` palette. Rust IPC MUST NOT be described as the source of
  terminal theme detection. A manual `Light`/`Dark` override ignores detected theme changes for
  palette selection until `System` is reselected, while retaining the latest detected mode so that
  reselecting `System` is immediate;
- handle `SIGWINCH` by querying current cell dimensions, dispatching a typed resize event, clamping
  scroll/focus and rebuilding layout. It MUST not assume pixel dimensions;
- specify flex geometry in terminal cells. Every list/detail child needs an explicit bounded width,
  `minWidth`/`flexShrink` policy, and a test at the 79/80 and 119/120 boundaries. The issue-key
  field MUST have `flexShrink: 0`; summary yields space first. A flex child with intrinsic text
  width MUST not force a pane off-screen or collapse the detail pane;
- use `ScrollBox` (or the OpenTUI equivalent) for every independently scrollable issue list, detail,
  comments, updates group, team list and event log. Scroll position belongs to screen state and is
  clamped after resize/result replacement;
- own an explicit focus enum and draw a focus marker. OpenTUI Tab traversal is not automatic for
  this application: key handlers MUST move `Nav`, `Search`, `List`, `Detail`, `Composer`, `Picker`,
  `Settings`, `Help` and `EventLog` focus deliberately, with `Esc` unwinding overlays/editors;
- keep IPC payloads typed/versioned and generation-tagged. The renderer MUST render only accepted
  Rust snapshots/results and MUST drop stale generations;
- use a custom secret editor or external secure prompt. OpenTUI `Input` lacks password masking and
  MUST NOT be used for the API token.

OpenTUI is still a terminal/TTY process: it MUST NOT require GPUI, Wayland, a compositor or a
graphical display. Its terminal capability probe and theme handling must degrade to no-color/ASCII.

## 4. Root application/session state machine

### 4.1 Root states

The reducer state is a tagged state machine, not a collection of booleans that can contradict one
another:

```text
Boot
  -> LoadingSavedCredentials
      -> Onboarding (no saved login / recoverable keyring error)
      -> VerifyingSavedLogin
          -> WorkspaceStarting
              -> CachedReady -> Refreshing -> Ready
              -> StartupError
          -> Onboarding with safe error
      -> FatalLocalError

Ready <-> Onboarding (explicit Forget login / Reconfigure)
Ready -> DetailLoading -> DetailLoaded | DetailError | Ready (selection changed)
Ready -> LookupLoading -> LookupLoaded | LookupError
Ready -> WriteConfirm -> WritePosting -> WriteSucceeded | WriteFailed | UnknownOutcome
```

A root state should include `session_id`, `site_id`, `site_label`, authenticated display identity,
`workspace: Option<WorkspaceHandle>`, current section, focus target, terminal capabilities, theme,
`last_event`, a bounded event log, `active_operation`, `polling`, and per-operation generation IDs.
Each screen stores its own loaded/empty/error data while retaining the last usable data during a
background refresh.

`StartupSelection::Preview` is the no-environment startup path: it checks the keyring and then shows
onboarding when no saved login can be used. It is not a sample dashboard or a separate preview
product state. The workspace startup sequence MUST verify `/myself` before creating the
account-scoped workspace, load preferences, normalize JQL/team values, initialize the user set,
load cached primary and team
partitions without contacting Jira, and only then enable refresh/polling. A missing authenticated
identity MUST NOT fall back to an unrestricted cache.

### 4.2 Task ownership and result guards

The runtime owns a `TaskRegistry` keyed by operation kind (`Startup`, `PrimaryRefresh`,
`TeamRefresh`, `IssueDetail`, `ExactLookup`, `Comments`, `Image`, `Download`, `EditOptions`,
`CommentWrite`, `AssigneeWrite`, `TransitionWrite`, `SettingsSave`, `NotificationTest`). Each entry
contains cancellation token, generation, target issue/user-set identity, and join handle.

Before starting a replaceable operation:

1. increment the operation generation;
2. cancel and remove the previous token for the same key;
3. capture the target IDs and current session ID;
4. set the screen state to loading while retaining stale data only if the UI labels it stale;
5. spawn one async task and emit progress/results through a channel.

When a result arrives, the reducer MUST apply it only if session ID, generation, selected issue,
user-set, and operation kind all still match. Otherwise it is dropped as stale and never clears a
newer loading/error state. Cancellation is cooperative through `CancellationToken`; cancellation
is not a failure toast. A selection change cancels detail, image and edit-option tasks for the old
issue. A workspace switch cancels every task.

### 4.3 Polling scheduler

The shell owns the timer; `DefaultPollingPolicy` owns the delay calculation. After success, the
normal delay is 5 minutes. Offline/upstream failures back off from 30 seconds, doubling per
consecutive failure and capping at 15 minutes. Rate limits use `Retry-After` clamped to 30 seconds
through 60 minutes, or the transient backoff when no header exists. Authentication, authorization,
invalid input, not-found, storage, notification, cancellation, internal and unknown-outcome errors
pause automatic polling until explicit recovery.

The timer MUST not start before workspace initialization succeeds. Manual refresh MUST be allowed
when no write is in flight, MUST cancel/restart no other operation unexpectedly, and MUST publish
one summary even for zero new updates. Polling MUST skip a cycle while a manual refresh or confirmed
write is in progress. Team polling is independent in data partition but follows the same scheduler
and can be paused separately when no team is configured.

### 4.4 Terminal lifecycle

Startup must record terminal dimensions/capabilities, enter alternate screen, enable raw mode, hide
the cursor, install a resize-aware event reader, and render an initial frame. Cleanup MUST run in a
`finally`/RAII guard on normal exit, error, panic and signal: cancel all tasks, restore cursor,
disable raw mode, leave alternate screen, disable mouse/focus reporting if enabled, flush output,
and restore the previous terminal title. Never leave the user's shell in raw mode.

## 5. Configuration, onboarding, keyring, and security

### 5.1 Configuration tuple

The environment bootstrap recognizes the tuple `JIRA_BASE_URL`, `JIRA_CLOUD_ID`, `JIRA_SITE_ID`,
`JIRA_EMAIL`, `JIRA_API_TOKEN`. Zero values means preview/onboarding. A partial tuple is a safe
`Incomplete` error. Complete environment values use the validated site/cloud ID and do not call
`/myself` during synchronous bootstrap; the workspace verifies identity before account-scoped use.

Manual onboarding asks for Jira URL, Atlassian email and scoped token. URL validation is HTTPS
Atlassian Cloud; Cloud ID is discovered, site ID derives from the validated hostname, and `/myself`
verifies the account. The requested token scopes are exactly `read:jira-user`, `read:jira-work`, and
`write:jira-work`; Jira permissions still apply.

The onboarding screen MUST expose these states without secrets: checking keyring, verifying scoped
token, connecting, authenticated, invalid credentials, 401 authentication rejected, 403
authorization denied, Cloud ID unavailable, current user unavailable, storage unavailable, and
secure-save warning. Error text must be safe enough for a shared terminal recording.

### 5.2 Secret handling

The keyring adapter uses Secret Service with service `dev.jiradesk.JiraDesk`, username
`jira-cloud-default-v1`, schema version 1, and a bounded JSON payload. URL is capped at 2 KiB,
email at 320 bytes, token at 4 KiB, and the whole secret at 16 KiB. Fields reject control bytes;
token whitespace is invalid. `SavedCredentials` has private fields, redacted `Debug`, one-way
`into_parts`, and zeroizes on drop.

The TUI token editor MUST mask every entered character, support delete/edit without echoing the
value, and clear the editor after a connection attempt. It MUST NOT pass a token in `argv`, a
process title, a log, a diagnostics record, a clipboard operation, or a shell command. If token is
entered via a command-line helper, the helper MUST be an external secure prompt that disables
echo; ordinary stdin read is not an acceptable secret UI. The token must not enter shell history.
When OpenTUI is chosen, do not use its unmasked `Input`; use a custom secret editor or secure
external prompt as stated in Section 3.

Remember-login is opt-in (current default is enabled). A save failure leaves the session connected
but reports that the user will need to sign in next time. Forget-login deletes only the keyring
entry and leaves the current workspace connected.

### 5.3 Privacy and transport

Use `JiraHttpClient`'s HTTPS-only, no-redirect client, Atlassian API gateway URL validation,
10-second connect timeout, 30-second request timeout, response caps and typed error mapping. Never
log request bodies, Authorization headers, Cloud IDs where unnecessary, raw ADF, comment text,
attachment bytes, filenames, URLs with credentials, or local absolute paths. Stable IDs may be
used in internal state but diagnostics must use bounded classifications.

## 6. Complete screen specifications

Every screen has a title, context line, status line, focus indicator, keyboard help footer, and an
explicit loading/empty/error/success state. The footer may collapse to `? Help · q Quit · r Refresh`
at narrow widths, but all commands remain discoverable through the help screen.

### 6.1 Onboarding

Fields, in order: Jira URL, Atlassian email, scoped API token, Remember securely. `Enter` advances
or submits; `Tab`/`Shift-Tab` moves fields; `Esc` cancels a connection attempt; `Ctrl-g` clears the
token. The screen shows a masked token length, never token content. It explains that the primary
view is assigned-or-watched and that writes are limited to confirmed comments, assignee changes and
status transitions.

On successful connection, switch atomically to WorkspaceStarting and then the shell. On failure,
retain URL/email, clear token, focus token, show safe error, and leave the attempted text only where
it is non-secret.

### 6.2 Global shell and help

The shell has a top line with Jira Desk, site label, authenticated display name, connection/polling
state and theme; a navigation rail/list; main screen; optional right detail pane; and bottom command
footer. `?` opens a searchable command help overlay. Help must list the current context's commands,
confirmation keys, disabled reasons, and whether an action is local-only or contacts Jira.

Global status levels are `info`, `success`, `warning`, `error`, and `unknown`. Keep the last 64
events in an in-app log; show only a one-line toast/status by default and allow `e` to open the log.

### 6.3 Issues screen

The primary Issues screen is one assigned-or-watched list. Header shows issue count, scope label,
`Assigned or watched`, ordering `Updated newest first`, refresh state and current query/filter.
Controls: `/` search summary or key, `Enter` applies local search, `s` status multi-select, `r`
manual refresh, `l` exact-key lookup, `Esc` clears query/selection mode.

Each row MUST display the complete issue key in a non-shrinking field, then status/priority cue,
summary, assignee, and updated timestamp. The domain currently imposes no explicit `IssueKey` length
cap, so the key is an identity anchor and MUST never be replaced by an ellipsis or a fixed-column
slice. At narrow widths, summary and metadata yield space first; if necessary, allocate the
complete key on its own wrapped line above the remaining fields. Preserve the geometry lesson from
the GPUI update feed: a flex/list item must not let summary, timestamp or action columns shrink the
issue ID to zero.

Local filtering is an intersection over retained domain issues. Text matches key or summary;
status selection is an OR over To Do, In Progress, Done and Uncategorized; empty selection means
All. Filtering never triggers Jira or SQLite. A zero-result state must distinguish `No issues loaded
yet`, `No issues match this query`, and `No issues in the assigned-or-watched view`.

### 6.4 Exact-key lookup

**Current contract:** `LiveWorkspace::lookup_issue` uses `IssueLocator::Key` and fetches complete
detail without adding the issue to cache membership. Confirmed comments are permitted for that
loaded remote identity; mark-read and assignment/status editing are not.

**TUI presentation recommendation:**

`l` opens a key editor. Normalize surrounding whitespace, require a valid `IssueKey`, and submit
with `Enter`. First select a local exact key. If absent, call `LiveWorkspace::lookup_issue` with
`IssueLocator::Key`; this fetches complete detail without adding the issue to cache membership.
Show `Looking up IX-123…`, then a remote result, not-found, auth, offline, rate-limit or safe
request-failed outcome. A remote result has a `Remote` badge. Confirmed comments ARE allowed for
the loaded remote issue identity because `create_comment` accepts an `IssueLocator::Key`; mark-read,
assignment and status-transition editing are unavailable because the result is not in the
authenticated cached issue view. A new lookup cancels the previous lookup.

### 6.5 Status/search filters

The status picker is multi-select and displays `All`, one category, or `N statuses`. Options are
To Do, In Progress, Done and Uncategorized. `Space` toggles, `Enter` applies, `Esc` cancels. The
query editor is local and bounded by normal terminal input limits; it must not inject JQL.

### 6.6 Issue detail

Desktop-width terminals show list and detail simultaneously; the selected issue remains selected
while detail loads. Detail header displays complete key, summary, issue type, priority, status,
assignee, reporter, project, parent, labels, due date, created/updated timestamps and lifecycle.
Unknown display identities use safe fallbacks. `b` returns focus to list in single-pane mode.
For a `Remote` exact-key detail, keep confirmed comment creation available for that key; hide local
mark-read and assignment/status controls because it is not in the authenticated cached issue view.

Below fields, render description, comments newest first, and attachment metadata. Comments load via
`IssueDetailService`'s cursor/startAt pagination. The service default is page size 100, at most 1,000
pages and 10,000 comments; a page must not exceed requested size, cursors must advance, and an
ambiguous cursor plus startAt is an error. A detail result is complete only when pagination reaches
the reported total or a valid short page.

Comment actions: `c` opens a plain multiline composer, `Ctrl-Enter` enters confirmation, `y` sends
once, `n`/`Esc` cancels. Enforce 10,000 scalar characters and 64 KiB bytes, reject blank text, and
display both counters near the limit. On success refresh detail/comments (a read, not a write);
on unknown outcome tell the user to refresh comments before retrying.

Assignee: `a` loads cached/fresh assignable candidates, `/` filters display name/account ID locally,
`Enter` selects, then `y` confirms the exact target. `t` loads available transitions
and `y` confirms the exact transition ID/name/target. Assignment and transition options are bounded
to 100; metadata cache freshness is 24 hours. A successful transition invalidates only that issue's
transition cache. Do not allow another write while one is loading, confirming or submitting.

Attachments show filename, type and size. Image placeholders/galleries identify unresolved
candidates as candidates, never as exact document position. `d` on a selected attachment starts an
explicit, bounded download and asks for destination; it never downloads implicitly.

### 6.7 Local updates

The Local updates screen is a local Change ledger. It shows `Unread` and `All` filters, unread count,
grouped ticket cards, issue key/summary, latest timestamp and compact field-change rows. Group by
stable issue ID, retain event order, and show `Other Jira activity · exact field not available from
sync` for generic activity. Show up to three rows initially; `Space` or `o` expands/collapses progressive detail.
`m` toggles the selected group read/unread locally; this is a TUI presentation recommendation
enabled by the existing `UpdateFeedPort::mark_read(read: bool)` contract. The current GPUI shell
only exposes Mark read. `M` marks all displayed events read after a local
confirmation if more than one group is affected. `Enter` opens the issue; this navigation may open a
remote detail only if the issue is no longer in the current view.

Mark-read must validate event IDs against the authenticated issue view. It never contacts Jira and
must not be presented as Jira notification acknowledgement. Timestamps include local timezone and
explicit UTC offset.

### 6.8 Team tracker

Team tracker uses the isolated team user set. Settings accepts up to 100 account IDs or Atlassian
emails, one per line; duplicate stable account IDs collapse deterministically and first input order
wins. Email resolution must produce exactly one active user, otherwise explain zero/multiple matches.

The screen shows only issues whose status category is `In Progress` and whose assignee is one of the
configured team accounts. It does not merge primary cached updates into team rows. Empty team is a
safe local no-op and does not contact Jira. Manual `r` refreshes team; polling may refresh team
separately. At wide terminals, columns are Ticket, Summary, Assignee, Status, Latest update,
Updated, Age and Activity; at narrower widths use a row/card with the complete key and summary
first. Selecting a row maps to stable `IssueId`.

### 6.9 Settings

Settings sections:

1. **Jira scope**: editable expression up to 2,000 bytes, nonblank, no `ORDER BY`. Saving validates
   locally, switches to a scope-fingerprinted user set, runs a refresh, and persists only after that
   refresh commits. On failure, restore the active scope/cache and retain attempted text for repair.
2. **Team members**: multiline account IDs/emails, max 100, control-free and bounded entries;
   resolve emails and save atomically to preferences. Team fetch is assignee-only with the fixed
   `statusCategory = "In Progress"` scope.
3. **Saved login**: show present/absent, forget action, secure-store warning; never show token.
4. **Appearance/capabilities**: System/Light/Dark preference for TUI palette, color mode, mouse
   preference and diagnostics toggle. Theme changes are local and must trigger a frame redraw.
5. **Notifications**: send a test desktop notification through the existing adapter; show accepted
   daemon ID or safe error category and timestamp. No Jira call or database event is created.
6. **Diagnostics**: show enabled/disabled and bounded path category, never raw contents by default.

## 7. Terminal-responsive layout

**Current contract:** the GPUI shell uses `<720` mobile, `720–959` compact, `960–1,199` standard,
and `>=1,200` wide layouts, with constrained list/detail children and a mobile one-pane mode.

**TUI presentation recommendation:** the following cell breakpoints are for the terminal and are
not current GPUI thresholds:

| Terminal columns | Recommended layout |
| --- | --- |
| `< 80` | Single pane. Navigation becomes a compact command bar or `g` menu. Issue list and detail are separate modes. Preserve full issue key; wrap summary. |
| `80–119` | Single main pane with optional one-line context and bottom status. Detail opens over list; `b` returns. Keep key, status and summary before timestamps. |
| `>= 120` | Two columns: issue list (35–44 columns minimum) and detail. Detail never collapses to zero; list owns a bounded minimum. |
| `>= 160` | Full shell: navigation rail, issue list, detail, and optional event/status column. Team tracker may use full table. |

Recommended row geometry:

```text
>=120:  [key: complete available width][status: 10][summary: flex][assignee: 18][updated: 17]
<120:   [key: max-content]
         [status] [summary: wrapped]
```

Exact key width is allocated from the available row width and has no invented maximum; it is
`flex-shrink: 0` and never ellipsized. If the full key cannot share a row with metadata, wrap the
full key onto its own line and allocate the remaining line to status/summary/timestamps. Wrapping,
not truncating identity, is the bounding mechanism. Detail body must have a bounded width and wrap
text; no intrinsic-width child may expand or clip the terminal frame. The right pane has a nonzero
minimum at `>=120`; if there is not enough width, the layout switches to the single-pane
recommendation rather than collapsing list or detail to an unusable sliver.

Minimum supported terminal is 60 columns by 20 rows. Below it, render a centered warning with the
actual size and commands `q Quit` and `Ctrl-l Retry resize`; do not issue network calls solely due
to a tiny terminal. Minimum usable detail width is 40 columns. Height below 8 rows shows only a
status line and a scrollable content warning. On `SIGWINCH`, recompute layout, clamp scroll/focus,
and redraw; never lose selected issue or active editor text.

## 8. Keyboard, focus, and command model

**TUI presentation recommendation:** the TUI is keyboard-first. Mouse support MAY select rows, but
every action must have a key. Decode escape sequences without blocking the async task channel.
Focus is explicit and visible: `Nav`,
`Search`, `List`, `Detail`, `Composer`, `Picker`, `Settings`, `EventLog`, `Help`.

### 8.1 Global commands

| Key | Command | Scope / side effect |
| --- | --- | --- |
| `q` / `Ctrl-c` | quit | Cancel tasks and clean terminal; if an editor is dirty, confirm. |
| `?` | help | Local overlay. |
| `e` | event log | Local overlay; shows safe status events. |
| `1` | Issues | Navigation; cancels incompatible detail/editor focus only. |
| `2` | Local updates | Navigation; data is local. |
| `3` | Team tracker | Navigation; isolated team cache. |
| `4` | Settings | Navigation; no write until explicit save. |
| `g i/u/t/s` | go to screen | Mnemonic navigation alternative. |
| `r` | refresh current data | Jira read for Issues/Team; local reload for Updates/Settings. |
| `Ctrl-l` | redraw/reprobe | Local terminal redraw and capability probe. |
| `Tab`/`Shift-Tab` | next/previous focus | Never triggers a write. |
| `Esc` | back/cancel | Closes overlay/editor/confirmation first, then pane. |
| `Enter` | activate | Selection, apply filter, open issue, or advance onboarding. |
| `Space` | toggle | Checkbox, status option, expansion where shown. |
| `j/k` or arrows | move | Selection/scroll. |
| `Ctrl-d/u`, `PageDown/Up` | page | Scroll focused list/detail. |
| `Home/End` | boundary | Move to first/last item or document boundary. |

### 8.2 Screen commands

| Context | Keys |
| --- | --- |
| Issues | `/` search, `s` statuses, `l` exact key, `r` refresh, `Enter` detail, `x` clear filters |
| Detail | `b` back, `c` comment, `a` assignee, `t` transition, `d` download selected attachment, `r` reload detail |
| Updates | `m` toggle group read/unread (TUI recommendation), `M` mark all, `Space`/`o` expand/collapse, `Enter` open issue, `u` unread/all filter |
| Team | `r` refresh, `Enter` open issue, `s` sort column/order where table mode supports it |
| Settings | `Ctrl-s` validate/save focused setting, `Ctrl-r` reload local preferences, `x` restore active value |
| Pickers | typing filters, arrows move, `Enter` select, `Esc` cancel |
| Write confirmation | `y` dispatch once, `n`/`Esc` cancel; no alternate submit key |

### 8.3 Write lock

While a comment, assignment or transition is loading, confirming or submitting, disable all write
commands and show `Write in progress · Esc cancels before dispatch` or `Waiting for Jira outcome`.
Cancellation before port dispatch is safe. After dispatch starts, Esc may stop waiting/rendering but
MUST NOT cause an automatic retry. Navigation may remain available only if the reducer can preserve
the write outcome and issue identity; safest default is to lock navigation until a definite or
unknown result is displayed.

## 9. Loading, empty, error, success, and unknown-outcome states

**Current contract:** application services expose typed error categories and the desktop shell emits
in-app outcomes for refresh/writes while Freedesktop delivery remains best effort.

**TUI presentation recommendation:**

Each operation state is one of `Idle`, `Loading`, `Loaded`, `Empty`, `Error`, `Cancelled`,
`Succeeded`, `UnknownOutcome`, or `Stale`. A stale cached view may remain visible during loading but
must carry `Refreshing…` and never be mistaken for fresh data.

| State | Required presentation |
| --- | --- |
| Loading local cache | `Opening local cache…` with no false remote-success claim. |
| Loading remote | Spinner/progress text and target (`Refreshing issues…`, `Loading IX-2050…`). |
| Empty initial | Explain next action (`Refresh to check assigned or watched view`). |
| Empty filtered | State filter/search caused zero results and offer `x Clear filters`. |
| Empty team | Explain that no team members are configured; no Jira request. |
| Error | Safe category and recovery (`Authentication`, `Authorization`, `RateLimited`, `Offline`, `Upstream`, `Cancelled`, `InvalidInput`, `NotFound`, `UnknownOutcome`, `Storage`, `Notification`, `Internal`). Never raw transport/body. |
| Cancelled | Quiet status, not red error; preserve prior data. |
| Success | Timestamped summary with issue count, new local update count, loaded feed count, notification accepted/unavailable counts, and sync mode. |
| Unknown outcome | Strong warning: Jira may have accepted the write; refresh before another attempt. Disable retry until reconciliation. |
| Stale result | Drop silently or log bounded `stale result discarded`; never overwrite newer state. |

Use an in-app toast/status event for every manual refresh, explicit write result, settings commit and
desktop notification test. Keep the last 64 safe events in the event log. OS notifications remain
best effort and additive; their acceptance is not proof of visual delivery.

## 10. Domain and application invariants

### 10.1 Centralized source/layer limits

These are current-contract limits, not renderer preferences. The TUI MUST pass requests through the
named layer so a future change has one source of truth. Values shown as `default / validation max`
are intentionally different where the current application allows a larger injected test/config
value while the live façade uses the default.

| Layer / source | Limit | Required TUI interpretation |
| --- | --- | --- |
| `crates/application/src/model.rs::MAX_JQL_SCOPE_LENGTH`, `crates/jira/src/jql.rs` | JQL scope 2,000 bytes; blank rejected; user text MUST NOT contain `ORDER BY` | Validate before saving; adapter adds account clauses and `ORDER BY updated DESC`. |
| `crates/jira/src/jql.rs::AccountId` | account ID 256 bytes; control characters, quotes and backslashes rejected | Stable identity may be broad in the domain, but JQL interpolation is revalidated. |
| `crates/jira/src/jql.rs` | issue ID 255 bytes; control characters, quotes and backslashes rejected | Validate persisted IDs before enhanced-search lookup/changelog requests. |
| `crates/application/src/sync.rs::SyncConfig` | page size default 100; max pages default 1,000 | Do not create an unbounded remote sync loop. |
| `apps/gpui/src/live_workspace.rs` cached load | 1,000 issues per local page; 10,000 cached issues maximum | Reusable façade should retain these bounds; feed is loaded separately. |
| `apps/gpui/src/live_workspace.rs::MAX_FEED_EVENTS` | 500 newest feed events per workspace load/query | Current façade loads one newest bounded set; it does not expose feed pagination. Do not claim existing pagination. |
| `crates/jira-http/src/lib.rs` general JSON reader | 16 MiB response | Applies to normal Jira JSON responses unless a narrower endpoint cap is specified. |
| `crates/jira-http/src/lib.rs` tenant discovery | 8 KiB response | Cloud ID discovery must use the narrow cap. |
| `crates/jira-http/src/lib.rs::JiraCloudId` | 128 bytes, ASCII/path-safe | Reject oversize/unsafe Cloud IDs before endpoint construction. |
| `crates/jira-http/src/lib.rs::MAX_ISSUE_ID_PAGES` | Exact issue-key/ID lookup: 128 pages | `lookup_issue` remains bounded even when Jira returns continuation tokens. |
| `crates/jira-http/src/lib.rs::MAX_CHANGELOG_PAGES` | Bulk changelog: 8 pages | Combine with the 1,000 issue-ID request cap. |
| `crates/jira/src/jql.rs::MAX_ISSUE_IDS` | 1,000 issue IDs per enhanced-search/changelog request | Chunk and deduplicate deterministically. |
| `crates/application/src/issue_detail.rs::IssueDetailConfig` | comment page default 100; validation maximum 1,000; maximum pages default 1,000; maximum comments default 10,000 | The live Jira transport uses comment page size 100; application validation permits injected values up to 1,000. Detail is complete only after bounded pagination. |
| `crates/jira-http/src/lib.rs` comment transport | comment page size 100 | Keep the live transport request at 100 even though `IssueDetailConfig` validates up to 1,000. |
| `crates/application/src/comment.rs` | comment body max 10,000 scalar characters and 64 KiB bytes | Enforce before confirmation/port dispatch. |
| `crates/application/src/sync.rs` | newest 100 comments for mention enrichment; local update excerpt 280 bytes | Scan only the newest 100; never persist an unbounded body excerpt. |
| `crates/application/src/issue_media.rs` | image preview max 8 MiB; requested dimensions max 1,600 x 1,200; explicit download max 64 MiB | Service validates all media requests and response sizes. |
| `apps/gpui/src/dashboard/media.rs` | max 16 image references; 32 MiB aggregate resident image bytes | Candidate gallery and exact images share the aggregate cap but remain distinct projections. |
| `crates/domain/src/issue_detail.rs`, `crates/application/src/issue_media.rs` | attachment ID max 255 bytes | Do not render/use an oversize ID as a fetch handle. |
| `crates/application/src/issue_edit.rs` | assignable-user search max 100; transitions max 100; metadata TTL 24 hours | Cache/reuse options through `IssueEditService`; no unbounded picker. |
| `apps/gpui/src/dashboard.rs` / `apps/gpui/src/local_data.rs` | team members max 100; identifier 320 bytes; display name 255 bytes | Normalize/deduplicate by stable account ID before persistence. |
| `crates/jira/src/mapping.rs` / `crates/domain/src/rich_text.rs` | ADF text 1,000,000 bytes; depth 64; nodes 10,000; link href 2,048 bytes; link title 512 bytes; fallback images 16 | Mapper owns projection; renderer MUST not parse arbitrary raw ADF. |
| `apps/gpui/src/rich_text_view.rs` | render depth 32; nodes 4,096; children 1,024; text 1,000,000 bytes; image label 512 bytes; attachment filename 512 bytes | TUI SHOULD use no larger render budgets. |
| `apps/gpui/src/local_data.rs` | preferences 64 KiB; owner-only file mode 0600 | Use atomic replacement and reject symlink/non-regular destinations. |
| `apps/gpui/src/credential_store.rs` | URL 2 KiB; email 320 bytes; token 4 KiB; payload 16 KiB; schema version 1 | Keyring only; no plaintext persistence. |
| `apps/gpui/src/diagnostics.rs` | active diagnostics 256 KiB plus 256 KiB backup; line 2 KiB; at most 256 once-events | Diagnostics are best effort and privacy-safe. |
| `crates/jira-http/src/lib.rs` | connect timeout 10s; request timeout 30s; no redirects; HTTPS-only | Transport adapter owns these policies. |

The following are current contracts and MUST be preserved:

1. **Assigned-or-watched membership**: primary Jira JQL is `(user scope) AND (assignee IN account OR
   watcher IN account) ORDER BY updated DESC`; user scope is parenthesized and cannot contain
   `ORDER BY`. A watched-only issue must remain visible even when assignee is another user.
2. **Quiet baseline**: the first successful baseline stores snapshots/cursor and emits no update
   events. Later incremental/reconciliation runs emit changes.
3. **Sync modes**: `Baseline` and `Reconciliation` replace membership; `Incremental` preserves
   membership and uses a five-minute overlap from `last_incremental_succeeded_at`.
4. **Atomic commit**: snapshots, membership, deduplicated events and successful cursor advance in
   one `IssueCachePort::commit_sync` transaction. A failed sync records failure best effort and does
   not advance the successful cursor.
5. **Polling**: use the 5-minute success interval and bounded backoff in Section 4.3.
6. **Stable identity**: issue ID, account ID, event ID and user-set ID are the identity keys;
   display names and issue keys are labels/fallbacks. Event associations for repeated event IDs are
   merged, not duplicated.
7. **Changelog**: changed issue IDs are chunked at 1,000; Jira bulk changelog pagination is capped
   at 8 pages. On unsupported/failing enrichment, retain one honest generic `IssueUpdated` fallback
   per affected issue rather than failing an otherwise valid sync (except cancellation/retryable
   sync errors as defined by `SyncService`).
8. **Mentions**: inspect only the newest 100 comments for changed issues, detect direct ADF account
   mentions, deduplicate stable comment events, and do not write to Jira.
9. **Local feed**: group by issue ID, preserve newest-first chronology, compact generic activity,
   and mark read locally only. Mark-read is scoped to the authenticated view.
10. **Detail**: fetch core plus bounded comment pages; detail/comments are remote and memory-only in
    the current cache. Transport pages are 100; application config defaults to 100, validates up to
    1,000, and caps at 1,000 pages/10,000 comments.
11. **Rich text**: render only the supported bounded ADF projection; unsupported nodes show explicit
    placeholders. Links are styled/inert unless a future explicit decision authorizes activation.
12. **Media**: at most 8 MiB per image response, at most 16 image references, 32 MiB aggregate
    resident image bytes. Validate allowlisted cached MIME plus response signature. The original
    content fallback is attempted only when the thumbnail fetch returns `NotFound`; invalid MIME,
    invalid signature, empty, oversized and other failures remain unavailable. The candidate gallery
    projection is separate from exact ADF image resolution.
13. **Downloads**: explicit original attachment downloads are capped at 64 MiB and never automatic,
    retried, or Jira-mutating.
14. **Edit metadata**: assignable-user and transition lists are max 100; cache freshness is 24
    hours; a successful transition invalidates its cached transitions.
15. **Team**: max 100 configured members, deduplicate by stable account ID, isolate team user set,
    fetch assignee-only in-progress issues, and do not broaden desktop notification policy.
16. **Notification policy**: desktop update alerts retain the narrower assigned-only policy; watcher
    mention events are the documented exception. Delivery is best effort.
17. **Diagnostics**: append-only JSONL is privacy-safe and bounded to 256 KiB active plus a 256 KiB
    backup, with bounded line/event counts. Diagnostics failure never prevents startup or rendering.

## 11. Confirmed write state machines and reconciliation

### 11.1 Common rules

Comment creation, assignment and transition each have a dedicated application service/port. A
confirmed action performs cancellation check immediately before exactly one port dispatch. There is
no automatic retry, exponential retry, duplicate suppression based on client guessing, or fallback
write path. Read retries/polling policy MUST NOT be applied to writes.

Every write state records target site, stable issue locator, requested payload summary (not secret or
full comment in diagnostics), confirmation time, generation and dispatch marker:

```text
Idle -> Editing/Choosing -> Confirming -> Dispatching -> Succeeded
                                             |-> DefiniteFailure
                                             |-> UnknownOutcome
```

`Confirming` is the only state that permits `y`. Once `Dispatching` begins, the reducer marks
`dispatched=true` before awaiting the port result. If the task is cancelled after dispatch, outcome
is `UnknownOutcome` unless the port returned a definite cancellation-before-dispatch contract.
Unknown outcome disables the same write until a Jira refresh/detail reconciliation completes.

### 11.2 Comment

Composer validates nonblank, 10,000 scalar chars and 64 KiB bytes. Confirmation shows issue key and
the exact character/byte count; it does not show a full comment in a global event log. The HTTP
adapter serializes the plain text as one safe ADF paragraph. Definite success reloads issue detail;
unknown outcome says `Jira may have accepted this comment. Refresh comments before retrying.`

### 11.3 Assignment

Load candidates from the 24-hour issue-scoped cache; first miss performs one empty bounded Jira
query (max 100), then search filters locally by display name/account ID. Confirmation shows current
assignee and exact new display name; request carries only stable `AccountId` or explicit unassign.
Definite success reloads issue/cache; unknown outcome requires refresh before another assignment.

### 11.4 Transition

Load available transitions (max 100), display target status and transition name/ID, and confirm the
chosen target. On definite success invalidate transition metadata and refresh the issue. On unknown
outcome do not send another transition; refresh Jira and let the user inspect the actual status.

## 12. ADF, rich text, media, and downloads

### 12.1 Text projection

The Jira mapper produces `RichTextDocument` blocks: paragraphs, headings, bullet/ordered lists, code
blocks, block quotes, panels, images, placeholders; inline text, hard breaks, mentions, attachment
cards and placeholders; marks code/emphasis/strong/strike/link. The TUI renderer must preserve block
order and visible semantics:

- headings use a distinct style/underline when color is unavailable;
- bullets use `-` and ordered lists use bounded numeric prefixes;
- quote/panel lines use a left marker (`│` or `|` in ASCII mode);
- code uses a bordered or indented block with no interpretation;
- mentions render label, never account ID;
- links render label plus a visibly inert marker such as `[link]` or the bounded href; do not open;
- unsupported content renders `[unsupported Jira content]`, not a blank region;
- image-only content renders `[image: filename]`/candidate gallery text when terminal graphics are
  unavailable.

Respect the existing rich-text bounds: max plain-text projection 1,000,000 bytes, depth 64, nodes
10,000; GPUI render budgets are max depth 32, max nodes 4,096, max children 1,024 and text bytes
1,000,000. A TUI renderer SHOULD use no larger budgets and SHOULD add a frame-local cell budget.

### 12.2 Terminal capability fallback

Baseline output is Unicode/ANSI text with a monochrome fallback. Detect color depth, Unicode/box
drawing support, and optional image protocols (Kitty/iTerm only if explicitly enabled). Unsupported
graphics always degrade to metadata/placeholder text without another Jira request. A capability
probe must be bounded and cancellable; never emit escape sequences into a redirected log/stdout.

### 12.3 Media and attachment security

**Current contract:** the desktop GPUI adapter uses an XDG portal for explicit download destination
selection; attachment reads are authenticated, bounded and never implicit. **TUI presentation
recommendation:** choose either a secure opened-parent local-path adapter or an XDG portal helper as
specified below; do not inherit desktop path assumptions accidentally.

Use only attachment IDs from the mapped domain model. Never follow arbitrary ADF Media Services URLs
or a URL retained in an attachment payload. Validate configured Jira origin, response MIME, byte
signature, nonempty body, attachment ID and per-operation limits through `IssueMediaService`.
Original-content fallback is permitted only after the thumbnail operation returns `NotFound`;
invalid MIME/signature remains unavailable. Exact ADF image resolution and the bounded candidate
gallery are separate projections and must be labelled accordingly.

The existing desktop path uses an XDG portal for destination selection, sanitizes Jira filename to a
leaf name, writes downloaded bytes in the background after user selection, and never derives the
destination from Jira. This portal behaviour is specifically a GPUI/desktop adapter contract; it is
not automatically available in a terminal.

For a new TUI path, make an explicit product decision. A local-path implementation MUST use a
securely opened parent-directory model (or a platform equivalent), not a check-then-open sequence:

1. Prompt for a destination, strip directory components/control bytes only from the suggested leaf,
   and obtain an opened parent directory handle. Walk/create permitted parent components with
   `openat`/`O_DIRECTORY|O_NOFOLLOW` (or equivalent) so symlinks cannot redirect the operation.
2. Create a randomized temporary leaf with `openat(..., O_CREAT|O_EXCL|O_NOFOLLOW, 0600)` and keep
   the descriptor. Write the bounded bytes through that descriptor, `fsync` it, and verify the
   written byte count.
3. Apply the explicit overwrite policy at finalization. The no-overwrite default MUST use an atomic
   no-replace/no-follow rename (`renameat2(RENAME_NOREPLACE)` or equivalent). An overwrite option
   requires a second confirmation and a platform primitive whose replacement semantics do not
   follow a symlink; otherwise reject it. `fsync` the parent directory after rename.
4. On every error, close descriptors and remove only the temporary leaf through the same parent
   handle. Never resolve a path, check it, close the directory, then reopen it for writing.

If a secure parent handle, no-follow temporary creation, atomic finalization or platform-equivalent
primitive is unavailable, the TUI MUST require the XDG portal helper instead. Do not silently
substitute an arbitrary `~/Downloads` write for the portal without this decision.

## 13. Persistence, XDG, SQLite, keyring, diagnostics, notifications

The local data directory is `$XDG_DATA_HOME/jira-desk`, or `$HOME/.local/share/jira-desk` when the
XDG variable is absent. It contains `jira-desk.sqlite3` and `preferences.json`. Roots must be
absolute; app/state directories reject symlinks/non-directories and are restricted. SQLite is
opened through `SqliteStore` on its worker thread, uses migrations (currently schema version 4),
owner-only database creation, and a five-second busy timeout. The TUI must not open SQLite directly.

Preferences are bounded at 64 KiB, contain JQL scope and normalized team identities only, and are
written via temp file, flush/sync, atomic rename and directory sync. Never place credentials,
comment bodies, attachment bytes or tokens in preferences. Team entries are bounded (identifier 320
bytes, display name 255 bytes) and validated for control characters and unsafe account-ID quoting.

Diagnostics use `$XDG_STATE_HOME/jira-desk/diagnostics.jsonl`, or `$HOME/.local/state/jira-desk`.
Active and backup files are each capped at 256 KiB; event lines are bounded and the schema contains
only enums, bounded ordinals, load tokens, safe result categories and a daemon notification ID.
Diagnostics are best effort and may be disabled when state is unavailable.

The Secret Service keyring is the only saved credential location. TUI diagnostics, panic reports and
event logs MUST redact credentials. On exit, zeroize secret buffers where the chosen terminal/input
library permits it and drop client credentials.

**Current contract:** desktop notifications MAY reuse `crates/desktop-notifications`. A successful
adapter response means the desktop service accepted a notification and may include its bounded ID;
it does not prove that GNOME rendered a banner. Notification failure must never fail sync or block
the TUI.

**TUI presentation recommendation:** expose the same accepted/unavailable result in the status line
and event log, and keep notification delivery additive to the local update ledger. The TUI MAY make
desktop notifications opt-in, but if enabled it must preserve the assigned-only policy and the
watcher mention exception.

## 14. Theme, accessibility, and terminal capabilities

Define semantic palette roles (`foreground`, `muted`, `border`, `selection`, `info`, `success`,
`warning`, `danger`, `unknown`, `key`, `status`, `unread`) and render through roles, not hard-coded
RGB values. `System` is the default. A TUI cannot rely on a universal terminal theme API, so probe
`COLORTERM`/`TERM`, optional `COLORFGBG`, and an explicitly opt-in OSC 11 foreground/background
query. Any OSC query must be time-bounded and disabled when stdout is not a terminal. Allow manual
Light/Dark/System override. The terminal renderer owns detection and emits a `theme_mode` event;
the shell subscribes and updates the System palette. A manual Light/Dark override ignores detected
changes for palette selection until System is reselected, while retaining the latest detected mode.
A detected theme change (or `Ctrl-l` reprobe) MUST rebuild the palette and redraw when System is
active.

No-color mode (`NO_COLOR` or explicit setting) MUST remove color dependence while preserving meaning
with labels, borders, bold/underline and symbols. Respect terminals without Unicode by using ASCII
fallbacks. Do not use color as the only indicator of unread, error, status or selected focus.

Accessibility requirements: complete issue key in visible text and accessible row label; stable
focus marker; no rapidly flashing spinner; text alternatives for images; explicit action/result
wording; bounded line wrapping; no hidden critical action behind mouse; no raw escape/control bytes
from remote text; support wide glyphs conservatively and avoid splitting UTF-8. Links remain inert
and should be announced as inert if the renderer exposes speech metadata.

## 15. Testing and verification strategy

### 15.1 Pure state/reducer tests

Test reducer transitions without a terminal or executor:

- boot/onboarding/saved-login/startup success/failure;
- generation and cancellation: old detail, lookup, image and refresh results never overwrite newer
  state;
- manual refresh/polling pause/backoff and no duplicate task ownership;
- local text/status filtering and zero-result distinctions;
- exact-key local-first then remote lookup without cache membership;
- issue key remains complete and visible at all layout widths, including keys longer than the normal
  key column;
- grouped updates, unread/all filters, progressive expansion, local-only mark-read;
- write confirmation guard, navigation lock, exactly-once dispatch marker and unknown-outcome lock;
- scope save commits only after refresh; rollback retains attempted text;
- resize preserves selection, editor text, scroll bounds and focus.

### 15.2 Application port/fake tests

Use fakes for every application port and assert request shapes, cancellation checks, no Jira call
for local filters/mark-read/empty team, assigned-or-watched JQL, team assignee-only JQL, baseline
quietness, incremental overlap, reconciliation membership replacement, atomic commit, cursor
failure, changelog 1,000-ID chunks/8-page limit, newest-100 mention calls, detail pagination and
24-hour edit cache. Assert comment/assignment/transition ports are called exactly once and never
retried after unknown outcome. Add boundary tests for every row in Section 10.1: sync 100/1,000,
cached 1,000/10,000, feed 500, JSON 16 MiB, tenant 8 KiB, Cloud ID 128 bytes, lookup 128 pages,
transport comments 100 versus application validation 1,000, detail 1,000 pages/10,000 comments,
attachment 1,600x1,200/255-byte ID, 8 MiB/16/32 MiB media, 64 MiB download, 100 edit options,
100 team members, rich-text/link budgets, 64 KiB preferences, credential bounds and diagnostics.

### 15.3 Renderer and terminal tests

Maintain frame snapshots at at least 60x20, 79x24, 80x24, 119x32, 120x40 and 160x48 under dark,
light, no-color and ASCII capability profiles. Include long keys, long summaries, long timestamps,
unknown identities, empty/error/loading states, detail wrapping, generic updates, 100 team members,
and narrow terminal warning. Golden tests must include an issue key longer than the normal key
column and assert the full issue key appears exactly and is never replaced by ellipsis.

Test `SIGWINCH`/resize at every breakpoint, row/detail pane ownership, scroll clamping, cursor
visibility and terminal cleanup on normal quit, Ctrl-C, panic, task error and broken output. Use a
fake clock and deterministic task event ordering.

### 15.4 Security/integration/acceptance tests

Test no secret in argv/environment-derived logs/event logs, masked input, shell-history-safe
onboarding, keyring schema/bounds/zeroization boundary, XDG relative-root rejection, symlink
rejection, preferences atomic replacement, database owner-only mode, attachment filename/path
sanitization, no arbitrary URL following, image MIME/signature/8 MiB/32 MiB bounds and 64 MiB
download cap. Run Jira adapter fixtures for ADF, comments, changelog, transition and assignment
errors. Run a live read-only smoke test only with explicit credentials; never use a test that can
write Jira without an explicit confirmation fixture.

The acceptance matrix in Section 17 is the release gate. `cargo fmt --check`, workspace tests,
Clippy with denied `dbg_macro`, `todo` and `unwrap_used`, and a terminal snapshot suite are required.

### OpenTUI test requirements

If OpenTUI is selected, use demand-driven rendering: tests must assert that state changes invalidate
the required frame and idle loops do not spin. Use OpenTUI `createTestRenderer` and frame capture for
deterministic output, `mockInput` for escape/key sequences, and direct keymap tests for focus,
confirmation and `SIGWINCH` actions. Assert that IPC result generations are rejected when stale,
that `ScrollBox` regions clamp after resize, and that `flexShrink: 0` keeps issue keys visible at
boundary widths. Every test that enters raw/alternate terminal state or owns an IPC/task resource
MUST clean it up in `finally`, including failures.

## 16. Implementation phases, compatibility, observability, release, risks

### Phase 1: shared seam and shell skeleton

Extract/rehome framework-free workspace/bootstrap/view-model code. Add `apps/tui` with terminal
guard, reducer, event channel, minimum layout and the real onboarding path (with fake ports only in
tests). Deliver a read-only Issues list/detail vertical slice with a real workspace seam and test
fixtures; `StartupSelection::Preview` remains the no-environment keyring-check/onboarding path and
must not become a sample dashboard.

### Phase 2: live reads and persistence

Wire keyring/config, `JiraHttpClient`, `SqliteStore`, cached startup, primary sync, polling and
local filters. Add exact lookup, detail pagination, ADF text placeholders and local update feed.

### Phase 3: team/settings and rich surfaces

Add isolated Team tracker, JQL scope transaction, team preferences, edit metadata cache, attachment
metadata and explicit-download adapter, terminal capabilities and theme modes.

### Phase 4: confirmed writes and release hardening

Add comment/assignment/transition state machines, unknown-outcome reconciliation, optional desktop
notifications, diagnostics, security tests, resize snapshots and packaging. Keep writes disabled
until the explicit confirmation state, including in no-environment/onboarding mode.

Compatibility rules:

- GPUI and TUI must share SQLite schema, preferences schema, keyring entry and domain/application
  contracts. A user may switch shells without migrating credentials or cache.
- Do not change the meaning of existing preferences to fit terminal keys. Add versioned fields only
  with safe defaults and preserve unknown-field handling policy.
- If view-model extraction changes formatting, retain stable issue keys, update grouping, timestamp
  semantics and identity fallbacks.
- The optional IPC shell must version messages and reject unknown major versions safely.

Observability is bounded and privacy-safe: session start/end, operation category, generation result
category, counts, sync mode, page counts, backoff state and terminal capability class. Never record
raw text or secret-bearing paths. Include a visible `e` event log so terminal users can diagnose
without reading files.

Release/deployment: build a Linux binary/AppImage using the repository's existing packaging policy;
test no-FUSE extraction and required bundled libraries if an AppImage is shipped. Provide a desktop
entry only for the GUI binary; the TUI should be invoked as a terminal command and must not claim a
GUI desktop integration. Document terminal requirements and a safe `--help` path. Keep app version and
User-Agent intentional rather than copying GPUI's name indefinitely.

Risks and open decisions:

- Which Rust renderer (ratatui/crossterm or another) and whether to share a renderer-independent
  text layout crate?
- The exact name and public-module boundaries of the mandatory reusable workspace crate/module;
  extraction itself is not optional for a releasable second shell.
- Whether explicit TUI downloads use a secure local-path policy or invoke the XDG portal helper.
- Whether terminal image protocols are enabled; text fallback is mandatory regardless.
- Whether OSC 11 theme probing is acceptable in the target terminal fleet.
- Whether local primary/team polling should share a single scheduler budget.
- Whether future remote exact-key results should gain mark-read or assignment/status actions. The
  current contract permits confirmed comments for the loaded remote issue identity, while mark-read
  and assignment/status editing remain unavailable because the result is outside the authenticated
  cached issue view; any expansion requires a separate product decision and reconciliation policy.
- Whether the TUI sends desktop notifications by default or offers an opt-in setting.
- Whether comment body text may be retained in a draft after process crash; recommended answer is no.

## 17. Acceptance criteria and source traceability appendix

### 17.1 Acceptance checklist

- [ ] `apps/tui` compiles with no GPUI/HTTP/SQLite dependency in domain/application crates.
- [ ] Terminal is restored after normal quit, panic, Ctrl-C, resize failure and task failure.
- [ ] Onboarding masks token, never writes it to history/logs/argv, uses keyring schema/bounds, and
      reports safe errors.
- [ ] Saved credentials are loaded before onboarding, `/myself` is verified before account-scoped
      cache use, and an invalid saved login falls back safely.
- [ ] Primary list uses assigned-or-watched membership; watcher-only issues are visible.
- [ ] First successful baseline is quiet; incremental/reconciliation and atomic commit semantics are
      preserved.
- [ ] Polling is 5 minutes after success and uses exact bounded backoffs after failures.
- [ ] Search/status filtering is local; exact-key lookup is local-first and cache-membership neutral.
- [ ] Full issue keys remain visible at `<80`, `80–119`, `>=120` and `>=160` column profiles,
      including a key longer than the normal key column; wrapping is allowed, ellipsis is not.
- [ ] At `>=120`, list/detail have nonzero minimum ownership; no child intrinsic width clips frame.
- [ ] Detail pagination validates cursor/startAt progress and enforces page/total bounds.
- [ ] Section 10.1's centralized source/layer limits are covered by application/adapter boundary
      tests, including feed 500 without falsely promising feed pagination.
- [ ] ADF unsupported nodes are visible placeholders; links are inert; image fallback is bounded.
- [ ] Comment composer enforces 10,000 scalar characters/64 KiB and serializes one plain paragraph.
- [ ] Attachment images enforce 8 MiB each/16 refs/32 MiB aggregate; explicit downloads enforce 64
      MiB and explicit destination confirmation.
- [ ] Changelog enrichment caps 1,000 issue IDs per request and 8 pages; mention scan caps newest
      100 comments.
- [ ] Edit metadata cache is 24 hours; assignable users/transitions each cap at 100; team members
      cap at 100.
- [ ] Updates are grouped by stable issue ID; unread/all and local-only mark-read work; generic
      activity uses progressive disclosure.
- [ ] Comment, assignment and transition writes show exact confirmation, dispatch once, lock
      navigation/write controls, never auto-retry, and reconcile unknown outcomes.
- [ ] Team tracker is isolated, assignee-only, in-progress-only, and empty-team is a local no-op.
- [ ] Preferences are bounded/atomic; SQLite/keyring stay behind adapters; diagnostics are bounded
      to active+backup 256 KiB each and contain no secrets.
- [ ] Dark/light/system/no-color and ASCII fallback are tested; detected capability/theme changes
      redraw safely.
- [ ] Snapshots cover 60x20, 79x24, 80x24, 119x32, 120x40, 160x48, loading/empty/error/success/
      unknown states and long keys.
- [ ] Workspace tests, Clippy, formatting, security tests, reducer tests and lifecycle tests pass.

### 17.2 Traceability appendix

The current behaviour is specified in [`docs/architecture.md`](architecture.md), especially its
Runtime flow, Dashboard behavior, responsive presentation, identity/rich content and boundaries
sections. The following source symbols are the implementation anchors:

- Shell bootstrap and appearance: `apps/gpui/src/app_shell.rs::AppShell`,
  `AppearancePreference`, `start_saved_login_check`, `connect`, `render_connection_form`.
- Live façade and lifecycle: `apps/gpui/src/live_workspace.rs::LiveWorkspace`,
  `refresh`, `refresh_automatically`, `refresh_team`, `refresh_team_automatically`,
  `lookup_issue`, `fetch_issue_detail`, `create_comment`, `assign_issue`, `transition_issue`,
  `mark_read`, `mark_all_read`.
- Dashboard state lessons: `apps/gpui/src/dashboard.rs::Dashboard`, `DetailState`,
  `CommentPostState`, `IssueEditState`, `UpdateFilter`, generation/cancellation fields and
  `start_automatic_polling`.
- Domain vocabulary: `crates/domain/src/issue.rs`, `issue_detail.rs`, `rich_text.rs`,
  `update_event.rs`, `value.rs`.
- Application contracts: `crates/application/src/ports.rs` and `model.rs`.
- Synchronization: `crates/application/src/sync.rs::SyncService`,
  `crates/application/src/polling.rs::DefaultPollingPolicy`,
  `crates/application/src/issue_diff.rs::DefaultIssueDiffer`.
- Detail, comments, edits and media: `issue_detail.rs::IssueDetailService`,
  `comment.rs::CommentService`, `issue_edit.rs::IssueEditService`,
  `issue_media.rs::IssueMediaService`.
- JQL and bounded requests: `crates/jira/src/jql.rs::scoped_issues_jql`,
  `enhanced_search_request`, `bulk_changelog_request`.
- Transport security and limits: `crates/jira-http/src/lib.rs::JiraHttpClient`,
  `JiraHttpConfig`, `ApiTokenCredentials`.
- Persistence and diagnostics: `crates/storage/src/sqlite.rs::SqliteStore`,
  `apps/gpui/src/local_data.rs`, `apps/gpui/src/credential_store.rs`,
  `apps/gpui/src/diagnostics.rs`.
- Presentation semantics: `apps/gpui/src/presentation/issues.rs`, `updates.rs`, `identity.rs`,
  `format.rs`, `apps/gpui/src/team_table.rs`, `apps/gpui/src/rich_text_view.rs`,
  `apps/gpui/src/dashboard/media.rs`.

The exact numeric limits in this document intentionally mirror those source contracts. If an
implementation changes a limit, it must first change the application/adapters and tests, then update
this specification; changing only the TUI renderer is not permitted.
