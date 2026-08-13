#!/usr/bin/env node
// DevSpace dashboard
//
// Parses the DevSpace server's JSONL serve logs (tool_call events) and serves
// a read-only browser dashboard that shows, per workspaceId, the opened path,
// the active/closed state, and the last command executed with its timestamp.
//
// Usage:
//   node scripts/dashboard.mjs                 # default ~/.devspace logs
//   node scripts/dashboard.mjs --log /path/to/serve.log --port 7677
//
// The script is self-contained (zero dependencies) and never touches the
// DevSpace server or its database; it only reads log files.
import { createServer } from "node:http";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DASHBOARD_VERSION = "1.0.0";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7677;
const DEFAULT_POLL_MS = 3000;
const IDLE_AFTER_MS = 15 * 60 * 1_000;
const TIMELINE_CAP = 2_000;
const TIMELINE_RESPONSE_LIMIT = 500;
const DEDUP_LIMIT = 300_000;

export function createDashboardState() {
  return {
    sources: [],
    workspaces: new Map(),
    timeline: [],
    toolCalls: 0,
    commands: 0,
    seenHashes: new Set(),
    seenOrder: [],
  };
}

export function addLogSource(state, file) {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return;
  }
  if (!stat.isFile()) return;
  state.sources.push({ file, offset: 0, tail: "", ino: stat.ino });
}

export function readNewEvents(state) {
  for (const source of state.sources) {
    let stat;
    try {
      stat = statSync(source.file);
    } catch {
      continue;
    }
    const size = stat.size;
    if (stat.ino !== source.ino || size < source.offset) {
      // The file was truncated, rotated, or replaced; start over from the top.
      source.ino = stat.ino;
      source.offset = 0;
      source.tail = "";
    }
    if (size === source.offset) continue;

    const length = size - source.offset;
    const chunk = Buffer.allocUnsafe(length);
    let read = 0;
    const fd = openSync(source.file, "r");
    try {
      while (read < length) {
        const n = readSync(fd, chunk, read, length - read, source.offset + read);
        if (n <= 0) break;
        read += n;
      }
      source.offset += read;
    } finally {
      closeSync(fd);
    }

    const text = source.tail + chunk.subarray(0, read).toString("utf8");
    const lines = text.split("\n");
    source.tail = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (entry && typeof entry === "object" && entry.event === "tool_call") {
        ingestEvent(state, entry);
      }
    }
  }
}

function ingestEvent(state, entry) {
  const hash = [
    entry.ts,
    entry.tool,
    entry.workspaceId ?? "",
    entry.path ?? "",
    entry.commandPreview ?? "",
    entry.commandLength ?? "",
    entry.success,
  ].join("|");
  if (seenBefore(state, hash)) return;

  state.toolCalls++;
  const id = entry.workspaceId;
  let workspace = id ? state.workspaces.get(id) : undefined;
  if (entry.tool === "open_workspace" && entry.success) {
    const path = absolutePath(entry.path);
    if (workspace && workspace.status === "closed") {
      workspace.openedAt = entry.ts;
      workspace.closedAt = undefined;
      workspace.status = "active";
    } else if (!workspace) {
      workspace = newWorkspace(id, path, entry.ts);
      state.workspaces.set(id, workspace);
    }
    if (workspace) {
      workspace.openCount++;
      if (path) {
        workspace.path = path;
        workspace.mode = detectMode(path);
      }
    }
  } else if (entry.tool === "close_workspace" && entry.success) {
    if (!workspace) {
      workspace = newWorkspace(id, undefined, entry.ts);
      state.workspaces.set(id, workspace);
    }
    workspace.status = "closed";
    workspace.closedAt = entry.ts;
    workspace.closeCount++;
  } else if (id) {
    // Any other tool call counts as activity in the workspace. Create the
    // workspace row lazily: after a server restart the serve log is truncated
    // and the host may keep using a workspaceId whose open_workspace event is
    // no longer in the log.
    if (!workspace) {
      workspace = newWorkspace(id, absolutePath(entry.path), entry.ts);
      state.workspaces.set(id, workspace);
    }
    workspace.toolCounts[entry.tool] = (workspace.toolCounts[entry.tool] ?? 0) + 1;
    if (hasCommandDetails(entry)) {
      workspace.commandCount++;
      workspace.lastCommand = {
        ts: entry.ts,
        tool: entry.tool,
        commandPreview: entry.commandPreview,
        commandLength: entry.commandLength,
        success: entry.success,
        durationMs: entry.durationMs,
        workingDirectory: entry.workingDirectory,
      };
    }
  }

  if (workspace) {
    workspace.lastSeenAt = entry.ts;
    workspace.lastTool = entry.tool;
    if (!workspace.path) {
      const path = absolutePath(entry.path);
      if (path) {
        workspace.path = path;
        workspace.mode = detectMode(path);
      }
    }
  }

  state.timeline.push({
    ts: entry.ts,
    workspaceId: id ?? null,
    path: workspace ? workspace.path : entry.path,
    filePath: entry.path,
    tool: entry.tool,
    commandPreview: entry.commandPreview,
    commandLength: entry.commandLength,
    success: entry.success,
    durationMs: entry.durationMs,
  });
  if (hasCommandDetails(entry)) {
    state.commands++;
  }
  if (state.timeline.length > TIMELINE_CAP + 256) {
    state.timeline.splice(0, state.timeline.length - TIMELINE_CAP);
  }
}

function hasCommandDetails(entry) {
  return (
    typeof entry.command === "string"
    || typeof entry.commandPreview === "string"
    || typeof entry.commandLength === "number"
  );
}

function absolutePath(path) {
  return typeof path === "string" && path.startsWith("/") ? path : undefined;
}

export function defaultDatabasePath() {
  return join(homedir(), ".local", "share", "devspace", "devspace.sqlite");
}

// Reads workspace roots from DevSpace's persisted session database. This
// recovers the real root path for workspaces whose open_workspace event was
// truncated out of the serve log by a server restart. Returns undefined when
// the database is unavailable, in which case the dashboard stays log-only.
export async function loadWorkspaceRoots(dbPath) {
  if (!dbPath) return undefined;
  try {
    const { default: Database } = await import("better-sqlite3");
    const sqlite = new Database(dbPath, { readonly: true });
    try {
      const rows = sqlite
        .prepare("select id, root, mode from workspace_sessions")
        .all();
      return new Map(
        rows.map((row) => [row.id, { path: row.root ?? undefined, mode: row.mode ?? undefined }]),
      );
    } finally {
      sqlite.close();
    }
  } catch {
    return undefined;
  }
}

export function applyWorkspaceRoots(state, roots) {
  if (!roots) return;
  for (const [id, info] of roots) {
    const workspace = state.workspaces.get(id);
    if (!workspace || !info.path) continue;
    workspace.path = info.path;
    workspace.mode =
      info.mode === "worktree" || info.mode === "checkout"
        ? info.mode
        : detectMode(info.path);
  }
}

function newWorkspace(id, path, ts) {
  return {
    id,
    path: path ?? null,
    mode: detectMode(path),
    status: "active",
    openedAt: ts,
    closedAt: undefined,
    lastSeenAt: ts,
    lastTool: undefined,
    toolCounts: {},
    openCount: 0,
    closeCount: 0,
    commandCount: 0,
    lastCommand: null,
  };
}

function seenBefore(state, hash) {
  if (state.seenHashes.has(hash)) return true;
  state.seenHashes.add(hash);
  state.seenOrder.push(hash);
  if (state.seenOrder.length > DEDUP_LIMIT) {
    const evicted = state.seenOrder.splice(0, state.seenOrder.length - DEDUP_LIMIT);
    for (const evictedHash of evicted) state.seenHashes.delete(evictedHash);
  }
  return false;
}

function detectMode(path) {
  return path ? /(^|\/)worktrees(\/|$)/.test(path) ? "worktree" : "checkout" : "checkout";
}

export function dashboardSnapshot(state, now = Date.now()) {
  const workspaces = [...state.workspaces.values()].map((workspace) => {
    const lastSeen = Date.parse(workspace.lastSeenAt);
    const status =
      workspace.status === "active" && Number.isFinite(lastSeen) && now - lastSeen > IDLE_AFTER_MS
        ? "idle"
        : workspace.status;
    return { ...workspace, status };
  });
  // Stable order by workspaceId so rows do not jump around as activity lands.
  workspaces.sort((a, b) => a.id.localeCompare(b.id));

  const counts = { active: 0, idle: 0, closed: 0 };
  for (const workspace of workspaces) counts[workspace.status] = (counts[workspace.status] ?? 0) + 1;

  return {
    version: DASHBOARD_VERSION,
    generatedAt: new Date(now).toISOString(),
    sources: state.sources.map((source) => source.file),
    stats: {
      workspaces: workspaces.length,
      ...counts,
      toolCalls: state.toolCalls,
      commands: state.commands,
    },
    workspaces,
    commands: state.timeline.slice(-TIMELINE_RESPONSE_LIMIT).reverse(),
  };
}

export function createDashboardServer(state, options) {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(dashboardPageHtml());
      return;
    }
    if (url.pathname === "/api/state") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(dashboardSnapshot(state)));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    process.exit(0);
  }

  const files = resolveLogFiles(options.logs);
  if (files.length === 0) {
    console.error(
      "dashboard: no log files matched. Pass explicit paths with --log (glob supported).",
    );
    process.exit(1);
  }

  const state = createDashboardState();
  for (const file of files) addLogSource(state, file);
  readNewEvents(state);
  const roots = await loadWorkspaceRoots(options.db);
  applyWorkspaceRoots(state, roots);

  const server = createDashboardServer(state, options);
  server.listen(options.port, options.host, () => {
    console.log(`DevSpace dashboard: http://${options.host}:${options.port}`);
    console.log(`log sources: ${files.length} file(s), ${state.toolCalls} tool call(s) parsed`);
    for (const file of files) console.log(`  - ${file}`);
    if (roots) console.log(`workspace roots: enriched from ${options.db}`);
    console.log(`poll interval: ${options.pollMs}ms`);
  });

  const timer = setInterval(() => {
    readNewEvents(state);
    void loadWorkspaceRoots(options.db).then(applyWorkspaceRoots.bind(null, state));
  }, options.pollMs);
  timer.unref();
}

function parseArgs(argv) {
  const options = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    pollMs: DEFAULT_POLL_MS,
    logs: defaultLogPatterns(),
    db: defaultDatabasePath(),
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--log": {
        const value = argv[++i];
        if (!value) throw new Error("--log requires a file path or glob pattern");
        options.logs.push(value);
        break;
      }
      case "--db": {
        const value = argv[++i];
        if (!value) throw new Error("--db requires a path to the DevSpace state database");
        options.db = value;
        break;
      }
      case "--no-db":
        options.db = null;
        break;
      case "--host": {
        const value = argv[++i];
        if (!value) throw new Error("--host requires a value");
        options.host = value;
        break;
      }
      case "--port": {
        const value = Number(argv[++i]);
        if (!Number.isInteger(value) || value < 1 || value > 65_535) {
          throw new Error("--port requires an integer between 1 and 65535");
        }
        options.port = value;
        break;
      }
      case "--interval": {
        const value = Number(argv[++i]);
        if (!Number.isInteger(value) || value < 200) {
          throw new Error("--interval requires an integer of at least 200 milliseconds");
        }
        options.pollMs = value;
        break;
      }
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function defaultLogPatterns() {
  const home = homedir();
  return [
    join(home, ".devspace", "devspace-serve.log"),
    join(home, ".devspace", "logs", "devspace-serve.log"),
    join(home, ".devspace", "logs", "devspace-serve-*.log"),
  ];
}

function resolveLogFiles(patterns) {
  const found = [];
  for (const pattern of patterns) {
    if (pattern.includes("*")) {
      found.push(...expandGlob(pattern));
    } else if (existsSync(pattern)) {
      found.push(pattern);
    }
  }
  return [...new Set(found)].sort();
}

function expandGlob(pattern) {
  const parts = pattern
    .replace(/^~/, homedir())
    .replace(/\\/g, "/")
    .split("/");
  const results = [];
  const walk = (index, prefix) => {
    if (index === parts.length) {
      const path = prefix.join("/") || "/";
      if (existsSync(path)) results.push(path);
      return;
    }
    const head = parts[index];
    if (!head.includes("*")) {
      prefix.push(head);
      walk(index + 1, prefix);
      prefix.pop();
      return;
    }
    const dir = prefix.join("/") || "/";
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    const matcher = new RegExp(`^${head.split("*").map(escapeRegex).join(".*")}$`);
    for (const entry of entries) {
      if (!matcher.test(entry)) continue;
      prefix.push(entry);
      walk(index + 1, prefix);
      prefix.pop();
    }
  };
  walk(0, []);
  return results;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function printUsage() {
  console.log(
    [
      "DevSpace dashboard — visualize devspace serve logs in the browser.",
      "",
      "Usage:",
      "  node scripts/dashboard.mjs [options]",
      "",
      "Options:",
      "  --log <path-or-glob>  Log file to read (repeatable; supports *).",
      "                        Defaults to ~/.devspace/devspace-serve.log and",
      "                        ~/.devspace/logs/devspace-serve*.log.",
      "  --db <path>           DevSpace state database (devspace.sqlite). Workspace",
      "                        roots are recovered from it after log truncation.",
      "                        Defaults to ~/.local/share/devspace/devspace.sqlite.",
      "  --no-db               Do not read the DevSpace state database.",
      "  --host <host>         Bind address (default: 127.0.0.1).",
      "  --port <port>         Listen port (default: 7677).",
      "  --interval <ms>       Log re-read interval (default: 3000).",
      "  -h, --help            Show this help.",
    ].join("\n"),
  );
}

export function dashboardPageHtml() {
  return [
    '<!doctype html>',
    '<html lang="ja">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>DevSpace ダッシュボード</title>',
    '<style>',
    DASHBOARD_CSS,
    '</style>',
    '</head>',
    '<body>',
    '<header class="topbar">',
    '<div class="title"><span class="logo">DS</span><div><h1>DevSpace ダッシュボード</h1><div id="meta" class="meta"></div></div></div>',
    '<div class="poll">自動更新 <span id="pollBadge" class="poll-badge on">ON</span></div>',
    '</header>',
    '<main>',
    '<section id="stats" class="stats"></section>',
    '<section class="controls">',
    '<input id="filter" type="search" placeholder="workspaceId / パス / コマンドで絞り込み" autocomplete="off">',
    '<select id="statusFilter">',
    '<option value="all">状態: すべて</option>',
    '<option value="active">状態: アクティブのみ</option>',
    '<option value="idle">状態: アイドルのみ</option>',
    '<option value="closed">状態: クローズのみ</option>',
    '</select>',
    '<label class="check"><input id="commandsOnly" type="checkbox"> コマンドのみ表示</label>',
    '</section>',
    '<section class="panel">',
    '<h2>ワークスペース <span id="wsCount" class="count"></span></h2>',
    '<div id="wsList" class="ws-list"></div>',
    '</section>',
    '<section class="panel">',
    '<h2>直近のツール呼び出し <span id="tlCount" class="count"></span></h2>',
    '<div class="table-wrap"><table id="tlTable">',
    '<thead><tr>',
    '<th class="col-time">時刻</th>',
    '<th class="col-id">workspaceId</th>',
    '<th class="col-tool">ツール</th>',
    '<th class="col-content">内容</th>',
    '<th class="col-result">結果</th>',
    '<th class="col-dur">所要時間</th>',
    '</tr></thead>',
    '<tbody id="tlBody"></tbody>',
    '</table></div>',
    '</section>',
    '</main>',
    '<script>',
    DASHBOARD_PAGE_SCRIPT,
    '</script>',
    '</body>',
    '</html>',
    '',
  ].join("\n");
}

export const DASHBOARD_CSS = [
  ":root { color-scheme: dark; }",
  "* { box-sizing: border-box; }",
  "body { margin: 0; background: #0f1115; color: #e6e9ef; font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Sans', 'Noto Sans JP', sans-serif; }",
  "code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }",
  ".topbar { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; background: rgba(15,17,21,0.92); backdrop-filter: blur(6px); border-bottom: 1px solid #262b36; }",
  ".topbar .title { display: flex; align-items: center; gap: 12px; }",
  ".topbar h1 { margin: 0; font-size: 16px; letter-spacing: 0.02em; }",
  ".logo { width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; border-radius: 8px; background: linear-gradient(135deg, #4f8cff, #2f6fe0); color: #fff; font-weight: 700; font-size: 13px; }",
  ".meta { margin-top: 2px; color: #9aa3b2; font-size: 12px; }",
  ".poll { display: flex; align-items: center; gap: 8px; color: #9aa3b2; font-size: 12px; }",
  ".poll-badge { padding: 2px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; }",
  ".poll-badge.on { background: rgba(47,158,99,0.16); color: #4cc98a; }",
  ".poll-badge.off { background: rgba(217,142,43,0.16); color: #e0a24b; }",
  "main { max-width: 1280px; margin: 0 auto; padding: 18px 20px 60px; }",
  ".stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 16px; }",
  ".stat { background: #171a21; border: 1px solid #262b36; border-radius: 10px; padding: 12px 14px; }",
  ".stat .value { font-size: 22px; font-weight: 700; }",
  ".stat .label { color: #9aa3b2; font-size: 12px; margin-top: 2px; }",
  ".stat.s-active .value { color: #4cc98a; }",
  ".stat.s-idle .value { color: #e0a24b; }",
  ".stat.s-closed .value { color: #8b94a3; }",
  ".controls { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 16px; }",
  ".controls input[type=search] { flex: 1; min-width: 240px; padding: 8px 12px; border-radius: 8px; border: 1px solid #2b3140; background: #171a21; color: #e6e9ef; outline: none; }",
  ".controls input[type=search]:focus { border-color: #4f8cff; }",
  ".controls select { padding: 8px 10px; border-radius: 8px; border: 1px solid #2b3140; background: #171a21; color: #e6e9ef; outline: none; }",
  ".controls .check { display: flex; align-items: center; gap: 6px; color: #b6bdc9; font-size: 13px; white-space: nowrap; }",
  ".panel { background: #171a21; border: 1px solid #262b36; border-radius: 12px; padding: 16px 18px; margin-bottom: 20px; }",
  ".panel h2 { margin: 0 0 12px; font-size: 14px; color: #c9cfda; }",
  ".count { color: #9aa3b2; font-weight: 400; font-size: 12px; }",
  ".table-wrap { overflow-x: auto; }",
  "table { width: 100%; border-collapse: collapse; font-size: 13px; }",
  "th { text-align: left; color: #8b94a3; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; padding: 6px 10px; border-bottom: 1px solid #262b36; white-space: nowrap; }",
  "td { padding: 9px 10px; border-bottom: 1px solid #20242e; vertical-align: top; }",
  "tbody tr:hover { background: rgba(79,140,255,0.05); }",
  ".ws-list { display: flex; flex-direction: column; gap: 10px; }",
  ".ws-card { border: 1px solid #262b36; border-radius: 10px; padding: 10px 14px; background: #13161c; cursor: pointer; transition: border-color 120ms ease, background 120ms ease; }",
  ".ws-card:hover { border-color: #35405a; background: #151a23; }",
  ".ws-card.open { border-color: rgba(79,140,255,0.45); }",
  ".ws-main { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }",
  ".ws-path { flex: 1 1 240px; min-width: 0; display: flex; align-items: baseline; gap: 4px; overflow: hidden; }",
  ".ws-path .dir { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #8b94a3; }",
  ".ws-path .base { flex: 0 0 auto; white-space: nowrap; color: #d8dde5; }",
  ".ws-counts { margin-left: auto; white-space: nowrap; }",
  ".sep { color: #565f6e; }",
  ".ws-sub { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-top: 6px; font-size: 12px; }",
  ".ws-detail { margin-top: 10px; border-top: 1px dashed #262b36; padding-top: 10px; }",
  ".detail-row td { background: #13161c; padding: 8px 14px 12px; }",
  ".badge { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; }",
  ".badge.active { background: rgba(47,158,99,0.16); color: #4cc98a; }",
  ".badge.idle { background: rgba(217,142,43,0.16); color: #e0a24b; }",
  ".badge.closed { background: rgba(139,148,163,0.14); color: #8b94a3; }",
  ".badge.worktree { background: rgba(156,106,222,0.16); color: #bd8ff0; }",
  ".badge.checkout { background: rgba(139,148,163,0.12); color: #a7afbb; }",
  ".ws-id { color: #8fd3ff; }",
  ".muted { color: #8b94a3; font-size: 12px; }",
  ".time { white-space: nowrap; color: #b6bdc9; }",
  ".time .abs { color: #9aa3b2; font-size: 11px; }",
  ".cmd { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; color: #d8dde5; }",
  ".tool-chip { display: inline-block; padding: 1px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; white-space: nowrap; margin-right: 6px; }",
  ".tool-command { background: rgba(79,140,255,0.16); color: #8fc3ff; }",
  ".tool-file { background: rgba(156,106,222,0.16); color: #c9a8f2; }",
  ".tool-workspace { background: rgba(47,158,99,0.16); color: #6fd6a3; }",
  ".tool-workspace-close { background: rgba(217,90,90,0.16); color: #f08d8d; }",
  ".tool-other { background: rgba(139,148,163,0.14); color: #a7afbb; }",
  ".ok { color: #4cc98a; font-weight: 700; }",
  ".ng { color: #f08d8d; font-weight: 700; }",
  ".chips { display: flex; flex-wrap: wrap; gap: 6px; }",
  ".chip { padding: 2px 9px; border-radius: 6px; background: #1d222b; border: 1px solid #2b3140; font-size: 12px; color: #c9cfda; }",
  ".empty { color: #8b94a3; text-align: center; padding: 26px 0; }",
  ".num { text-align: right; font-variant-numeric: tabular-nums; }",
  ".col-time { width: 150px; white-space: nowrap; }",
  ".col-tool { width: 150px; }",
  ".col-result { width: 70px; }",
  ".col-dur { width: 90px; text-align: right; }",
].join("\n");

// The page script intentionally avoids template literals and ${} so it can be
// embedded verbatim in the HTML above.
export const DASHBOARD_PAGE_SCRIPT = [
  '"use strict";',
  'var data = null;',
  'var statusFilter = "all";',
  'var commandsOnly = false;',
  'var expanded = {};',
  'var TOOL_LABELS = {',
  '  open_workspace: "ワークスペースを開く",',
  '  close_workspace: "ワークスペースを閉じる",',
  '  read: "ファイル読み取り",',
  '  grep: "grep 検索",',
  '  glob: "ファイル検索",',
  '  ls: "一覧表示",',
  '  write: "ファイル書き込み",',
  '  edit: "ファイル編集",',
  '  overwrite: "上書き",',
  '  apply_patch: "パッチ適用",',
  '  shell: "シェルコマンド",',
  '  exec_command: "コマンド実行",',
  '  write_stdin: "プロセス操作",',
  '  show_changes: "変更表示",',
  '  create_worktree: "ワークツリー作成",',
  '  remove_worktree: "ワークツリー削除",',
  '  list_worktrees: "ワークツリー一覧",',
  '  download_artifact: "アーティファクト取得"',
  '};',
  'var TOOL_COLORS = {',
  '  shell: "command", exec_command: "command", write_stdin: "command",',
  '  read: "file", grep: "file", glob: "file", ls: "file",',
  '  write: "file", edit: "file", overwrite: "file", apply_patch: "file",',
  '  open_workspace: "workspace", create_worktree: "workspace", list_worktrees: "workspace",',
  '  close_workspace: "workspace-close", remove_worktree: "workspace-close",',
  '  show_changes: "other", download_artifact: "other"',
  '};',
  'var STATUS_LABELS = { active: "アクティブ", idle: "アイドル", closed: "クローズ" };',
  '',
  'function $(id) { return document.getElementById(id); }',
  '',
  'function esc(value) {',
  '  return String(value == null ? "" : value)',
  '    .replace(/&/g, "&amp;")',
  '    .replace(/</g, "&lt;")',
  '    .replace(/>/g, "&gt;")',
  '    .replace(/"/g, "&quot;")',
  '    .replace(/\'/g, "&#39;");',
  '}',
  '',
  'function fmtTime(ts) {',
  '  var d = new Date(ts);',
  '  if (isNaN(d.getTime())) return String(ts == null ? "" : ts);',
  '  var p = function (n) { return n < 10 ? "0" + n : String(n); };',
  '  return d.getFullYear() + "/" + p(d.getMonth() + 1) + "/" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());',
  '}',
  '',
  'function fmtAge(ts) {',
  '  var diff = Date.now() - new Date(ts).getTime();',
  '  if (diff < 60000) return Math.max(0, Math.floor(diff / 1000)) + "秒前";',
  '  if (diff < 3600000) return Math.floor(diff / 60000) + "分前";',
  '  if (diff < 86400000) return Math.floor(diff / 3600000) + "時間前";',
  '  return Math.floor(diff / 86400000) + "日前";',
  '}',
  '',
  'function fmtDuration(ms) {',
  '  if (ms == null) return "";',
  '  if (ms < 1000) return ms + "ms";',
  '  var s = ms / 1000;',
  '  if (s < 60) return s.toFixed(1) + "s";',
  '  return Math.floor(s / 60) + "m" + Math.round(s % 60) + "s";',
  '}',
  '',
  'function toolLabel(tool) { return String(tool); }',
  'function toolLabelJa(tool) { return TOOL_LABELS[tool] || tool; }',
  'function toolClass(tool) { return "tool-" + (TOOL_COLORS[tool] || "other"); }',
  'function baseName(path) { return String(path).split("/").pop(); }',
  'function tooltip(tool) {',
  '  var label = TOOL_LABELS[tool];',
  '  return label && label !== tool ? tool + " (" + label + ")" : tool;',
  '}',
  '',
  'function render() {',
  '  if (!data) return;',
  '  var now = Date.now();',
  '  renderMeta();',
  '  renderStats();',
  '  renderWorkspaces(now);',
  '  renderTimeline(now);',
  '}',
  '',
  'function renderMeta() {',
  '  var parts = ["更新: " + fmtTime(data.generatedAt) + " (" + fmtAge(data.generatedAt) + ")"];',
  '  parts.push("ログファイル " + data.sources.length + " 件");',
  '  if (data.sources.length > 0) {',
  '    parts.push(data.sources.map(function (s) { return baseName(s); }).join(", "));',
  '  }',
  '  $("meta").textContent = parts.join(" ・ ");',
  '}',
  '',
  'function renderStats() {',
  '  var s = data.stats;',
  '  var cards = [',
  '    ["ワークスペース", s.workspaces, ""],',
  '    ["アクティブ", s.active, "s-active"],',
  '    ["アイドル", s.idle, "s-idle"],',
  '    ["クローズ", s.closed, "s-closed"],',
  '    ["ツール呼び出し", s.toolCalls, ""],',
  '    ["コマンド実行", s.commands, ""]',
  '  ];',
  '  $("stats").innerHTML = cards.map(function (card) {',
  '    return "<div class=\\"stat " + card[2] + "\\"><div class=\\"value\\">" + card[1] + "</div><div class=\\"label\\">" + card[0] + "</div></div>";',
  '  }).join("");',
  '}',
  '',
  'function filterValue() { return $("filter").value.trim().toLowerCase(); }',
  '',
  'function workspaceMatches(ws, q) {',
  '  if (q === "") return true;',
  '  var hay = [ws.id, ws.path || "", ws.lastTool || "", ws.lastCommand ? ws.lastCommand.commandPreview || "" : ""].join("\\n").toLowerCase();',
  '  if (hay.indexOf(q) !== -1) return true;',
  '  var counts = Object.keys(ws.toolCounts || {});',
  '  for (var i = 0; i < counts.length; i++) {',
  '    if (counts[i].indexOf(q) !== -1) return true;',
  '    if (toolLabelJa(counts[i]).toLowerCase().indexOf(q) !== -1) return true;',
  '  }',
  '  return false;',
  '}',
  '',
  'function renderWorkspaces(now) {',
  '  var q = filterValue();',
  '  var rows = data.workspaces.filter(function (ws) {',
  '    if (statusFilter !== "all" && ws.status !== statusFilter) return false;',
  '    if (!workspaceMatches(ws, q)) return false;',
  '    return true;',
  '  });',
  '  $("wsCount").textContent = rows.length + " / " + data.workspaces.length + " 件";',
  '  if (rows.length === 0) {',
  '    $("wsList").innerHTML = "<div class=\\"empty\\">該当するワークスペースがありません</div>";',
  '    return;',
  '  }',
  '  var html = [];',
  '  rows.forEach(function (ws) {',
  '    var key = ws.id;',
  '    var isOpen = expanded[key] === true;',
  '    var statusClass = ws.status === "closed" ? "closed" : ws.status === "idle" ? "idle" : "active";',
  '    var totalTools = 0;',
  '    var counts = Object.keys(ws.toolCounts || {});',
  '    for (var i = 0; i < counts.length; i++) totalTools += ws.toolCounts[counts[i]];',
  '    html.push("<div class=\\"ws-card" + (isOpen ? " open" : "") + "\\" data-id=\\"" + esc(key) + "\\" title=\\"クリックでツール内訳を開閉\\">");',
  '    html.push("<div class=\\"ws-main\\">");',
  '    html.push("<span class=\\"badge " + statusClass + "\\">" + STATUS_LABELS[ws.status] + "</span>");',
  '    html.push("<span class=\\"mono ws-id\\">" + esc(ws.id) + "</span>");',
  '    html.push(pathSpan(ws));',
  '    html.push("<span class=\\"badge " + (ws.mode === "worktree" ? "worktree" : "checkout") + "\\">" + (ws.mode === "worktree" ? "ワークツリー" : "チェックアウト") + "</span>");',
  '    html.push("<span class=\\"ws-counts muted\\">コマンド " + ws.commandCount + " 回 ・ ツール " + totalTools + " 回</span>");',
  '    html.push("</div>");',
  '    html.push("<div class=\\"ws-sub\\">");',
  '    html.push("<span class=\\"muted\\">" + (ws.openCount > 0 ? "オープン " : "初見 ") + esc(fmtTime(ws.openedAt)) + "</span>");',
  '    html.push("<span class=\\"sep muted\\">・</span>");',
  '    html.push(lastSeenSpan(ws));',
  '    html.push("</div>");',
  '    if (isOpen) {',
  '      var chips = counts.sort().map(function (tool) {',
  '        return "<span class=\\"chip\\">" + esc(toolLabel(tool)) + " × " + ws.toolCounts[tool] + "</span>";',
  '      });',
  '      html.push("<div class=\\"ws-detail\\"><div class=\\"chips\\">" + (chips.length ? chips.join("") : "<span class=\\"muted\\">ツール呼び出しなし</span>") + "</div></div>");',
  '    }',
  '    html.push("</div>");',
  '  });',
  '  $("wsList").innerHTML = html.join("");',
  '}',
  '',
  'function pathSpan(ws) {',
  '  if (!ws.path) return "<span class=\\"ws-path muted\\">(パス未記録)</span>";',
  '  var last = baseName(ws.path);',
  '  var dir = ws.path.length > last.length ? ws.path.slice(0, -last.length) : "";',
  '  return "<span class=\\"ws-path mono\\" title=\\"" + esc(ws.path) + "\\"><span class=\\"dir\\">" + esc(dir) + "</span><span class=\\"base\\">" + esc(last) + "</span></span>";',
  '}',
  '',
  'function lastSeenSpan(ws) {',
  '  var ts = ws.lastSeenAt;',
  '  if (!ts) return "<span class=\\"muted\\">最終 -</span>";',
  '  var tool = ws.lastTool;',
  '  var label = tool ? toolLabel(tool) : "";',
  '  return "<span class=\\"muted\\" title=\\"" + esc(fmtTime(ts)) + "\\">最終 " + esc(fmtAge(ts)) + (label ? " ・ " + esc(label) : "") + "</span>";',
  '}',
  '',
  'function timelineMatches(ev, q) {',
  '  if (q === "") return true;',
  '  var hay = [ev.workspaceId || "", ev.tool || "", ev.commandPreview || "", ev.filePath || "", ev.path || ""].join("\\n").toLowerCase();',
  '  return hay.indexOf(q) !== -1;',
  '}',
  '',
  'function renderTimeline(now) {',
  '  var q = filterValue();',
  '  var rows = data.commands.filter(function (ev) {',
  '    if (commandsOnly && !ev.commandPreview && !ev.commandLength) return false;',
  '    if (!timelineMatches(ev, q)) return false;',
  '    return true;',
  '  });',
  '  rows = rows.slice(0, 200);',
  '  $("tlCount").textContent = rows.length + " / " + data.commands.length + " 件を表示";',
  '  if (rows.length === 0) {',
  '    $("tlBody").innerHTML = "<tr><td colspan=\\"6\\" class=\\"empty\\">該当するイベントがありません</td></tr>";',
  '    return;',
  '  }',
  '  var html = [];',
  '  rows.forEach(function (ev) {',
  '    var content = ev.commandPreview;',
  '    if (!content && ev.commandLength) content = "(コマンド全文は未記録)";',
  '    if (!content) content = ev.filePath;',
  '    if (!content && ev.tool === "write_stdin") content = "(入力内容はログ未記録)";',
  '    if (!content) content = "-";',
  '    html.push("<tr>");',
  '    html.push("<td class=\\"time\\">" + esc(fmtTime(ev.ts)) + "<div class=\\"abs\\">" + esc(fmtAge(ev.ts)) + "</div></td>");',
  '    html.push("<td class=\\"mono ws-id\\">" + esc(ev.workspaceId || "-") + "</td>");',
  '    html.push("<td><span class=\\"tool-chip " + toolClass(ev.tool) + "\\" title=\\"" + esc(tooltip(ev.tool)) + "\\">" + esc(toolLabel(ev.tool)) + "</span></td>");',
  '    html.push("<td class=\\"cmd\\" title=\\"" + esc(ev.commandPreview || "") + "\\">" + esc(content) + "</td>");',
  '    html.push("<td>" + (ev.success ? "<span class=\\"ok\\">✓</span>" : "<span class=\\"ng\\">✗</span>") + "</td>");',
  '    html.push("<td class=\\"num muted\\">" + fmtDuration(ev.durationMs) + "</td>");',
  '    html.push("</tr>");',
  '  });',
  '  $("tlBody").innerHTML = html.join("");',
  '}',
  '',
  'function applyFilters() {',
  '  statusFilter = $("statusFilter").value;',
  '  commandsOnly = $("commandsOnly").checked;',
  '  render();',
  '}',
  '',
  '$("filter").addEventListener("input", render);',
  '$("statusFilter").addEventListener("change", applyFilters);',
  '$("commandsOnly").addEventListener("change", applyFilters);',
  '',
  '$("wsList").addEventListener("click", function (event) {',
  '  var card = event.target.closest(".ws-card");',
  '  if (!card) return;',
  '  var id = card.getAttribute("data-id");',
  '  expanded[id] = !expanded[id];',
  '  render();',
  '});',
  '',
  'async function refresh() {',
  '  try {',
  '    var res = await fetch("/api/state", { cache: "no-store" });',
  '    if (!res.ok) throw new Error("HTTP " + res.status);',
  '    data = await res.json();',
  '    $("pollBadge").className = "poll-badge on";',
  '    render();',
  '  } catch (err) {',
  '    $("pollBadge").className = "poll-badge off";',
  '    $("meta").textContent = "状態取得エラー: " + err.message + "（ログファイルを確認してください）";',
  '  }',
  '}',
  '',
  'refresh();',
  'setInterval(refresh, 3000);',
].join("\n");

if (
  process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    console.error(`dashboard: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
