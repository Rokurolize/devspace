import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-workspace-lifecycle-test-"));
const stateDir = join(root, ".state");
const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(root, ".config"),
  DEVSPACE_ALLOWED_ROOTS: root,
  DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
  DEVSPACE_AGENT_DIR: join(root, ".agent"),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  PORT: "1",
});

try {
  const gitRoot = join(root, "project");
  await mkdir(gitRoot);
  await writeFile(join(gitRoot, "README.md"), "hello\n");
  await git(gitRoot, ["init"]);
  await git(gitRoot, ["config", "user.email", "devspace@example.com"]);
  await git(gitRoot, ["config", "user.name", "DevSpace Test"]);
  await git(gitRoot, ["add", "."]);
  await git(gitRoot, ["commit", "-m", "Initial commit"]);

  const firstStore = new SqliteWorkspaceStore(stateDir);
  const firstRegistry = new WorkspaceRegistry(config, firstStore);

  const checkout = await firstRegistry.openWorkspace(gitRoot, {
    conversationScopeId: "conversation-checkout",
  });
  const closedCheckout = await firstRegistry.closeWorkspace(checkout.workspace.id);
  assert.equal(closedCheckout.status, "closed");
  assert.equal(closedCheckout.removedWorktree, false);
  assert.equal((await stat(gitRoot)).isDirectory(), true);
  assert.equal(firstStore.getSession(checkout.workspace.id)?.status, "closed");
  assert.equal(
    firstStore.hasConversationBindingsForSession(checkout.workspace.id),
    false,
  );
  assert.throws(() => firstRegistry.getWorkspace(checkout.workspace.id), /closed/);

  const reopenedCheckout = await firstRegistry.openWorkspace(gitRoot, {
    conversationScopeId: "conversation-checkout",
  });
  assert.notEqual(reopenedCheckout.workspace.id, checkout.workspace.id);

  const cleanWorktree = await firstRegistry.openWorkspace({
    path: gitRoot,
    mode: "worktree",
  });
  const cleanWorktreePath = cleanWorktree.workspace.root;
  const closedCleanWorktree = await firstRegistry.closeWorkspace(cleanWorktree.workspace.id);
  assert.equal(closedCleanWorktree.status, "closed");
  assert.equal(closedCleanWorktree.removedWorktree, true);
  await assert.rejects(() => stat(cleanWorktreePath), { code: "ENOENT" });

  const dirtyWorktree = await firstRegistry.openWorkspace({
    path: gitRoot,
    mode: "worktree",
  });
  const dirtyPath = dirtyWorktree.workspace.root;
  const dirtyFile = join(dirtyPath, "dirty.txt");
  await writeFile(dirtyFile, "keep me\n");
  const failedDirtyClose = await firstRegistry.closeWorkspace(dirtyWorktree.workspace.id);
  assert.equal(failedDirtyClose.status, "cleanup_failed");
  assert.equal(failedDirtyClose.removedWorktree, false);
  assert.match(failedDirtyClose.reason ?? "", /uncommitted changes/);
  assert.equal((await stat(dirtyPath)).isDirectory(), true);
  await rm(dirtyFile);
  const retriedDirtyClose = await firstRegistry.closeWorkspace(dirtyWorktree.workspace.id);
  assert.equal(retriedDirtyClose.status, "closed");
  assert.equal(retriedDirtyClose.removedWorktree, true);

  const discardedWorktree = await firstRegistry.openWorkspace({
    path: gitRoot,
    mode: "worktree",
  });
  await writeFile(join(discardedWorktree.workspace.root, "discard.txt"), "discard me\n");
  const discardedClose = await firstRegistry.closeWorkspace(
    discardedWorktree.workspace.id,
    { discardChanges: true },
  );
  assert.equal(discardedClose.status, "closed");
  assert.equal(discardedClose.removedWorktree, true);

  const restoredCheckout = await firstRegistry.openWorkspace(gitRoot, {
    conversationScopeId: "conversation-restore",
  });
  const restoredWorktree = await firstRegistry.openWorkspace({
    path: gitRoot,
    mode: "worktree",
  });
  const missingCheckoutRoot = join(root, "missing-restored-checkout");
  await mkdir(missingCheckoutRoot);
  const missingRestoredCheckout = await firstRegistry.openWorkspace(missingCheckoutRoot, {
    conversationScopeId: "conversation-missing-restore",
  });
  const missingRestoredWorktree = await firstRegistry.openWorkspace({
    path: gitRoot,
    mode: "worktree",
  });
  const unregisteredRestoredWorktree = await firstRegistry.openWorkspace({
    path: gitRoot,
    mode: "worktree",
  });
  firstRegistry.detachAll();
  assert.equal(firstStore.getSession(restoredCheckout.workspace.id)?.status, "detached");
  assert.equal(firstStore.getSession(restoredWorktree.workspace.id)?.status, "detached");
  await rm(missingCheckoutRoot, { recursive: true, force: true });
  await git(gitRoot, [
    "worktree",
    "remove",
    "--force",
    missingRestoredWorktree.workspace.root,
  ]);
  await git(gitRoot, [
    "worktree",
    "remove",
    "--force",
    unregisteredRestoredWorktree.workspace.root,
  ]);
  await mkdir(unregisteredRestoredWorktree.workspace.root);
  firstStore.close();

  const secondStore = new SqliteWorkspaceStore(stateDir);
  const secondRegistry = new WorkspaceRegistry(config, secondStore);
  assert.equal(secondRegistry.getWorkspace(restoredCheckout.workspace.id).root, gitRoot);
  assert.equal(secondStore.getSession(restoredCheckout.workspace.id)?.status, "open");
  assert.equal(
    secondRegistry.getWorkspace(restoredWorktree.workspace.id).root,
    restoredWorktree.workspace.root,
  );
  assert.equal(secondStore.getSession(restoredWorktree.workspace.id)?.status, "open");
  assert.throws(
    () => secondRegistry.getWorkspace(missingRestoredCheckout.workspace.id),
    /orphaned/,
  );
  assert.equal(
    secondStore.getSession(missingRestoredCheckout.workspace.id)?.status,
    "orphaned",
  );
  assert.throws(
    () => secondRegistry.getWorkspace(missingRestoredWorktree.workspace.id),
    /orphaned/,
  );
  assert.equal(
    secondStore.getSession(missingRestoredWorktree.workspace.id)?.status,
    "orphaned",
  );
  assert.throws(
    () => secondRegistry.getWorkspace(unregisteredRestoredWorktree.workspace.id),
    /cleanup_failed/,
  );
  assert.equal(
    secondStore.getSession(unregisteredRestoredWorktree.workspace.id)?.status,
    "cleanup_failed",
  );
  secondRegistry.detachAll();
  secondStore.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
