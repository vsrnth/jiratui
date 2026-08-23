# Agent Collaboration Policy

## Model roles

- Use `gpt-5.6-sol` as the primary/root orchestrator.
- Use `gpt-5.6-luna` subagents for implementation and code-writing tasks.
- The Sol orchestrator owns task decomposition, architectural decisions, assignment boundaries,
  integration review, validation, and commits.
- Give each Luna subagent a concrete, bounded task with explicit file or module ownership. Avoid
  overlapping write scopes between agents.
- If `gpt-5.6-luna` is unavailable, tell the user before substituting another model. Do not silently
  change the requested model.

## Working agreement

1. Inspect the relevant code, `tui-implementation-spec.md`, and repository instructions before
   assigning work.
2. Keep domain values and pure Jira/ADF mapping independent of OpenTUI, HTTP clients, SQLite,
   Secret Service, and process concerns. Render modules must not call Jira or mutate the cache.
3. Keep Jira credentials, HTTP, ADF projection, cache access, and read policy behind typed
   TypeScript application ports. Never put secrets in argv, logs, renderer state snapshots, cache,
   or persisted preferences.
4. Delegate independent implementation slices to Luna subagents where parallel work is useful.
5. Have Sol review all resulting diffs for architecture, correctness, security, and unintended
   changes.
6. Run formatting, focused tests, the complete Bun test suite, TypeScript checks, and OpenTUI frame
   tests as appropriate before committing.
7. Support macOS and Linux terminal/TTY environments. The TUI must not require Wayland, a graphical
   display, or a compositor. Saved credentials must use `Bun.secrets` (macOS Keychain/Linux
   libsecret) with no plaintext fallback.
8. Keep all Jira operations read-only. Local cache, preferences, notification state, sync cursors,
   and OS-keyring credentials may be written locally.
9. Keep commits granular and Mitchell-style: each commit should contain one coherent,
   independently reviewable and validated change where practical; use an imperative
   conventional-style subject; avoid unrelated cleanup or mixed milestones; and separate policy or
   documentation-only changes when sensible. Sol is the only agent that creates commits; Luna
   workers must not commit.

## Module ownership

- `apps/tui/src/render`: OpenTUI presentation only. Rendering is pure with respect to network,
  credentials, and persistence.
- `apps/tui/src/state`: reducer, commands, generations, focus, filtering, and operation outcomes.
- `apps/tui/src/backend`: in-process application façade and typed ports. Only this layer coordinates
  Jira transport, cache, native secrets, and snapshots.
- `apps/tui/src/jira`: bounded HTTPS-only Jira Cloud transport plus pure JQL/JSON/ADF mapping.
- `apps/tui/src/storage`: Bun SQLite cache, preferences, and cross-platform `Bun.secrets` adapter.
- `apps/tui/src/domain`: typed identities and normalized, renderer-neutral domain values.

The codebase is TypeScript-only and targets Bun 1.4; do not add Rust, native application cores, or a
second runtime. OpenTUI rendering is demand-driven. State/result generations, explicit focus,
responsive terminal cell geometry, complete issue keys, read-only Jira access, and cleanup in
`finally` are release invariants.
