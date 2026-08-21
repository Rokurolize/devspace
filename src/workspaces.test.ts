import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { loadConfig, type ServerConfig } from "./config.js";
import { GitWorktreeError } from "./git-worktrees.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);

test("a checkout exposes initial and nested instruction context while filtering outside symlinks", async (t) => {
  const context = await fixture(t);
  const opened = await context.registry.openWorkspace(context.root);

  assert.match(opened.workspace.id, /^ws_[a-f0-9]{10}$/);
  assert.equal(opened.workspace.mode, "checkout");
  assert.deepEqual(
    opened.agentsFiles.map((file) => file.content),
    ["global instructions\n", "root instructions\n"],
  );
  assert.deepEqual(
    opened.availableAgentsFiles.map((file) => file.path),
    [join(context.root, "nested", "AGENTS.md")],
  );
  assert.deepEqual(
    opened.workspace.agentProfiles.map((profile) => ({
      name: profile.name,
      description: profile.description,
      provider: profile.provider,
      body: profile.body,
    })),
    [{
      name: "reviewer",
      description: "Read-only project reviewer.",
      provider: "codex",
      body: "Review only.",
    }],
  );

  if (platform() !== "win32") {
    const unsafeAgentDir = join(context.root, ".pi", "unsafe-agent");
    await mkdir(unsafeAgentDir, { recursive: true });
    await writeFile(join(context.outsideRoot, "secret.txt"), "outside secret\n");
    await symlink(join(context.outsideRoot, "secret.txt"), join(unsafeAgentDir, "AGENTS.md"));

    const unsafeConfig = loadConfig({
      DEVSPACE_CONFIG_DIR: join(context.root, ".devspace-unsafe-home"),
      DEVSPACE_ALLOWED_ROOTS: context.root,
      DEVSPACE_WORKTREE_ROOT: join(context.root, ".devspace", "unsafe-worktrees"),
      DEVSPACE_AGENT_DIR: unsafeAgentDir,
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "1",
    });
    const unsafeWorkspace = await new WorkspaceRegistry(unsafeConfig).openWorkspace(context.root);

    assert.deepEqual(
      unsafeWorkspace.agentsFiles.map((file) => file.content),
      ["root instructions\n"],
    );
  }
});

test("a checkout walk skips nested git repositories when discovering instruction files", async (t) => {
  const context = await fixture(t);
  const gitProject = await createGitProject(context.root);
  await mkdir(join(gitProject, "nested"));
  await writeFile(join(gitProject, "nested", "AGENTS.md"), "git nested instructions\n");
  await mkdir(join(context.root, "plain-nested"));
  await writeFile(join(context.root, "plain-nested", "AGENTS.md"), "plain nested instructions\n");

  const opened = await context.registry.openWorkspace(context.root);

  assert.deepEqual(
    opened.availableAgentsFiles.map((file) => file.path),
    [
      join(context.root, "nested", "AGENTS.md"),
      join(context.root, "plain-nested", "AGENTS.md"),
    ],
  );
});

test("opening a missing checkout creates its workspace root", async (t) => {
  const context = await fixture(t);
  const missingRoot = join(context.root, "missing", "workspace");

  const opened = await context.registry.openWorkspace(missingRoot);
  assert.equal(opened.workspace.root, missingRoot);
  assert.equal((await stat(missingRoot)).isDirectory(), true);
});

test("checkoutOnly config forces checkout mode even when worktree is requested", async (t) => {
  const context = await fixture(t, { checkoutOnly: true });
  const gitRoot = await createGitProject(context.root);

  const opened = await context.registry.openWorkspace({ path: gitRoot, mode: "worktree" });

  assert.equal(opened.workspace.mode, "checkout");
  assert.equal(opened.workspace.root, gitRoot);
});

test("worktree opens require Git and create an isolated managed workspace", async (t) => {
  const context = await fixture(t);

  await assert.rejects(
    () => context.registry.openWorkspace({ path: context.root, mode: "worktree" }),
    (error: unknown) =>
      error instanceof GitWorktreeError && error.code === "GIT_REPOSITORY_NOT_FOUND",
  );

  const gitRoot = await createGitProject(context.root);
  await writeFile(join(gitRoot, "dirty.txt"), "not copied\n");

  const opened = await context.registry.openWorkspace({ path: gitRoot, mode: "worktree" });

  assert.equal(opened.workspace.mode, "worktree");
  assert.notEqual(opened.workspace.root, gitRoot);
  assert.equal(opened.workspace.sourceRoot, gitRoot);
  assert.equal(opened.workspace.worktree?.baseRef, "HEAD");
  assert.equal(opened.workspace.worktree?.dirtySource, true);
  assert.equal(opened.workspace.worktree?.managed, true);
  assert.equal((await stat(opened.workspace.root)).isDirectory(), true);
  assert.match(opened.agentsFiles.map((file) => file.content).join("\n"), /global instructions/);
  assert.match(opened.agentsFiles.map((file) => file.content).join("\n"), /git root instructions/);

  const resolvedReadme = context.registry.resolvePath(opened.workspace, "README.md");
  assert.equal(resolvedReadme.startsWith(opened.workspace.root), true);
});

test("failed worktree context initialization removes the managed worktree", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const configDir = join(context.root, ".failing-devspace");
  const agentsDir = join(configDir, "agents");
  const worktreeRoot = join(context.root, ".failing-worktrees");
  const stateDir = join(context.root, ".failing-state");
  await mkdir(configDir, { recursive: true });
  await writeFile(agentsDir, "not a directory\n");

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: context.root,
    DEVSPACE_WORKTREE_ROOT: worktreeRoot,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_AGENT_DIR: context.agentDir,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const store = new SqliteWorkspaceStore(stateDir);
  const registry = new WorkspaceRegistry(config, store);
  t.after(() => store.close());

  await assert.rejects(
    () => registry.openWorkspace({ path: gitRoot, mode: "worktree" }),
    /not a directory|ENOTDIR/i,
  );
  assert.deepEqual(await readdir(worktreeRoot), []);
  assert.equal(store.listSessions().length, 0);

  const worktreeList = await execFileAsync(
    "git",
    ["worktree", "list", "--porcelain", "-z"],
    { cwd: gitRoot, encoding: "utf8" },
  );
  assert.deepEqual(
    worktreeList.stdout
      .split("\0")
      .filter((field) => field.startsWith("worktree "))
      .map((field) => field.slice("worktree ".length)),
    [gitRoot],
  );
});

test("failed worktree compensation persists a cleanup record", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const configDir = join(context.root, ".cleanup-failure-devspace");
  const agentsPath = join(configDir, "agents");
  const worktreeRoot = join(context.root, ".cleanup-failure-worktrees");
  const stateDir = join(context.root, ".cleanup-failure-state");
  await mkdir(configDir, { recursive: true });
  await writeFile(agentsPath, "not a directory\n");

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: context.root,
    DEVSPACE_WORKTREE_ROOT: worktreeRoot,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_AGENT_DIR: context.agentDir,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const store = new SqliteWorkspaceStore(stateDir);
  const registry = new WorkspaceRegistry(config, store, {
    removeManagedWorktree: async () => {
      throw new Error("simulated cleanup failure");
    },
  });

  let leakedWorktree: string | undefined;
  try {
    await assert.rejects(
      () => registry.openWorkspace({ path: gitRoot, mode: "worktree" }),
      (error: unknown) => error instanceof AggregateError,
    );
    const sessions = store.listSessions();
    assert.equal(sessions.length, 1);
    const [session] = sessions;
    assert.ok(session);
    leakedWorktree = session.root;
    assert.equal(session.mode, "worktree");
    assert.equal(session.managed, true);
    assert.equal(session.status, "cleanup_failed");
    assert.match(session.statusReason ?? "", /simulated cleanup failure/);
    assert.equal((await stat(session.root)).isDirectory(), true);
  } finally {
    if (leakedWorktree) {
      await git(gitRoot, ["worktree", "remove", "--force", leakedWorktree]);
    }
    store.close();
  }
});

test("Git workspaces discover only tracked and standard non-ignored nested instructions", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  await writeFile(join(gitRoot, ".gitignore"), "ignored-context/\n");
  await mkdir(join(gitRoot, "tracked-context"));
  await writeFile(join(gitRoot, "tracked-context", "AGENTS.md"), "tracked instructions\n");
  await mkdir(join(gitRoot, "sibling-context"));
  await writeFile(join(gitRoot, "sibling-context", "CLAUDE.md"), "sibling instructions\n");
  await mkdir(join(gitRoot, "deleted-context"));
  await writeFile(join(gitRoot, "deleted-context", "AGENTS.md"), "deleted instructions\n");
  await git(gitRoot, ["add", ".gitignore", "tracked-context", "sibling-context", "deleted-context"]);
  await git(gitRoot, ["commit", "-m", "Add nested instructions"]);
  await rm(join(gitRoot, "deleted-context", "AGENTS.md"));

  await mkdir(join(gitRoot, "untracked-context"));
  await writeFile(join(gitRoot, "untracked-context", "CLAUDE.md"), "untracked instructions\n");
  await mkdir(join(gitRoot, "ignored-context"));
  await writeFile(join(gitRoot, "ignored-context", "AGENTS.md"), "ignored instructions\n");

  const nestedRepository = join(gitRoot, "nested-repository");
  await mkdir(nestedRepository);
  await git(nestedRepository, ["init"]);
  await git(nestedRepository, ["config", "user.email", "devspace@example.com"]);
  await git(nestedRepository, ["config", "user.name", "DevSpace Test"]);
  await writeFile(join(nestedRepository, "AGENTS.md"), "nested repository instructions\n");
  await git(nestedRepository, ["add", "AGENTS.md"]);
  await git(nestedRepository, ["commit", "-m", "Initial commit"]);

  if (platform() !== "win32") {
    await mkdir(join(gitRoot, "symlink-context"));
    await writeFile(join(context.outsideRoot, "AGENTS.md"), "outside instructions\n");
    await symlink(
      join(context.outsideRoot, "AGENTS.md"),
      join(gitRoot, "symlink-context", "AGENTS.md"),
    );
    await git(gitRoot, ["add", "symlink-context/AGENTS.md"]);
  }

  const opened = await context.registry.openWorkspace(gitRoot);
  assert.deepEqual(
    opened.availableAgentsFiles.map((file) => file.path),
    [
      join(gitRoot, "sibling-context", "CLAUDE.md"),
      join(gitRoot, "tracked-context", "AGENTS.md"),
      join(gitRoot, "untracked-context", "CLAUDE.md"),
    ],
  );

  const subdirectory = await context.registry.openWorkspace(join(gitRoot, "tracked-context"));
  assert.deepEqual(
    subdirectory.agentsFiles.map((file) => file.content),
    ["global instructions\n", "tracked instructions\n"],
  );
  assert.deepEqual(subdirectory.availableAgentsFiles, []);

  const nested = await context.registry.openWorkspace(nestedRepository);
  assert.deepEqual(
    nested.agentsFiles.map((file) => file.content),
    ["global instructions\n", "nested repository instructions\n"],
  );
});

test("persisted checkout and worktree sessions restore after recreating the registry", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const stateDir = join(context.root, ".state");
  const firstStore = new SqliteWorkspaceStore(stateDir);
  const firstRegistry = new WorkspaceRegistry(context.config, firstStore);

  const checkout = await firstRegistry.openWorkspace(context.root);
  const worktree = await firstRegistry.openWorkspace({ path: gitRoot, mode: "worktree" });
  firstStore.close();

  const secondStore = new SqliteWorkspaceStore(stateDir);
  try {
    const restoredRegistry = new WorkspaceRegistry(context.config, secondStore);
    const restoredCheckout = restoredRegistry.getWorkspace(checkout.workspace.id);
    const restoredWorktree = restoredRegistry.getWorkspace(worktree.workspace.id);

    assert.equal(restoredCheckout.root, context.root);
    assert.equal(restoredCheckout.mode, "checkout");
    assert.equal(restoredWorktree.root, worktree.workspace.root);
    assert.equal(restoredWorktree.mode, "worktree");
    assert.equal(restoredWorktree.sourceRoot, gitRoot);
    assert.equal(restoredWorktree.worktree?.managed, true);
  } finally {
    secondStore.close();
  }
});

test("workspace paths outside the allowed roots are rejected", async (t) => {
  const context = await fixture(t);

  await assert.rejects(
    () => context.registry.openWorkspace(context.outsideRoot),
    /outside allowed roots/,
  );
});

test("a symlinked allowed root preserves checkout and worktree path behavior", { skip: platform() === "win32" }, async (t) => {
  const context = await fixture(t);
  const aliasRoot = join(context.root, "alias-root");
  await symlink(context.root, aliasRoot, "dir");
  await createGitProject(context.root);

  const aliasConfig = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: aliasRoot,
    DEVSPACE_WORKTREE_ROOT: join(aliasRoot, ".devspace", "alias-worktrees"),
    DEVSPACE_AGENT_DIR: context.agentDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const aliasRegistry = new WorkspaceRegistry(aliasConfig);

  const worktree = await aliasRegistry.openWorkspace({
    path: join(aliasRoot, "git-project"),
    mode: "worktree",
  });
  const checkout = await aliasRegistry.openWorkspace(aliasRoot);

  assert.equal(worktree.workspace.sourceRoot, join(aliasRoot, "git-project"));
  assert.deepEqual(
    checkout.agentsFiles.map((file) => file.content),
    ["global instructions\n", "root instructions\n"],
  );
});

interface WorkspaceFixture {
  root: string;
  outsideRoot: string;
  agentDir: string;
  config: ServerConfig;
  registry: WorkspaceRegistry;
}

async function fixture(
  t: TestContext,
  options: { checkoutOnly?: boolean } = {},
): Promise<WorkspaceFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-workspace-test-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "devspace-workspace-outside-test-"));
  const agentDir = join(root, ".pi", "agent");

  if (platform() === "win32") {
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  } else {
    await mkdir(join(agentDir, "skills"), { recursive: true });
    await writeFile(join(agentDir, "skills", "AGENTS.md"), "global instructions\n");
    await symlink("skills/AGENTS.md", join(agentDir, "AGENTS.md"));
  }

  await writeFile(join(root, "AGENTS.md"), "root instructions\n");
  await mkdir(join(root, ".devspace", "agents"), { recursive: true });
  await writeFile(
    join(root, ".devspace", "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: Read-only project reviewer.",
      "provider: codex",
      "---",
      "",
      "Review only.",
      "",
    ].join("\n"),
  );
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "AGENTS.md"), "nested instructions\n");
  await writeFile(join(root, "nested", "file.txt"), "hello\n");

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".devspace-home"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".devspace", "worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_SUBAGENTS: "1",
    ...(options.checkoutOnly ? { DEVSPACE_CHECKOUT_ONLY: "1" } : {}),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });

  return {
    root,
    outsideRoot,
    agentDir,
    config,
    registry: new WorkspaceRegistry(config),
  };
}

async function createGitProject(parent: string): Promise<string> {
  const gitRoot = join(parent, "git-project");
  await mkdir(gitRoot);
  await writeFile(join(gitRoot, "AGENTS.md"), "git root instructions\n");
  await writeFile(join(gitRoot, "README.md"), "hello\n");
  await git(gitRoot, ["init"]);
  await git(gitRoot, ["config", "user.email", "devspace@example.com"]);
  await git(gitRoot, ["config", "user.name", "DevSpace Test"]);
  await git(gitRoot, ["add", "."]);
  await git(gitRoot, ["commit", "-m", "Initial commit"]);
  return gitRoot;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
