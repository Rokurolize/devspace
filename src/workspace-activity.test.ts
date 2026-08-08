import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, unlink } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { databasePath, openDatabase } from "./db/client.js";
import {
  startWorkspaceActivityHeartbeat,
  WorkspaceActivityStore,
  WorkspaceBusyError,
} from "./workspace-activity.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

test("workspace activity leases coordinate across database connections", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-workspace-activity-test-"));
  const first = new WorkspaceActivityStore(root);
  const second = new WorkspaceActivityStore(root);
  try {
    const operation = first.acquireShared("ws_1", "operation", "first-operation");
    const process = second.acquireShared("ws_1", "process", "second-process");
    assert.throws(
      () => second.acquireClose("ws_1", "close"),
      (error: unknown) => error instanceof WorkspaceBusyError && error.reason === "active",
    );

    operation.release();
    process.release();
    const close = second.acquireClose("ws_1", "close");
    assert.throws(
      () => first.acquireShared("ws_1", "operation", "blocked-operation"),
      (error: unknown) => error instanceof WorkspaceBusyError && error.reason === "closing",
    );
    close.release();

    const next = first.acquireShared("ws_1", "operation", "next-operation");
    next.release();
  } finally {
    first.close();
    second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace aliases for the same root share one activity boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-workspace-activity-alias-test-"));
  const stateDir = join(root, ".state");
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  const sessions = new SqliteWorkspaceStore(stateDir);
  sessions.createSession({
    id: "ws_managed_alias",
    root: workspaceRoot,
    mode: "worktree",
    sourceRoot: root,
    managed: true,
  });
  sessions.createSession({
    id: "ws_checkout_alias",
    root: workspaceRoot,
    mode: "checkout",
  });
  const first = new WorkspaceActivityStore(stateDir);
  const second = new WorkspaceActivityStore(stateDir);
  try {
    const checkoutClose = second.acquireClose(
      "ws_checkout_alias",
      "checkout-handle-close",
    );
    checkoutClose.release();

    assert.throws(
      () => second.acquireClose("ws_managed_alias", "open-alias-close"),
      (error: unknown) =>
        error instanceof WorkspaceBusyError && error.reason === "open_alias",
    );
    sessions.setSessionStatus("ws_checkout_alias", "detached");

    const operation = first.acquireShared(
      "ws_checkout_alias",
      "operation",
      "alias-operation",
    );
    assert.throws(
      () => second.acquireClose("ws_managed_alias", "alias-close"),
      (error: unknown) => error instanceof WorkspaceBusyError && error.reason === "active",
    );
    operation.release();

    const close = second.acquireClose("ws_managed_alias", "alias-close");
    assert.throws(
      () => first.acquireShared("ws_checkout_alias", "operation", "blocked-alias"),
      (error: unknown) => error instanceof WorkspaceBusyError && error.reason === "closing",
    );
    close.release();
  } finally {
    first.close();
    second.close();
    sessions.close();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "symlinked workspace aliases share one activity boundary",
  { skip: platform() === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "devspace-workspace-activity-symlink-test-"));
    const stateDir = join(root, ".state");
    const workspaceRoot = join(root, "workspace");
    const workspaceAlias = join(root, "workspace-alias");
    await mkdir(workspaceRoot);
    await symlink(workspaceRoot, workspaceAlias, "dir");
    const sessions = new SqliteWorkspaceStore(stateDir);
    sessions.createSession({ id: "ws_real", root: workspaceRoot, mode: "checkout" });
    sessions.createSession({ id: "ws_symlink", root: workspaceAlias, mode: "checkout" });
    sessions.setSessionStatus("ws_real", "detached");
    const first = new WorkspaceActivityStore(stateDir);
    const second = new WorkspaceActivityStore(stateDir);
    try {
      const operation = first.acquireShared("ws_real", "operation", "real-operation");
      assert.throws(
        () => second.acquireClose("ws_symlink", "symlink-close"),
        (error: unknown) => error instanceof WorkspaceBusyError && error.reason === "active",
      );
      operation.release();
    } finally {
      first.close();
      second.close();
      sessions.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "adopting a lease preserves its original symlink target identity",
  { skip: platform() === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "devspace-workspace-activity-retarget-test-"));
    const stateDir = join(root, ".state");
    const originalRoot = join(root, "original");
    const replacementRoot = join(root, "replacement");
    const workspaceAlias = join(root, "workspace-alias");
    await mkdir(originalRoot);
    await mkdir(replacementRoot);
    await symlink(originalRoot, workspaceAlias, "dir");

    const sessions = new SqliteWorkspaceStore(stateDir);
    sessions.createSession({
      id: "ws_original_target",
      root: originalRoot,
      mode: "worktree",
      sourceRoot: root,
      managed: true,
    });
    sessions.createSession({ id: "ws_retargeted_alias", root: workspaceAlias, mode: "checkout" });
    sessions.setSessionStatus("ws_original_target", "detached");
    sessions.setSessionStatus("ws_retargeted_alias", "detached");

    const first = new WorkspaceActivityStore(stateDir);
    const second = new WorkspaceActivityStore(stateDir);
    try {
      const original = first.acquireShared(
        "ws_retargeted_alias",
        "local_agent",
        "retarget-agent",
      );
      await unlink(workspaceAlias);
      await symlink(replacementRoot, workspaceAlias, "dir");

      const adopted = second.adopt(
        original.id,
        "ws_retargeted_alias",
        "local_agent",
      );
      assert.throws(
        () => first.acquireClose("ws_original_target", "original-target-close"),
        (error: unknown) => error instanceof WorkspaceBusyError && error.reason === "active",
      );
      adopted.release();
      original.release();
    } finally {
      first.close();
      second.close();
      sessions.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("resource migration backfills existing workspace leases", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-workspace-activity-migration-test-"));
  const stateDir = join(root, ".state");
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);

  const sessions = new SqliteWorkspaceStore(stateDir);
  sessions.createSession({ id: "ws_pre_resource", root: workspaceRoot, mode: "checkout" });
  sessions.createSession({ id: "ws_post_resource", root: workspaceRoot, mode: "checkout" });
  sessions.setSessionStatus("ws_pre_resource", "detached");
  sessions.setSessionStatus("ws_post_resource", "detached");
  sessions.close();

  const original = new WorkspaceActivityStore(stateDir);
  original.acquireShared("ws_pre_resource", "operation", "pre-resource-operation");
  original.close();
  downgradeWorkspaceActivityTableToV6(stateDir);

  const migrated = new WorkspaceActivityStore(stateDir);
  try {
    assert.throws(
      () => migrated.acquireClose("ws_post_resource", "post-resource-close"),
      (error: unknown) => error instanceof WorkspaceBusyError && error.reason === "active",
    );
  } finally {
    migrated.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("resource migration fences legacy lease writers", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-workspace-activity-legacy-writer-test-"));
  const stateDir = join(root, ".state");
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);

  const sessions = new SqliteWorkspaceStore(stateDir);
  sessions.createSession({ id: "ws_legacy_writer", root: workspaceRoot, mode: "checkout" });
  sessions.setSessionStatus("ws_legacy_writer", "detached");
  sessions.close();

  const now = Date.now();
  downgradeWorkspaceActivityTableToV6(stateDir);
  const legacyDatabase = new Database(databasePath(stateDir));
  const legacyInsert = legacyDatabase.prepare(
    `insert into workspace_activity_leases (
       lease_id, workspace_id, kind, owner_id, expires_at,
       created_at, updated_at
     ) values (?, ?, ?, ?, ?, ?, ?)`,
  );
  const current = new WorkspaceActivityStore(stateDir);
  try {
    assert.throws(
      () => legacyInsert.run(
        "wal_legacy_writer",
        "ws_legacy_writer",
        "process",
        "legacy-process",
        now + 60_000,
        new Date(now).toISOString(),
        new Date(now).toISOString(),
      ),
      /resource_key|not null/i,
    );
  } finally {
    current.close();
    legacyDatabase.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("expired and adopted workspace activity leases recover safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-workspace-activity-expiry-test-"));
  let now = 1_000;
  const first = new WorkspaceActivityStore(root, { now: () => now, ttlMs: 100 });
  const second = new WorkspaceActivityStore(root, { now: () => now, ttlMs: 100 });
  try {
    const original = first.acquireShared("ws_2", "local_agent", "agent");
    const adopted = second.adopt(original.id, "ws_2", "local_agent");
    now = 1_050;
    adopted.heartbeat();
    now = 1_120;
    assert.throws(
      () => first.acquireClose("ws_2", "close"),
      (error: unknown) => error instanceof WorkspaceBusyError && error.reason === "active",
    );

    now = 1_151;
    const close = first.acquireClose("ws_2", "close");
    close.release();
    original.release();
  } finally {
    first.close();
    second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("adopting a near-expiry lease renews it atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-workspace-activity-adopt-test-"));
  let now = 1_000;
  const first = new WorkspaceActivityStore(root, { now: () => now, ttlMs: 100 });
  const second = new WorkspaceActivityStore(root, { now: () => now, ttlMs: 100 });
  try {
    const original = first.acquireShared("ws_adopt", "local_agent", "agent");
    now = 1_090;
    const adopted = second.adopt(original.id, "ws_adopt", "local_agent");

    now = 1_150;
    assert.throws(
      () => first.acquireClose("ws_adopt", "close"),
      (error: unknown) => error instanceof WorkspaceBusyError && error.reason === "active",
    );

    now = 1_191;
    const close = first.acquireClose("ws_adopt", "close");
    close.release();
    adopted.release();
    original.release();
  } finally {
    first.close();
    second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace activity heartbeat retries after a transient refresh failure", async () => {
  let attempts = 0;
  const stopHeartbeat = startWorkspaceActivityHeartbeat({
    id: "lease-retry",
    workspaceId: "ws_retry",
    kind: "operation",
    heartbeatIntervalMs: 10,
    heartbeat: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient database lock");
    },
    release: () => undefined,
  });
  try {
    const deadline = Date.now() + 1_000;
    while (attempts < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(attempts >= 2);
  } finally {
    stopHeartbeat();
  }
});

test("workspace activity release remains safe after its store becomes unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-workspace-activity-release-test-"));
  const store = new WorkspaceActivityStore(root);
  const lease = store.acquireShared("ws_release", "operation", "release-test");
  store.close();
  assert.doesNotThrow(() => lease.release());
  await rm(root, { recursive: true, force: true });
});

function downgradeWorkspaceActivityTableToV6(stateDir: string): void {
  const database = new Database(databasePath(stateDir));
  try {
    database.exec(`
      create table workspace_activity_leases_v6 (
        lease_id text primary key,
        workspace_id text not null,
        kind text not null,
        owner_id text not null,
        expires_at integer not null,
        created_at text not null,
        updated_at text not null
      );

      insert into workspace_activity_leases_v6 (
        lease_id, workspace_id, kind, owner_id,
        expires_at, created_at, updated_at
      )
      select lease_id, workspace_id, kind, owner_id,
             expires_at, created_at, updated_at
      from workspace_activity_leases;

      drop table workspace_activity_leases;
      alter table workspace_activity_leases_v6 rename to workspace_activity_leases;

      create index workspace_activity_leases_workspace_expires_idx
        on workspace_activity_leases(workspace_id, expires_at);

      delete from devspace_schema_migrations where version = 7;
    `);
  } finally {
    database.close();
  }
}
