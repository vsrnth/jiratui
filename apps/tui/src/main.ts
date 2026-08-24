import { createCliRenderer, type CliRenderer, type KeyEvent, type PasteEvent } from "@opentui/core";
import { BackendError, JiraDeskBackend } from "./backend";
import { handleKey } from "./input";
import { renderApp } from "./render/app";
import { pasteSecret } from "./secure-input";
import { reduce, initialState, type Action, type RootState } from "./state";
import { parseIssueKey } from "./protocol";

/**
 * OpenTUI owns the terminal lifecycle. This entry point deliberately never
 * calls renderer.start(): createCliRenderer schedules the demand-driven loop.
 */
export async function run(): Promise<void> {
  let renderer: CliRenderer | null = null;
  const backend = new JiraDeskBackend();
  let state: RootState = initialState();
  let dirty = true;
  let quitting = false;
  let dispatch = (action: Action): void => { state = reduce(state, action); dirty = true; };
  let onKey: ((key: KeyEvent) => void) | null = null;
  let onPaste: ((event: PasteEvent) => void) | null = null;
  let onResize: (() => void) | null = null;
  let onThemeMode: ((mode: unknown) => void) | null = null;
  let connectController: AbortController | null = null;
  let refreshController: AbortController | null = null;
  let detailController: AbortController | null = null;
  let pollingTimer: ReturnType<typeof setTimeout> | null = null;
  let pollingFailures = 0;

  const schedulePoll = (delay = 5 * 60_000): void => {
    if (pollingTimer !== null) clearTimeout(pollingTimer);
    pollingTimer = setTimeout(() => {
      if (quitting) return;
      if (state.refreshLoading) {
        schedulePoll(30_000);
        return;
      }
      dispatch({ type: "refresh_start" });
      void refresh(true);
    }, delay);
  };

  const cancelOperations = (): void => {
    connectController?.abort();
    refreshController?.abort();
    detailController?.abort();
  };

  try {
    renderer = await createCliRenderer({ exitOnCtrlC: false, screenMode: "alternate-screen", clearOnShutdown: true, useMouse: false });
    state = initialState({ width: renderer.width, height: renderer.height });
    const draw = (): void => {
      if (!renderer || !dirty) return;
      renderApp(renderer, state);
      dirty = false;
      renderer.requestRender();
    };
    dispatch = (action: Action): void => { state = reduce(state, action); dirty = true; draw(); };
    const quit = (): void => { quitting = true; cancelOperations(); renderer?.destroy(); };

    onKey = (key) => {
      if (key.ctrl && key.name === "c") { quit(); return true; }
      const result = handleKey(state, key);
      state = result.state; dirty = true; draw();
      if (result.command === "persist_updates") { persistUpdates(); return true; }
      if (result.command === "quit") { quit(); return true; }
      if (result.command === "cancel_connect") { connectController?.abort(); connectController = null; return true; }
      if (result.command === "retry_resize") { dispatch({ type: "resize", size: { width: renderer?.width ?? 1, height: renderer?.height ?? 1 } }); return true; }
      if (result.command === "connect") { void connect(); return true; }
      if (result.command === "refresh") { void refresh(); return true; }
      if (result.command === "detail") { void loadDetail(); return true; }
      if (result.command === "focus_search") { return true; }
      if (result.command === "lookup") { dispatch({ type: "set_focus", focus: "Picker" }); dispatch({ type: "set_lookup", value: "" }); dispatch({ type: "message", message: "Enter a complete issue key, then press Enter", kind: "lookup" }); return true; }
      if (result.command === "lookup_submit") { void performLookup(); return true; }
      if (result.command === "forget_login") { void forgetLogin(); return true; }
      return false;
    };
    renderer.keyInput.on("keypress", onKey);
    onPaste = (event) => {
      if (state.phase !== "onboarding" || state.onboarding.field !== "token") return;
      event.preventDefault();
      event.stopPropagation();
      const token = pasteSecret(state.onboarding.token, event.bytes);
      if (token.value === state.onboarding.token.value && token.cursor === state.onboarding.token.cursor) return;
      state = { ...state, onboarding: { ...state.onboarding, token, error: null } };
      dirty = true;
      draw();
    };
    renderer.keyInput.on("paste", onPaste);
    onResize = () => { dispatch({ type: "resize", size: { width: renderer?.width ?? process.stdout.columns ?? 1, height: renderer?.height ?? process.stdout.rows ?? 1 } }); };
    process.on("SIGWINCH", onResize);
    // OpenTUI emits terminal theme changes; manual overrides remain respected by state.
    onThemeMode = (mode: unknown) => { if (mode === "light" || mode === "dark" || mode === "Light" || mode === "Dark") dispatch({ type: "theme_mode", mode: String(mode).toLowerCase() === "light" || mode === "Light" ? "Light" : "Dark" }); };
    renderer.on("theme_mode", onThemeMode);
    renderer.on("resize", onResize);
    draw();
    const bootstrap = await backend.bootstrap();
    if (bootstrap.state === "authenticated") {
      const snapshot = bootstrap.snapshot;
      dispatch({ type: "authenticated", siteLabel: snapshot.siteLabel, identity: identityLabel(snapshot.identity) });
      dispatch({ type: "workspace_snapshot", siteLabel: snapshot.siteLabel, identity: identityLabel(snapshot.identity), issues: snapshot.issues, source: snapshot.source, refreshedAt: snapshot.refreshedAt, generation: state.generations.refresh, updates: snapshot.updates, updatesBaselineEstablished: snapshot.updatesBaselineEstablished });
      if (snapshot.warning) dispatch({ type: "message", message: snapshot.warning, kind: "warning" });
      if (snapshot.source === "cache") {
        dispatch({ type: "refresh_start" });
        void refresh(true);
      } else schedulePoll();
    } else if (bootstrap.warning) {
      dispatch({ type: "onboarding_error", message: bootstrap.warning });
    }
    await new Promise<void>((resolve) => { renderer?.once("destroy", resolve); });
  } finally {
    quitting = true;
    cancelOperations();
    if (pollingTimer !== null) clearTimeout(pollingTimer);
    if (renderer && onKey) renderer.keyInput.off("keypress", onKey);
    if (renderer && onPaste) renderer.keyInput.off("paste", onPaste);
    if (renderer && onThemeMode) renderer.off("theme_mode", onThemeMode);
    if (renderer && onResize) renderer.off("resize", onResize);
    if (onResize) process.off("SIGWINCH", onResize);
    backend.close();
    renderer?.destroy();
  }

  async function connect(): Promise<void> {
    if (state.onboarding.submitting) return;
    const baseUrl = state.onboarding.baseUrl;
    const email = state.onboarding.email;
    let token = state.onboarding.token.value;
    const remember = state.onboarding.remember;
    connectController?.abort();
    dispatch({ type: "onboarding_submit_start" });
    const generation = state.generations.connect;
    // Clear the only renderer-owned secret immediately after submission begins.
    dispatch({ type: "onboarding_submit_clear" });
    if (!baseUrl || !email || !token) { dispatch({ type: "onboarding_error", message: "URL, email, and token are required", generation }); token = ""; return; }
    const controller = new AbortController();
    connectController = controller;
    const isCurrent = (): boolean => !quitting && !controller.signal.aborted && connectController === controller && state.generations.connect === generation;
    try {
      const snapshot = await backend.connect({ baseUrl, email, token, remember }, controller.signal);
      token = "";
      if (!isCurrent()) return;
      dispatch({ type: "authenticated", siteLabel: snapshot.siteLabel, identity: identityLabel(snapshot.identity), generation });
      if (!isCurrent()) return;
      dispatch({ type: "workspace_snapshot", siteLabel: snapshot.siteLabel, identity: identityLabel(snapshot.identity), issues: snapshot.issues, source: snapshot.source, refreshedAt: snapshot.refreshedAt, generation: state.generations.refresh, updates: snapshot.updates, updatesBaselineEstablished: snapshot.updatesBaselineEstablished });
      if (snapshot.warning) dispatch({ type: "message", message: snapshot.warning, kind: "warning" });
      if (snapshot.source === "cache") {
        dispatch({ type: "refresh_start" });
        void refresh(true);
      } else schedulePoll();
    } catch (error) {
      const message = error instanceof BackendError ? error.message : "Connection failed";
      token = "";
      if (!isCurrent()) return;
      dispatch({ type: "onboarding_error", message, generation });
    } finally {
      if (connectController === controller) connectController = null;
    }
  }

  async function refresh(automatic = false): Promise<void> {
    const generation = state.generations.refresh;
    refreshController?.abort();
    const controller = new AbortController();
    refreshController = controller;
    try {
      const snapshot = await backend.refresh(controller.signal);
      if (quitting || controller.signal.aborted) return;
      dispatch({ type: "workspace_snapshot", siteLabel: snapshot.siteLabel, identity: identityLabel(snapshot.identity), issues: snapshot.issues, source: snapshot.source, refreshedAt: snapshot.refreshedAt, generation, updates: snapshot.updates, updatesBaselineEstablished: snapshot.updatesBaselineEstablished });
      pollingFailures = 0;
      schedulePoll();
    } catch (error) {
      if (quitting || controller.signal.aborted) return;
      dispatch({ type: "refresh_error", message: error instanceof Error ? error.message : "Refresh failed", generation });
      const retryable = error instanceof BackendError && ["offline", "upstream", "rate_limited"].includes(error.category);
      if (retryable) {
        pollingFailures += 1;
        schedulePoll(Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, pollingFailures - 1)));
      } else if (!automatic && pollingTimer !== null) {
        clearTimeout(pollingTimer);
        pollingTimer = null;
      }
    }
  }

  async function loadDetail(requestedKey?: string, remote = false): Promise<void> {
    const issueKey = requestedKey ?? state.selectedIssueKey;
    if (!issueKey) { dispatch({ type: "message", message: "Select an issue first", kind: "detail" }); return; }
    dispatch({ type: "set_focus", focus: "Detail" }); dispatch({ type: "detail_start", issueKey });
    const generation = state.generations.detail;
    detailController?.abort();
    const controller = new AbortController();
    detailController = controller;
    try {
      const issue = await backend.loadDetail(issueKey, remote, controller.signal);
      if (quitting || controller.signal.aborted) return;
      dispatch({ type: "detail_result", issue, issueKey, generation });
    } catch (error) {
      if (quitting || controller.signal.aborted) return;
      dispatch({ type: "detail_error", message: error instanceof Error ? error.message : "Detail failed", generation });
    }
  }

  async function performLookup(): Promise<void> {
    let key: string;
    try { key = parseIssueKey(state.lookupEditor); }
    catch (error) { dispatch({ type: "message", message: error instanceof Error ? error.message : "Invalid issue key", kind: "lookup" }); return; }
    const localIndex = state.issues.findIndex((issue) => issue.key === key);
    if (localIndex >= 0) {
      if (!state.filteredIssues.some((issue) => issue.key === key)) dispatch({ type: "set_search", value: "" });
      dispatch({ type: "select_issue", index: state.filteredIssues.findIndex((issue) => issue.key === key) });
      await loadDetail(key, false);
    } else {
      await loadDetail(key, true);
    }
  }

  async function forgetLogin(): Promise<void> {
    try {
      await backend.forgetSavedLogin();
      dispatch({ type: "message", message: "Saved login removed; the current session remains connected", kind: "success" });
    } catch (error) {
      dispatch({ type: "message", message: error instanceof Error ? error.message : "Saved login could not be removed", kind: "error" });
    }
  }

  function persistUpdates(): void {
    const ledger = state.updates;
    try {
      dispatch({ type: "updates_persisted", updates: backend.persistUpdateLedger(ledger) });
    } catch (error) {
      const detail = error instanceof BackendError ? error.message.slice(0, 240) : "";
      dispatch({ type: "message", message: detail ? `Updates could not be saved: ${detail}` : "Updates could not be saved; changes remain local", kind: "warning" });
    }
  }
}

function identityLabel(identity: unknown): string {
  if (typeof identity === "string") return identity;
  if (identity && typeof identity === "object" && "displayName" in identity && typeof identity.displayName === "string") return identity.displayName;
  return "Authenticated user";
}

if (import.meta.main) void run();
