import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  startWorkspaceActivityHeartbeat,
  WorkspaceActivityStore,
  WorkspaceBusyError,
} from "./workspace-activity.js";

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
