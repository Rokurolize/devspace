import { spawn } from "node:child_process";
import { readdirSync, statSync, watch } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(
  process.env.DEVSPACE_DEV_REPO_ROOT
    ?? fileURLToPath(new URL("..", import.meta.url)),
);
const sourceRoot = join(repoRoot, "src");
const uiRoot = join(sourceRoot, "ui");
const restartDelayMs = 750;
const crashDelayMs = 1500;
const initialBuildCommand = commandFromEnvironment(
  "DEVSPACE_DEV_INITIAL_BUILD_COMMAND",
  ["npx", "vite", "build"],
);
const uiWatchCommand = commandFromEnvironment(
  "DEVSPACE_DEV_UI_WATCH_COMMAND",
  ["npx", "vite", "build", "--watch"],
);
const serverCommand = commandFromEnvironment(
  "DEVSPACE_DEV_SERVER_COMMAND",
  ["npx", "tsx", "src/cli.ts", "serve"],
);

let serverChild;
let uiChild;
let initialBuildChild;
let restartTimer;
let restartPromise;
let restartingServer = false;
let shuttingDown = false;
const watchers = [];

function log(message) {
  console.error(`[devspace:dev] ${message}`);
}

function commandFromEnvironment(name, fallback) {
  const value = process.env[name];
  if (!value) return { executable: fallback[0], args: fallback.slice(1) };

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${name} must be a JSON string array: ${error.message}`);
  }
  if (
    !Array.isArray(parsed)
    || parsed.length === 0
    || parsed.some((part) => typeof part !== "string" || part.length === 0)
  ) {
    throw new Error(`${name} must be a non-empty JSON string array.`);
  }
  return { executable: parsed[0], args: parsed.slice(1) };
}

function spawnCommand(command, extraEnv = {}) {
  return spawn(command.executable, command.args, {
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
    windowsHide: true,
  });
}

async function runInitialUiBuild() {
  log("building the initial MCP app bundle");
  initialBuildChild = spawnCommand(initialBuildCommand);
  const current = initialBuildChild;
  let result;
  try {
    result = await waitForExit(current);
  } finally {
    if (initialBuildChild === current) initialBuildChild = undefined;
  }
  if (shuttingDown) {
    throw new Error("initial MCP app build was interrupted by shutdown");
  }
  if (result.code !== 0) {
    throw new Error(
      `initial MCP app build failed (${result.signal ?? result.code ?? "unknown"})`,
    );
  }
}

function startUiWatcher() {
  uiChild = spawnCommand(uiWatchCommand, { DEVSPACE_VITE_WATCH: "1" });
  const current = uiChild;
  current.on("error", (error) => {
    if (uiChild === current) uiChild = undefined;
    if (shuttingDown) return;
    log(`UI builder failed to start: ${error.message}`);
    void shutdown(1);
  });
  current.on("exit", (code, signal) => {
    if (uiChild === current) uiChild = undefined;
    if (shuttingDown) return;
    log(`UI builder exited (${signal ?? code ?? "unknown"}); stopping development server`);
    void shutdown(1);
  });
}

function startServer() {
  restartingServer = false;
  serverChild = spawnCommand(serverCommand);
  const current = serverChild;
  current.on("error", (error) => {
    if (serverChild === current) serverChild = undefined;
    if (shuttingDown || restartingServer) return;
    log(`server failed to start: ${error.message}`);
    void shutdown(1);
  });
  current.on("exit", (code, signal) => {
    if (serverChild === current) serverChild = undefined;
    if (shuttingDown || restartingServer) return;

    log(`server exited (${signal ?? code ?? "unknown"}); restarting in ${crashDelayMs}ms`);
    scheduleRestart(crashDelayMs);
  });
}

function scheduleRestart(delayMs = restartDelayMs) {
  if (restartPromise) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => void restartServer(), delayMs);
}

function restartServer() {
  if (restartPromise) return restartPromise;
  restartPromise = performRestart().finally(() => {
    restartPromise = undefined;
  });
  return restartPromise;
}

async function performRestart() {
  if (shuttingDown) return;
  clearTimeout(restartTimer);

  const current = serverChild;
  if (!current) {
    startServer();
    return;
  }

  restartingServer = true;
  await terminateChild(current);
  if (!shuttingDown) startServer();
}

function watchDirectory(root) {
  const seen = new Set();

  function addDirectory(directory) {
    if (isUiPath(directory) || seen.has(directory)) return;
    seen.add(directory);

    const watcher = watch(directory, (event, filename) => {
      if (!filename) {
        scheduleRestart();
        return;
      }

      const path = join(directory, filename.toString());
      if (isUiPath(path)) return;
      if (event === "rename") maybeAddDirectory(path);
      scheduleRestart();
    });
    watchers.push(watcher);

    for (const entry of readdirSync(directory)) {
      maybeAddDirectory(join(directory, entry));
    }
  }

  function maybeAddDirectory(path) {
    if (isUiPath(path)) return;
    try {
      if (statSync(path).isDirectory()) addDirectory(path);
    } catch {
      // The file may have been deleted between the watch event and stat call.
    }
  }

  addDirectory(root);
}

function isUiPath(path) {
  const relationship = relative(uiRoot, resolve(path));
  return (
    relationship === ""
    || (
      !isAbsolute(relationship)
      && relationship !== ".."
      && !relationship.startsWith(`..${sep}`)
    )
  );
}

async function terminateChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  const exited = waitForExit(child);
  child.kill("SIGTERM");
  const forceTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 3000);
  forceTimer.unref();
  await exited;
  clearTimeout(forceTimer);
}

function waitForExit(child) {
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(restartTimer);
  for (const watcher of watchers) watcher.close();
  await Promise.all([
    terminateChild(initialBuildChild),
    terminateChild(serverChild),
    terminateChild(uiChild),
  ]);
  process.exit(exitCode);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => void shutdown(0));
}

try {
  await runInitialUiBuild();
  startUiWatcher();
  watchDirectory(sourceRoot);
  log("watching backend sources; UI changes rebuild without restarting MCP sessions");
  startServer();
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  await shutdown(1);
}
