import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { format as formatSql } from "sql-formatter";
import type { SQLNamespace } from "@codemirror/lang-sql";
import type { AiTask, Environment, ExplainResult, ScriptResult, SessionInfo, StatementResult } from "../../types/backend";
import { api, toError } from "../../lib/ipc";
import { byteToUtf16, formatDuration, pluralize, uid, utf16ToByte } from "../../lib/text";
import { useRestore } from "../../stores/restore";
import { confirmAction, notify, notifyError, promptText } from "../../stores/ui";
import { useSettings } from "../../stores/settings";
import { useWorkspaces, type QueryTab as QueryTabModel, type Workspace } from "../../stores/workspaces";
import { EnvBadge } from "../../components/EnvBadge";
import { ParametersDialog, type ParameterValues } from "./ParametersDialog";
import { useSnippets } from "../../stores/snippets";
import { ConfirmRunBody, needsName, withNameConfirm } from "../connections/nameConfirm";
import { SqlEditor, type RunMode, type SqlEditorHandle } from "./SqlEditor";
import { ResultsPanel } from "./ResultsPanel";
import { HistoryPanel } from "../query-history/HistoryPanel";
import { ExplainView } from "../explain/ExplainView";
import { connectWithPrompt } from "../connections/connectFlow";
import { useJobProgress } from "../import-export/useJobProgress";
import { AiPanel } from "../ai/AiPanel";
import { queryTarget } from "./queryTarget";
import type { GroupNode } from "../filters/filterModel";
import { isMacPlatform } from "../../app/WindowControls";
import { shortcut } from "../../lib/shortcut";
import { databaseToReopen, formatterLanguage } from "../../lib/dialect";

/** Tables named after FROM/JOIN/UPDATE/INTO, resolved against the default schema. */
export function referencedTables(sql: string, defaultSchema: string): { schema: string; table: string }[] {
  const out: { schema: string; table: string }[] = [];
  const re = /\b(?:from|join|update|into)\s+((?:[`"]?[\w$]+[`"]?\.)?[`"]?[\w$]+[`"]?)/gi;
  for (const m of sql.matchAll(re)) {
    const parts = m[1]!.split(".").map((p) => p.replace(/^[`"]|[`"]$/g, ""));
    const [schema, table] = parts.length === 2 ? [parts[0]!, parts[1]!] : [defaultSchema, parts[0]!];
    if (!out.some((x) => x.schema === schema && x.table === table)) out.push({ schema, table });
  }
  return out;
}

interface Props {
  ws: Workspace;
  tab: QueryTabModel;
  active: boolean;
  /** Reports whether the results hold edits that are not committed. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Opens a table in a new tab filtered to one row (following a foreign key from a result). */
  onOpenTable?: (schema: string, table: string, filter: GroupNode) => void;
}

export function RunButton({ onRun, disabled }: { onRun: () => void; disabled: boolean }) {
  const mod = isMacPlatform() ? "⌘" : "Ctrl";
  return (
    <button className="btn btn-primary btn-run" onClick={onRun} disabled={disabled} title={`Run current statement or selection (${shortcut("Mod+Enter")})`}>
      <Icon name="play_arrow" size={15} /> Run{" "}
      <span className="kbd" aria-hidden>
        {mod} ↵
      </span>
    </button>
  );
}

export function PlanTabs({ onBack }: { onBack: () => void }) {
  return (
    <div className="results-tabs">
      <h2 className="results-title">Plan</h2>
      <button onClick={onBack}>Back to results</button>
    </div>
  );
}

export function QueryToolbarTarget({ target, readOnly, env }: { target: string; readOnly: boolean; env: Environment }) {
  return (
    <>
      {readOnly && (
        <span className="access-pill ro">
          <Icon name="lock" size={13} /> Read-only
        </span>
      )}
      <span className="query-target mono" title="Statements in this tab run here">
        {target}
      </span>
      <EnvBadge env={env} />
    </>
  );
}

/** One query tab: its own editor, its own connection session and its own results. */
export function QueryTab({ ws, tab, active, onDirtyChange, onOpenTable }: Props) {
  const settings = useSettings((s) => s.settings);
  const updateTab = useWorkspaces((s) => s.updateTab);
  const openQuery = useWorkspaces((s) => s.openQuery);
  const loadColumns = useWorkspaces((s) => s.loadColumns);
  // The tab's editor and, when split, a second one beside it; actions use the focused one.
  const left = useRef<SqlEditorHandle>(null);
  const right = useRef<SqlEditorHandle>(null);
  const [pane, setPane] = useState<0 | 1>(0);
  const paneRef = useRef<0 | 1>(0);
  paneRef.current = tab.split ? pane : 0;
  const editorOf = (p: 0 | 1) => (p === 1 ? right : left).current;
  const ed = () => editorOf(paneRef.current);
  const textOf = (p: 0 | 1) => editorOf(p)?.getText() ?? (p === 1 ? (tab.sql2 ?? "") : tab.sql);
  const sessionRef = useRef<SessionInfo | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [running, setRunning] = useState<{ taskId: string; done: number } | null>(null);
  const snippets = useSnippets((s) => s.snippets);
  useEffect(() => {
    if (!useSnippets.getState().loaded) void useSnippets.getState().load().catch(() => undefined);
  }, []);
  const [result, setResult] = useState<ScriptResult | null>(null);
  const [explain, setExplain] = useState<ExplainResult | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);
  const [split, setSplit] = useState(0.45);
  const [hsplit, setHsplit] = useState(0.5);
  const editors = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const [fileTask, setFileTask] = useState<{ id: string; name: string } | null>(null);
  const fileProgress = useJobProgress(fileTask?.id ?? null);
  const resultIds = useRef<string[]>([]);
  const [ai, setAi] = useState<{ task: AiTask } | null>(null);
  const [resultsDirty, setResultsDirty] = useState(false);
  // What produced the current results, so "Run again" repeats exactly that (a selection stays a selection).
  const lastRun = useRef<{ mode: RunMode; target: { sql: string; base: number }; pane: 0 | 1 } | null>(null);
  // Parameter values typed in this tab, offered again on the next run.
  const paramValues = useRef<ParameterValues>({});
  // The dialog's answer: values, "raw" (run as written) or null (cancelled).
  const [paramAsk, setParamAsk] = useState<{ names: string[]; resolve: (v: ParameterValues | "raw" | null) => void } | null>(null);
  const reportDirty = useCallback(
    (d: boolean) => {
      setResultsDirty(d);
      onDirtyChange?.(d);
    },
    [onDirtyChange],
  );
  const aiEnabled = settings["ai.enabled"];

  const lastError = useMemo(() => {
    const failed = result?.statements.find((x) => x.error && x.error.kind !== "cancelled");
    if (!failed?.error) return null;
    const { message, detail } = failed.error;
    return { sql: failed.sql, message: detail ? `${message}\n${detail}` : message };
  }, [result]);

  const allTables = useMemo(
    () =>
      Object.entries(ws.objects).flatMap(([schema, objs]) =>
        objs.filter((o) => o.kind === "table" || o.kind === "view" || o.kind === "materialized_view").map((o) => ({ schema, table: o.name })),
      ),
    [ws.objects],
  );

  // Close this tab's session when the tab goes away.
  useEffect(
    () => () => {
      const s = sessionRef.current;
      if (s) void api.disconnect(s.sessionId);
      if (resultIds.current.length) void api.releaseResults(resultIds.current);
    },
    [],
  );

  const schemaRef = useRef(ws.schema);
  // A production workspace opened read-only: this tab's session is locked the same way.
  const locked = ws.session.writesLocked;
  const lockedRef = useRef(locked);
  const ensureSession = useCallback(async (): Promise<SessionInfo | null> => {
    if (sessionRef.current) return sessionRef.current;
    for (;;) {
      const lockProduction = lockedRef.current;
      const s = await connectWithPrompt(ws.profile, databaseToReopen(ws.session), { lockProduction });
      if (s && lockedRef.current !== lockProduction) {
        // Writes were allowed or taken back while connecting: open it the new way instead.
        void api.disconnect(s.sessionId).catch(() => undefined);
        continue;
      }
      sessionRef.current = s;
      setSession(s);
      // Unqualified names resolve in the schema picked in the sidebar.
      if (s) await api.setDefaultSchema(s.sessionId, schemaRef.current).catch((e) => notifyError(e, "Could not switch schema"));
      return s;
    }
  }, [ws.profile, ws.session]);

  // Writes allowed or taken back: this tab's session opened the other way, so it reconnects on
  // the next run (an open transaction in it is rolled back).
  useEffect(() => {
    if (lockedRef.current === locked) return;
    lockedRef.current = locked;
    const s = sessionRef.current;
    if (!s) return;
    sessionRef.current = null;
    setSession(null);
    void api.disconnect(s.sessionId).catch(() => undefined);
  }, [locked]);

  // Follow later schema changes in the sidebar. Runs through the session lock, so it
  // waits for a running statement instead of overlapping it.
  useEffect(() => {
    if (schemaRef.current === ws.schema) return;
    schemaRef.current = ws.schema;
    const s = sessionRef.current;
    if (s) void api.setDefaultSchema(s.sessionId, ws.schema).catch((e) => notifyError(e, "Could not switch schema"));
  }, [ws.schema]);

  // Schema-aware autocomplete from what the sidebar has already loaded, plus columns of
  // tables the query mentions (fetched once per table and cached on the workspace).
  const completion = useMemo<SQLNamespace>(() => {
    const ns: Record<string, Record<string, string[]>> = {};
    for (const [schema, objs] of Object.entries(ws.objects)) {
      ns[schema] = {};
      for (const o of objs) {
        if (o.kind === "function" || o.kind === "procedure") continue;
        ns[schema]![o.name] = ws.columns[`${schema}.${o.name}`] ?? [];
      }
    }
    return ns as SQLNamespace;
  }, [ws.objects, ws.columns]);

  useEffect(() => {
    const t = setTimeout(() => {
      const wanted = referencedTables(tab.split ? `${tab.sql}\n${tab.sql2 ?? ""}` : tab.sql, ws.schema).filter(
        ({ schema, table }) => ws.columns[`${schema}.${table}`] === undefined && ws.objects[schema]?.some((o) => o.name === table),
      );
      for (const { schema, table } of wanted.slice(0, 5)) void loadColumns(ws.id, schema, table);
    }, 400);
    return () => clearTimeout(t);
  }, [tab.sql, tab.sql2, tab.split, ws.id, ws.schema, ws.columns, ws.objects, loadColumns]);

  const run = async (mode: RunMode, confirmed = false, explicit?: { sql: string; base: number; pane: 0 | 1 }, typed?: string, given?: ParameterValues) => {
    if (running || paramAsk) return;
    const p = explicit?.pane ?? paneRef.current;
    const editor = editorOf(p);
    const text = textOf(p);
    let target: { sql: string; base: number } | undefined = explicit;
    if (!target) {
      const sel = editor?.getSelection();
      if (sel) target = { sql: text.slice(sel.from, sel.to), base: utf16ToByte(text, sel.from) };
      else if (mode === "all") target = { sql: text, base: 0 };
      else {
        const span = await api.statementAtCursor(text, ws.session.dialect, utf16ToByte(text, editor?.getCursor() ?? 0));
        if (!span) return;
        target = { sql: span.sql, base: span.start };
      }
    }
    if (!target.sql.trim()) return;
    // :name placeholders: ask for their values (bound, never written into the SQL).
    let parameters = given;
    if (!parameters) {
      let names: string[] | null;
      try {
        names = (await api.scriptParameters(target.sql, ws.session.dialect)) ?? [];
      } catch (e) {
        notifyError(e, "Could not read the parameters");
        return;
      }
      if (names.length) {
        const asked = names;
        const values = await new Promise<ParameterValues | "raw" | null>((resolve) => setParamAsk({ names: asked, resolve }));
        if (!values) return;
        if (values !== "raw") {
          paramValues.current = { ...paramValues.current, ...values };
          parameters = values;
        }
      }
    }
    if (resultsDirty && !confirmed) {
      const ok = await confirmAction({
        title: "Discard pending result edits?",
        body: "Running again replaces the results, and the edits you have not committed are lost.",
        confirmLabel: "Run and discard",
        danger: true,
      });
      if (!ok) return;
    }

    const s = await ensureSession().catch((e) => {
      notifyError(e, "Could not connect");
      return null;
    });
    if (!s) return;
    editor?.clearError();
    setError(null);
    setExplain(null);
    const taskId = uid();
    setRunning({ taskId, done: 0 });
    try {
      const r = await api.runQuery(s.sessionId, target.sql, {
        taskId,
        confirmed,
        typedConfirmation: typed,
        maxRows: settings["query.maxRows"],
        timeoutSecs: settings["query.timeoutSecs"] > 0 ? settings["query.timeoutSecs"] : undefined,
        baseOffset: target.base,
        largeValueChars: settings["grid.largeValueChars"],
        restoreMaxRows: settings["restore.maxRows"],
        restoreMaxMb: settings["restore.maxMb"],
        parameters,
      });
      if (resultIds.current.length) void api.releaseResults(resultIds.current);
      resultIds.current = r.statements.flatMap((x) => (x.resultId ? [x.resultId] : []));
      lastRun.current = { mode, target, pane: p };
      setResult(r);
      // Any run can add restore points, or settle pending ones (COMMIT, ROLLBACK, MySQL DDL).
      useRestore.getState().bump();
      const failed = r.statements.find((x) => x.error && x.error.kind !== "cancelled");
      if (failed) markError(editor, text, failed);
    } catch (e) {
      const err = toError(e);
      if (err.kind === "confirmation_required") {
        setRunning(null);
        const byName = needsName(err);
        const ok = await confirmAction({
          title: "Confirm execution",
          confirmLabel: "Run anyway",
          danger: true,
          ...(byName ? { typeToConfirm: s.connectionName } : {}),
          body: <ConfirmRunBody session={s} detail={err.detail} />,
        });
        if (ok) return run(mode, true, { ...target, pane: p }, byName ? s.connectionName : undefined, parameters);
        return;
      }
      // Writes are off only until allowed: say where to turn them on.
      setError(err.kind === "policy_violation" && s.writesLocked ? `${err.message} Choose Allow writes in the status bar to change data.` : err.message);
    } finally {
      setRunning(null);
      setHistoryKey((k) => k + 1);
    }
  };

  const markError = (editor: SqlEditorHandle | null, text: string, st: StatementResult) => {
    if (!st.error || !editor) return;
    if (st.error.position !== undefined) {
      const at = byteToUtf16(text, st.error.position);
      const end = text.slice(at).search(/[\s,;()]|$/);
      editor.markError(at, at + Math.max(1, end));
    } else {
      editor.markError(byteToUtf16(text, st.start), byteToUtf16(text, st.end));
    }
  };

  // Live progress while a long script runs.
  useEffect(() => {
    if (!running) return;
    let unlisten: (() => void) | undefined;
    void listen<{ taskId: string }>("query-progress", (e) => {
      if (e.payload.taskId === running.taskId) setRunning((r) => (r ? { ...r, done: r.done + 1 } : r));
    }).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, [running?.taskId, running]);

  const cancel = async () => {
    if (running) await api.cancelQuery(running.taskId).catch((e) => notifyError(e, "Cancel failed"));
  };

  const format = () => {
    const text = ed()?.getText() ?? "";
    try {
      const language = formatterLanguage(ws.session.dialect, ws.profile.driver);
      ed()?.setText(formatSql(text, { language, keywordCase: "upper", tabWidth: 2 }));
    } catch (e) {
      notify(`Could not format: ${(e as Error).message}`, "error");
    }
  };

  const save = async () => {
    if (paneRef.current === 1) return saveSecond();
    const sql = textOf(0);
    let name = tab.title;
    if (!tab.savedQueryId) {
      const n = await promptText({ title: "Save query", label: "Name", initial: tab.title.startsWith("Query ") ? "" : tab.title });
      if (!n) return;
      name = n;
    }
    const id = tab.savedQueryId ?? uid();
    try {
      await api.saveQuery({ id, connectionId: ws.profile.id, name, folder: null, sql, favorite: false });
      updateTab(ws.id, tab.id, { savedQueryId: id, title: name, dirty: false });
      notify(`Saved "${name}"`, "success");
    } catch (e) {
      notifyError(e, "Query was not saved");
    }
  };

  /** The second editor isn't the tab's query: saving it makes a new saved query. */
  const saveSecond = async () => {
    const name = await promptText({ title: "Save query", label: "Name", initial: "" });
    if (!name) return;
    try {
      await api.saveQuery({ id: uid(), connectionId: ws.profile.id, name, folder: null, sql: textOf(1), favorite: false });
      notify(`Saved "${name}"`, "success");
    } catch (e) {
      notifyError(e, "Query was not saved");
    }
  };

  const toggleSplit = () => {
    const open = !tab.split;
    updateTab(ws.id, tab.id, { split: open });
    setPane(open ? 1 : 0);
    setTimeout(() => editorOf(open ? 1 : 0)?.focus(), 0);
  };

  const runExplain = async (analyze = false) => {
    const editor = ed();
    const text = editor?.getText() ?? "";
    const sel = editor?.getSelection();
    let sql = sel ? text.slice(sel.from, sel.to) : "";
    if (!sql) {
      const span = await api.statementAtCursor(text, ws.session.dialect, utf16ToByte(text, editor?.getCursor() ?? 0));
      sql = span?.sql ?? "";
    }
    if (!sql.trim()) return;
    if (((await api.scriptParameters(sql, ws.session.dialect).catch(() => [])) ?? []).length) {
      notify("EXPLAIN can't take parameter values yet. Put values in place of the :name placeholders to see the plan.", "info");
      return;
    }
    const s = await ensureSession();
    if (!s) return;
    try {
      setExplain(await api.explain(s.sessionId, sql, analyze));
    } catch (e) {
      const err = toError(e);
      const byName = needsName(err);
      const ok =
        err.kind === "confirmation_required" &&
        (await confirmAction({
          title: "EXPLAIN ANALYZE runs the statement",
          body: err.detail ?? err.message,
          confirmLabel: "Run it",
          danger: true,
          ...(byName ? { typeToConfirm: s.connectionName } : {}),
        }));
      if (ok) setExplain(await api.explain(s.sessionId, sql, analyze, true, byName ? s.connectionName : undefined).catch((e2) => (notifyError(e2, "Explain failed"), null)));
      else if (err.kind !== "confirmation_required") notifyError(err, "Explain failed");
    }
  };

  const openFile = async () => {
    const path = await openDialog({ multiple: false, filters: [{ name: "SQL", extensions: ["sql", "txt"] }] });
    if (typeof path !== "string") return;
    try {
      const text = await api.readSqlFile(path);
      const p = paneRef.current;
      editorOf(p)?.setText(text);
      if (p === 1) updateTab(ws.id, tab.id, { sql2: text });
      else updateTab(ws.id, tab.id, { title: path.split(/[\\/]/).pop() ?? tab.title, sql: text, dirty: true });
    } catch (e) {
      notifyError(e, "Could not open the file");
    }
  };

  const saveFile = async () => {
    const path = await saveDialog({ defaultPath: `${tab.title.replace(/[^\w.-]+/g, "_")}.sql`, filters: [{ name: "SQL", extensions: ["sql"] }] });
    if (!path) return;
    try {
      await api.writeSqlFile(path, textOf(paneRef.current));
      notify(`Saved ${path}`, "success");
    } catch (e) {
      notifyError(e, "Could not save the file");
    }
  };

  /** Runs a script file (e.g. a dump) without loading it into the editor. */
  const runFile = async () => {
    const path = await openDialog({ multiple: false, filters: [{ name: "SQL", extensions: ["sql"] }] });
    if (typeof path !== "string") return;
    const s = await ensureSession();
    if (!s) return;
    const name = path.split(/[\\/]/).pop() ?? path;
    const ok = await confirmAction({
      title: "Run SQL file?",
      confirmLabel: "Run file",
      danger: true,
      body: (
        <>
          <div className="field-row" style={{ alignItems: "center" }}>
            <EnvBadge env={s.environment} />
            <strong>{s.connectionName}</strong>
            <span className="hint mono">{s.target}</span>
          </div>
          <p style={{ margin: 0 }}>
            Every statement in <span className="mono">{name}</span> will run against this database, in order. A dump can
            create, replace or delete data. Read-only and safety settings still apply, and restore points are kept as in a
            query tab.
          </p>
        </>
      ),
    });
    if (!ok) return;
    const id = uid();
    setFileTask({ id, name });
    try {
      const limits = { maxRows: settings["restore.maxRows"], maxMb: settings["restore.maxMb"] };
      const r = await withNameConfirm(s, (typed) => api.runSqlFile(s.sessionId, path, id, true, typed, limits));
      if (!r) return;
      const kept = r.restorePoints ? `, ${pluralize(r.restorePoints, "restore point")} kept` : "";
      const msg = `${name}: ${r.statementsRun} statements in ${formatDuration(r.durationMs)}${kept}`;
      if (r.failures.length) {
        setError(`${msg}. Stopped at an error: ${r.failures[0]!.error!.message}\n${r.failures[0]!.sql.slice(0, 300)}`);
      } else if (r.cancelled) notify(`${msg} (cancelled)`, "info");
      else notify(msg, "success");
    } catch (e) {
      notifyError(e, "SQL file did not run");
    } finally {
      setFileTask(null);
      setHistoryKey((k) => k + 1);
    }
  };

  const editorFor = (p: 0 | 1) => (
    <SqlEditor
      ref={p === 1 ? right : left}
      value={p === 1 ? (tab.sql2 ?? "") : tab.sql}
      dialect={ws.session.dialect}
      mariadb={ws.profile.driver === "mariadb" || ws.session.server.product === "MariaDB"}
      schema={completion}
      defaultSchema={ws.schema}
      fontSize={settings["editor.fontSize"]}
      wordWrap={settings["editor.wordWrap"]}
      snippets={snippets}
      onChange={(sql) => updateTab(ws.id, tab.id, p === 1 ? { sql2: sql } : { sql, dirty: true })}
      onRun={(m) => void run(m)}
      onFormat={format}
      onSave={() => void save()}
      onExplain={() => void runExplain(false)}
      onSplit={toggleSplit}
    />
  );

  const onDragEditors = (e: React.MouseEvent) => {
    e.preventDefault();
    const box = editors.current?.getBoundingClientRect();
    if (!box) return;
    const move = (ev: MouseEvent) => setHsplit(Math.min(0.85, Math.max(0.15, (ev.clientX - box.left) / box.width)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const onDragSplit = (e: React.MouseEvent) => {
    e.preventDefault();
    const box = container.current?.getBoundingClientRect();
    if (!box) return;
    const move = (ev: MouseEvent) => setSplit(Math.min(0.85, Math.max(0.15, (ev.clientY - box.top) / box.height)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  useEffect(() => {
    if (active) setTimeout(() => (paneRef.current === 1 ? right : left).current?.focus(), 0);
  }, [active]);

  const info = session ?? ws.session;
  return (
    <div className="tab-panel">
      <div className="toolbar" role="toolbar" aria-label="Query tools">
        <RunButton onRun={() => void run("current")} disabled={!!running} />
        <button className="btn" onClick={() => run("all")} disabled={!!running} title={`Run all statements (${shortcut("Mod+Shift+Enter")})`}>
          <Icon name="play_circle" size={14} /> Run all
        </button>
        {running && (
          <button className="btn btn-danger" onClick={cancel} title="Cancel the running statement">
            <Icon name="stop" size={12} /> Cancel
          </button>
        )}
        {running && <span className="meta">Running… {running.done > 0 ? `${running.done} done` : ""}</span>}
        {fileTask && (
          <>
            <span className="meta">
              {fileTask.name}: {fileProgress} statements…
            </span>
            <button className="btn btn-danger" onClick={() => api.cancelQuery(fileTask.id)}>
              <Icon name="stop" size={12} /> Stop
            </button>
          </>
        )}
        <span className="sep" />
        {info.capabilities.explain && (
          <button className="btn btn-ghost" onClick={() => runExplain(false)} title={`Explain plan (${shortcut("Mod+E")})`}>
            <Icon name="speed" size={14} /> Explain
          </button>
        )}
        {info.capabilities.explainAnalyze && (
          <button className="btn btn-ghost" onClick={() => runExplain(true)} title="Run and measure the plan">
            Analyze
          </button>
        )}
        <button className="btn btn-ghost" onClick={format} aria-label="Format SQL" title={`Format (${shortcut("Mod+Shift+F")})`}>
          <Icon name="format_align_left" size={14} /> Format
        </button>
        <button className="btn btn-ghost btn-icon" onClick={save} aria-label="Save query" title={`Save query (${shortcut("Mod+S")})`}>
          <Icon name="save" size={14} />
        </button>
        <button
          className="btn btn-ghost btn-icon"
          aria-pressed={!!tab.split}
          onClick={toggleSplit}
          aria-label="Split editor"
          title={`${tab.split ? "Close the second editor" : "Open a second editor beside this one"} (${shortcut("Mod+\\")})`}
        >
          <Icon name="vertical_split" size={14} />
        </button>
        <span className="sep" />
        <button className="btn btn-ghost btn-icon" onClick={openFile} aria-label="Open SQL file" title="Open a .sql file in this tab">
          <Icon name="folder_open" size={14} />
        </button>
        <button className="btn btn-ghost btn-icon" onClick={saveFile} aria-label="Save to file" title="Save the editor to a .sql file">
          <Icon name="file_save" size={14} />
        </button>
        <button className="btn btn-ghost btn-icon" onClick={runFile} aria-label="Run SQL file" title="Run a .sql file (e.g. a dump)" disabled={!!fileTask}>
          <Icon name="code_blocks" size={14} />
        </button>
        <button className="btn btn-ghost btn-icon" aria-pressed={historyOpen} onClick={() => setHistoryOpen(!historyOpen)} aria-label="Query history" title="History">
          <Icon name="history" size={14} />
        </button>
        {aiEnabled && (
          <button
            className="btn btn-ghost"
            aria-pressed={!!ai}
            onClick={() => setAi(ai ? null : { task: lastError ? "explain_error" : "explain" })}
            title="Explain, fix, improve or write SQL with the AI service set up in Settings. Nothing is sent until you review the request."
          >
            <Icon name="star_shine" size={14} /> Ask AI
          </button>
        )}
        <span className="grow" />
        <QueryToolbarTarget target={queryTarget(info.dialect, ws.profile.driver, info.database, ws.schema, info.target)} readOnly={info.readOnly} env={info.environment} />
      </div>
      <div className="split-h" style={{ minHeight: 0 }}>
        <div ref={container} className="split-v">
          <div ref={editors} className="split-h query-editors" style={{ flex: `0 0 ${split * 100}%`, minHeight: 0 }}>
            <div
              className={tab.split && pane === 0 ? "query-pane focused" : "query-pane"}
              style={tab.split ? { flex: `0 0 ${hsplit * 100}%` } : undefined}
              role="group"
              aria-label={tab.split ? "Left editor" : "Editor"}
              onFocus={() => setPane(0)}
            >
              {editorFor(0)}
            </div>
            {tab.split && (
              <>
                <div className="split-handle-v" role="separator" aria-orientation="vertical" onMouseDown={onDragEditors} />
                <div className={pane === 1 ? "query-pane focused" : "query-pane"} role="group" aria-label="Right editor" onFocus={() => setPane(1)}>
                  {editorFor(1)}
                </div>
              </>
            )}
          </div>
          <div className="split-handle" role="separator" aria-orientation="horizontal" onMouseDown={onDragSplit} />
          {error && (
            <div className="notice notice-error" role="alert" style={{ margin: 8 }}>
              {error}
            </div>
          )}
          {explain && (
            <div className="results">
              <PlanTabs onBack={() => setExplain(null)} />
              <ExplainView result={explain} />
            </div>
          )}
          {/* Hidden, not unmounted, while a plan is shown: pending result edits live in it. */}
          <div style={{ display: explain ? "none" : "contents" }}>
            <ResultsPanel
              result={result}
              running={!!running || !!fileTask}
              dialect={ws.session.dialect}
              session={session ?? undefined}
              onRunAgain={() => lastRun.current && void run(lastRun.current.mode, false, { ...lastRun.current.target, pane: lastRun.current.pane })}
              onDirtyChange={reportDirty}
              onOpenTable={onOpenTable}
            />
          </div>
        </div>
        {historyOpen && (
          <HistoryPanel
            connectionId={ws.profile.id}
            refreshKey={historyKey}
            onInsert={(sql) => ed()?.insertText(sql)}
            onOpen={(sql) => openQuery(ws.id, { sql, title: "From history", dirty: true })}
            onClose={() => setHistoryOpen(false)}
          />
        )}
        {ai && aiEnabled && (
          <AiPanel
            dialect={`${info.server.product} ${info.server.version.split(" ")[0] ?? ""}`.trim()}
            getSql={() => {
              const text = textOf(paneRef.current);
              const sel = ed()?.getSelection();
              return sel ? text.slice(sel.from, sel.to) : text;
            }}
            lastError={lastError}
            referencedTables={(sql) => referencedTables(sql, ws.schema)}
            allTables={allTables}
            columns={ws.columns}
            initialTask={ai.task}
            onInsert={(sql) => ed()?.insertText(sql)}
            onClose={() => setAi(null)}
          />
        )}
      </div>
      {paramAsk && (
        <ParametersDialog
          names={paramAsk.names}
          initial={paramValues.current}
          onRun={(values) => {
            paramAsk.resolve(values);
            setParamAsk(null);
          }}
          onRunAsWritten={() => {
            paramAsk.resolve("raw");
            setParamAsk(null);
          }}
          onClose={() => {
            paramAsk.resolve(null);
            setParamAsk(null);
          }}
        />
      )}
    </div>
  );
}
