import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

for (const flag of ["-v", "--version"]) {
  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", flag], {
    encoding: "utf8",
    env: { ...process.env, DEVSPACE_CONFIG_DIR: "/tmp/devspace-cli-version-test" },
  }).trim();

  assert.equal(output, packageJson.version);
}

const root = mkdtempSync(join(tmpdir(), "devspace-cli-agents-test-"));
try {
  const configDir = join(root, ".devspace");
  const stateDir = join(root, ".state");
  const projectRoot = join(root, "project");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(configDir, "agents"), { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(configDir, "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: Read-only reviewer.",
      "provider: codex",
      "model: gpt-5.4",
      "thinking: high",
      "---",
      "",
      "Review only.",
      "",
    ].join("\n"),
  );
  const store = new LocalAgentStore(stateDir);
  const current = store.update(
    store.create({
      workspaceId: "ws_current",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      provider: "codex",
      model: "gpt-5.4",
      thinking: "high",
    }).id,
    { status: "idle" },
  );
  const other = store.update(
    store.create({
      workspaceId: "ws_other",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      provider: "codex",
    }).id,
    { status: "running" },
  );
  store.close();

  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", "agents", "ls"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      DEVSPACE_CONFIG_DIR: configDir,
      DEVSPACE_ALLOWED_ROOTS: projectRoot,
      DEVSPACE_STATE_DIR: stateDir,
      DEVSPACE_WORKSPACE_ID: "ws_current",
      DEVSPACE_WORKSPACE_ROOT: projectRoot,
      DEVSPACE_SUBAGENTS: "1",
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    },
  });

  assert.match(output, new RegExp(`${current.id} idle reviewer codex gpt-5\\.4 thinking=high`));
  assert.doesNotMatch(output, /profile reviewer/);
  assert.doesNotMatch(output, new RegExp(other.id));

  assert.equal(loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  }).subagents, true);

  const pruneRoot = join(projectRoot, "missing-workspace");
  mkdirSync(pruneRoot);
  const pruneEnv = {
    ...process.env,
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_AGENT_DIR: join(root, ".agent"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  };
  const pruneConfig = loadConfig(pruneEnv);
  const pruneStore = new SqliteWorkspaceStore(stateDir);
  const pruneRegistry = new WorkspaceRegistry(pruneConfig, pruneStore);
  const pruneWorkspace = await pruneRegistry.openWorkspace(pruneRoot, {
    conversationScopeId: "cli-prune-conversation",
  });
  pruneRegistry.detachAll();
  pruneStore.close();
  rmSync(pruneRoot, { recursive: true, force: true });

  const dryRun = execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "workspaces", "prune"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: pruneEnv,
    },
  );
  assert.match(dryRun, /Workspace prune dry-run/);
  assert.match(dryRun, new RegExp(pruneWorkspace.workspace.id));
  assert.match(dryRun, /mark_orphaned/);

  assert.throws(
    () => execFileSync(
      "node",
      ["--import", "tsx", "src/cli.ts", "workspaces", "prune", "--apply"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: pruneEnv,
      },
    ),
    /requires one or more workspace IDs/,
  );

  const applied = execFileSync(
    "node",
    [
      "--import",
      "tsx",
      "src/cli.ts",
      "workspaces",
      "prune",
      "--apply",
      pruneWorkspace.workspace.id,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: pruneEnv,
    },
  );
  assert.match(applied, /Applied workspace cleanup/);

  const verifiedPruneStore = new SqliteWorkspaceStore(stateDir);
  assert.equal(
    verifiedPruneStore.getSession(pruneWorkspace.workspace.id)?.status,
    "orphaned",
  );
  verifiedPruneStore.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}
