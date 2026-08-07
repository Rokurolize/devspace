import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import {
  applyWorkspaceReconcile,
  inspectWorkspaceSessions,
} from "./workspace-reconcile.js";
import { WorkspaceActivityStore, WorkspaceBusyError } from "./workspace-activity.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-reconcile-test-"));
const store = new SqliteWorkspaceStore(join(root, ".state"));
const workspaceActivity = new WorkspaceActivityStore(join(root, ".state"));

try {
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".devspace-home"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: join(root, ".agent"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const gitRoot = join(root, "git-project");
  await mkdir(gitRoot);
  await writeFile(join(gitRoot, "README.md"), "hello\n");
  await git(gitRoot, ["init"]);
  await git(gitRoot, ["config", "user.email", "devspace@example.com"]);
  await git(gitRoot, ["config", "user.name", "DevSpace Test"]);
  await git(gitRoot, ["add", "."]);
  await git(gitRoot, ["commit", "-m", "Initial commit"]);

  const registry = new WorkspaceRegistry(config, store);
  const missingManagedSession = store.createSession({
    id: "ws_missing_managed",
    root: join(config.worktreeRoot, "missing-managed-worktree"),
    mode: "worktree",
    sourceRoot: join(root, "missing-source-checkout"),
    baseRef: "HEAD",
    managed: true,
  });
  store.setSessionStatus(missingManagedSession.id, "detached");
  const missingCheckout = await registry.openWorkspace(join(root, "missing-checkout"), {
    conversationScopeId: "conversation-missing",
  });
  const cleanWorktree = await registry.openWorkspace({ path: gitRoot, mode: "worktree" });
  const dirtyWorktree = await registry.openWorkspace({ path: gitRoot, mode: "worktree" });
  const unregisteredWorktree = await registry.openWorkspace({ path: gitRoot, mode: "worktree" });
  await writeFile(join(dirtyWorktree.workspace.root, "dirty.txt"), "keep me\n");
  await git(gitRoot, ["worktree", "remove", "--force", unregisteredWorktree.workspace.root]);
  await mkdir(unregisteredWorktree.workspace.root);
  const untrackedWorktreeDirectory = join(config.worktreeRoot, "not-in-database");
  await mkdir(untrackedWorktreeDirectory);
  registry.detachAll();
  await rm(missingCheckout.workspace.root, { recursive: true, force: true });

  const report = await inspectWorkspaceSessions(config, store);
  const missingEntry = report.find((entry) => entry.workspaceId === missingCheckout.workspace.id);
  const missingManagedEntry = report.find(
    (entry) => entry.workspaceId === missingManagedSession.id,
  );
  const cleanEntry = report.find((entry) => entry.workspaceId === cleanWorktree.workspace.id);
  const dirtyEntry = report.find((entry) => entry.workspaceId === dirtyWorktree.workspace.id);
  const unregisteredEntry = report.find(
    (entry) => entry.workspaceId === unregisteredWorktree.workspace.id,
  );

  assert.equal(missingEntry?.action, "mark_orphaned");
  assert.equal(missingEntry?.conversationBound, true);
  assert.equal(missingManagedEntry?.action, "mark_orphaned");
  assert.equal(cleanEntry?.action, "remove_worktree");
  assert.equal(cleanEntry?.registered, true);
  assert.equal(cleanEntry?.dirty, false);
  assert.equal(dirtyEntry?.action, "none");
  assert.equal(dirtyEntry?.registered, true);
  assert.equal(dirtyEntry?.dirty, true);
  assert.equal(unregisteredEntry?.action, "mark_cleanup_failed");
  assert.equal(unregisteredEntry?.pathExists, true);
  assert.equal(unregisteredEntry?.registered, false);

  const activeLease = workspaceActivity.acquireShared(
    cleanWorktree.workspace.id,
    "operation",
    "test-operation",
  );
  await assert.rejects(
    applyWorkspaceReconcile(config, store, workspaceActivity, [
      missingCheckout.workspace.id,
      cleanWorktree.workspace.id,
      unregisteredWorktree.workspace.id,
    ]),
    (error: unknown) => error instanceof WorkspaceBusyError,
  );
  assert.equal(store.getSession(missingCheckout.workspace.id)?.status, "detached");
  assert.equal((await stat(cleanWorktree.workspace.root)).isDirectory(), true);
  activeLease.release();

  await applyWorkspaceReconcile(config, store, workspaceActivity, [
    missingCheckout.workspace.id,
    cleanWorktree.workspace.id,
    unregisteredWorktree.workspace.id,
  ]);

  assert.equal(store.getSession(missingCheckout.workspace.id)?.status, "orphaned");
  assert.equal(
    store.hasConversationBindingsForSession(missingCheckout.workspace.id),
    false,
  );
  assert.equal(store.getSession(cleanWorktree.workspace.id)?.status, "closed");
  await assert.rejects(() => stat(cleanWorktree.workspace.root), { code: "ENOENT" });
  assert.equal(store.getSession(dirtyWorktree.workspace.id)?.status, "detached");
  assert.equal((await stat(dirtyWorktree.workspace.root)).isDirectory(), true);
  assert.equal(
    store.getSession(unregisteredWorktree.workspace.id)?.status,
    "cleanup_failed",
  );
  assert.equal((await stat(unregisteredWorktree.workspace.root)).isDirectory(), true);
  assert.equal((await stat(untrackedWorktreeDirectory)).isDirectory(), true);
} finally {
  workspaceActivity.close();
  store.close();
  await rm(root, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
