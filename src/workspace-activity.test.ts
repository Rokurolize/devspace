import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
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
