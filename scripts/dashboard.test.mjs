import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addLogSource,
  applyWorkspaceRoots,
  createDashboardState,
  dashboardPageHtml,
  dashboardSnapshot,
  loadWorkspaceRoots,
  readNewEvents,
} from "./dashboard.mjs";

const root = mkdtempSync(join(tmpdir(), "devspace-dashboard-test-"));
const logPath = join(root, "serve.log");

try {
  writeFileSync(
    logPath,
    [
      "devspace listening on http://127.0.0.1:7676/mcp",
      "not json at all",
      JSON.stringify({
        ts: "2026-08-05T19:13:51.913Z",
        level: "info",
        event: "tool_call",
        tool: "open_workspace",
        workspaceId: "ws_aaa111",
        path: "/home/roku/src/wikijump",
        success: true,
        durationMs: 197,
      }),
      JSON.stringify({
        ts: "2026-08-05T19:13:51.913Z",
        level: "info",
        event: "tool_call",
        tool: "open_workspace",
        workspaceId: "ws_aaa111",
        path: "/home/roku/src/wikijump",
        success: true,
        durationMs: 197,
      }),
      JSON.stringify({
        ts: "2026-08-05T19:14:41.990Z",
        level: "info",
        event: "tool_call",
        tool: "exec_command",
        workspaceId: "ws_aaa111",
        workingDirectory: ".",
        commandLength: 291,
        success: true,
        durationMs: 307,
      }),
      JSON.stringify({
        ts: "2026-08-05T19:15:02.100Z",
        level: "info",
        event: "tool_call",
        tool: "read",
        workspaceId: "ws_aaa111",
        path: "src/lib.rs",
        success: true,
        durationMs: 24,
      }),
      JSON.stringify({
        ts: "2026-08-05T19:16:00.000Z",
        level: "info",
        event: "tool_call",
        tool: "close_workspace",
        workspaceId: "ws_aaa111",
        success: true,
        durationMs: 12,
      }),
      JSON.stringify({
        ts: "2026-08-05T19:17:00.000Z",
        level: "info",
        event: "tool_call",
        tool: "open_workspace",
        workspaceId: "ws_bbb222",
        path: "/home/roku/.devspace/worktrees/devspace-9cb67204",
        success: true,
        durationMs: 89,
      }),
      JSON.stringify({
        ts: "2026-08-05T19:18:00.000Z",
        level: "info",
        event: "tool_call",
        tool: "exec_command",
        workspaceId: "ws_bbb222",
        commandPreview: "set -euo pipefail git fetch origin main",
        success: true,
        durationMs: 10444,
      }),
      JSON.stringify({
        ts: "2026-08-05T19:18:30.000Z",
        level: "info",
        event: "tool_call",
        tool: "some_tool",
        success: false,
        durationMs: 5,
      }),
    ].join("\n") + "\n",
  );

  const state = createDashboardState();
  addLogSource(state, logPath);
  readNewEvents(state);

  assert.equal(state.toolCalls, 7, "duplicate open_workspace line must be deduplicated");
  assert.equal(state.commands, 2, "command events counted from commandPreview/length presence");
  assert.equal(state.workspaces.size, 2);

  const workspaceA = state.workspaces.get("ws_aaa111");
  assert.equal(workspaceA.path, "/home/roku/src/wikijump");
  assert.equal(workspaceA.mode, "checkout");
  assert.equal(workspaceA.status, "closed");
  assert.equal(workspaceA.closeCount, 1);
  assert.equal(workspaceA.commandCount, 1);
  assert.equal(workspaceA.lastCommand.commandLength, 291);
  assert.equal(workspaceA.lastCommand.commandPreview, undefined);
  assert.equal(workspaceA.openCount, 1, "duplicate open must not double count");
  assert.equal(workspaceA.toolCounts.read, 1);

  const workspaceB = state.workspaces.get("ws_bbb222");
  assert.equal(workspaceB.mode, "worktree");
  assert.equal(workspaceB.status, "active");
  assert.equal(workspaceB.lastCommand.commandPreview, "set -euo pipefail git fetch origin main");

  const snapshot = dashboardSnapshot(state, Date.parse("2026-08-05T19:30:00.000Z"));
  assert.equal(snapshot.stats.workspaces, 2);
  assert.equal(snapshot.stats.active, 1);
  assert.equal(snapshot.stats.closed, 1);
  assert.equal(snapshot.stats.idle, 0);
  assert.equal(snapshot.stats.toolCalls, 7);
  assert.equal(snapshot.stats.commands, 2);
  assert.deepEqual(
    snapshot.workspaces.map((workspace) => workspace.id),
    ["ws_aaa111", "ws_bbb222"],
    "workspaces sorted by workspaceId for a stable row order",
  );
  assert.equal(snapshot.commands.length, 7);
  assert.equal(snapshot.commands[0].tool, "some_tool");
  assert.equal(snapshot.commands[0].workspaceId, null);

  const idleSnapshot = dashboardSnapshot(state, Date.parse("2026-08-06T00:00:00.000Z"));
  assert.equal(
    idleSnapshot.workspaces.find((workspace) => workspace.id === "ws_bbb222").status,
    "idle",
    "active workspace goes idle after TTL",
  );

  const workspaceAOpen = state.workspaces.get("ws_aaa111");
  workspaceAOpen.status = "active";
  workspaceAOpen.openedAt = "2026-08-06T00:00:00.000Z";

  appendFileSync(
    logPath,
    [
      JSON.stringify({
        ts: "2026-08-06T00:01:00.000Z",
        level: "info",
        event: "tool_call",
        tool: "open_workspace",
        workspaceId: "ws_aaa111",
        path: "/home/roku/src/wikijump",
        success: true,
        durationMs: 30,
      }),
      JSON.stringify({
        ts: "2026-08-06T00:01:05.000Z",
        level: "info",
        event: "tool_call",
        tool: "shell",
        workspaceId: "ws_aaa111",
        commandPreview: "npm test",
        success: true,
        durationMs: 900,
      }),
    ].join("\n") + "\n",
  );
  readNewEvents(state);

  assert.equal(state.toolCalls, 9, "incremental read picks up appended events");
  assert.equal(workspaceAOpen.status, "active", "reopen after close reactivates");
  assert.equal(workspaceAOpen.openCount, 2);
  assert.equal(workspaceAOpen.commandCount, 2);
  assert.equal(workspaceAOpen.lastCommand.commandPreview, "npm test");

  appendFileSync(
    logPath,
    JSON.stringify({
      ts: "2026-08-06T00:02:00.000Z",
      level: "info",
      event: "tool_call",
      tool: "exec_command",
      workspaceId: "ws_ddd444",
      commandPreview: "cargo build",
      success: true,
      durationMs: 300,
    }) + "\n",
  );
  readNewEvents(state);
  const workspaceD = state.workspaces.get("ws_ddd444");
  assert.ok(workspaceD, "workspace row is created lazily for a tool call without open_workspace");
  assert.equal(workspaceD.status, "active", "lazily created workspace is active");
  assert.equal(workspaceD.openCount, 0);
  assert.equal(workspaceD.commandCount, 1);
  assert.equal(workspaceD.lastCommand.commandPreview, "cargo build");
  assert.equal(workspaceD.path, null, "absent event path must not become the workspace path");
  assert.equal(state.toolCalls, 10);

  appendFileSync(
    logPath,
    JSON.stringify({
      ts: "2026-08-06T00:02:10.000Z",
      level: "info",
      event: "tool_call",
      tool: "read",
      workspaceId: "ws_eee555",
      path: "src/deepwell/main.rs",
      success: true,
      durationMs: 20,
    }) + "\n",
  );
  readNewEvents(state);
  const workspaceE = state.workspaces.get("ws_eee555");
  assert.ok(workspaceE, "read events create workspace rows lazily");
  assert.equal(
    workspaceE.path,
    null,
    "relative read paths must not be shown as the workspace path",
  );

  applyWorkspaceRoots(
    state,
    new Map([
      ["ws_eee555", { path: "/home/roku/src/wikijump", mode: "checkout" }],
      ["ws_ddd444", { path: "/home/roku/.devspace/worktrees/wikijump-9a2b3c4d", mode: "checkout" }],
    ]),
  );
  assert.equal(workspaceE.path, "/home/roku/src/wikijump", "DB root fills the missing path");
  assert.equal(workspaceE.mode, "checkout");
  assert.equal(workspaceD.path, "/home/roku/.devspace/worktrees/wikijump-9a2b3c4d");
  assert.equal(workspaceD.mode, "checkout", "DB mode wins over worktree path detection");

  const dbRoot = join(root, "devspace.sqlite");
  const { default: Database } = await import("better-sqlite3");
  const sqlite = new Database(dbRoot);
  sqlite.exec(`
    create table workspace_sessions (
      id text primary key,
      root text not null,
      mode text not null default 'checkout'
    );
    insert into workspace_sessions (id, root, mode) values
      ('ws_eee555', '/home/roku/src/wikijump', 'checkout'),
      ('ws_ddd444', '/home/roku/.devspace/worktrees/wikijump-9a2b3c4d', 'checkout');
  `);
  sqlite.close();
  const loaded = await loadWorkspaceRoots(dbRoot);
  assert.equal(loaded.get("ws_eee555").path, "/home/roku/src/wikijump");
  assert.equal(loaded.get("ws_ddd444").mode, "checkout");
  assert.equal(await loadWorkspaceRoots(join(root, "missing.sqlite")), undefined);
  assert.equal(await loadWorkspaceRoots(null), undefined);

  const truncatedLog = join(root, "truncated.log");
  writeFileSync(truncatedLog, [
    JSON.stringify({
      ts: "2026-08-06T01:00:00.000Z",
      level: "info",
      event: "tool_call",
      tool: "open_workspace",
      workspaceId: "ws_ccc333",
      path: "/tmp/project",
      success: true,
      durationMs: 11,
    }),
  ].join("\n") + "\n");
  const truncatedState = createDashboardState();
  addLogSource(truncatedState, truncatedLog);
  readNewEvents(truncatedState);
  assert.equal(truncatedState.workspaces.size, 1);
  assert.equal(truncatedState.workspaces.get("ws_ccc333").path, "/tmp/project");

  writeFileSync(truncatedLog, "devspace listening on http://127.0.0.1:7676/mcp\n");
  readNewEvents(truncatedState);
  assert.equal(truncatedState.workspaces.size, 1, "truncation resets the read offset without losing history");

  const page = dashboardPageHtml();
  assert.ok(page.includes("function render() {"), "page script is embedded without corruption");
  assert.ok(page.includes('class="panel"'), "page CSS is embedded without corruption");
  assert.ok(!page.includes("\n\"\nu\ns\ne\n"), "page script is not exploded into per-character lines");

  console.log("dashboard.test: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
