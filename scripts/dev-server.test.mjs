import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") process.exit(0);

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const supervisorPath = join(repositoryRoot, "scripts", "dev-server.mjs");
const root = await mkdtemp(join(tmpdir(), "devspace-dev-server-test-"));
const fixturePath = join(root, "child-fixture.mjs");

try {
  await writeFile(
    fixturePath,
    [
      'import { appendFileSync } from "node:fs";',
      'const [kind, logPath, exitCode] = process.argv.slice(2);',
      'if (!kind || !logPath) process.exit(2);',
      'appendFileSync(logPath, `start ${kind} ${process.pid}\\n`);',
      'if (exitCode !== undefined) process.exit(Number(exitCode));',
      'const stop = () => {',
      '  appendFileSync(logPath, `signal ${kind} ${process.pid}\\n`);',
      '  const delay = kind === "server" ? Number(process.env.FAKE_SERVER_STOP_DELAY_MS ?? 0) : 0;',
      '  setTimeout(() => {',
      '    appendFileSync(logPath, `stop ${kind} ${process.pid}\\n`);',
      '    process.exit(0);',
      '  }, delay);',
      '};',
      'process.on("SIGINT", stop);',
      'process.on("SIGTERM", stop);',
      'setInterval(() => undefined, 1000);',
      'await new Promise(() => undefined);',
      '',
    ].join("\n"),
  );
  await testUiAndBackendWatches(join(root, "watching"));
  await testOverlappingBackendRestarts(join(root, "restart-overlap"));
  await testSpawnFailuresCleanUpChildren(join(root, "spawn-failures"));
  await testShutdownDuringInitialBuild(join(root, "initial-shutdown"));
  await testInitialBuildFailure(join(root, "initial-failure"));
} finally {
  await rm(root, { recursive: true, force: true });
}

async function testUiAndBackendWatches(testRoot) {
  const logPath = join(testRoot, "children.log");
  await mkdir(join(testRoot, "src", "ui"), { recursive: true });
  await writeFile(join(testRoot, "src", "backend.ts"), "export {};\n");
  await writeFile(join(testRoot, "src", "ui", "app.tsx"), "export {};\n");

  const supervisor = startSupervisor(testRoot, logPath, 0);
  try {
    await waitForLog(logPath, (lines) => hasStarts(lines, "ui-watch", 1) && hasStarts(lines, "server", 1));
    const firstServerPid = startedPids(await logLines(logPath), "server")[0];

    await appendFile(join(testRoot, "src", "ui", "app.tsx"), "// ui change\n");
    await delay(1400);
    assert.deepEqual(startedPids(await logLines(logPath), "server"), [firstServerPid]);

    await appendFile(join(testRoot, "src", "backend.ts"), "// backend change\n");
    await waitForLog(logPath, (lines) => hasStarts(lines, "server", 2));
    const serverPids = startedPids(await logLines(logPath), "server");
    assert.notEqual(serverPids[1], firstServerPid);
  } finally {
    supervisor.kill("SIGTERM");
  }

  const result = await waitForExit(supervisor);
  assert.equal(result.code, 0);
  const lines = await logLines(logPath);
  assert.equal(hasStops(lines, "ui-watch"), true);
  assert.equal(hasStops(lines, "server"), true);
}

async function testInitialBuildFailure(testRoot) {
  const logPath = join(testRoot, "children.log");
  await mkdir(join(testRoot, "src", "ui"), { recursive: true });
  const supervisor = startSupervisor(testRoot, logPath, 7);
  const result = await waitForExit(supervisor);
  assert.notEqual(result.code, 0);
  const lines = await logLines(logPath);
  assert.equal(hasStarts(lines, "initial", 1), true);
  assert.equal(hasStarts(lines, "ui-watch", 1), false);
  assert.equal(hasStarts(lines, "server", 1), false);
}

async function testOverlappingBackendRestarts(testRoot) {
  const logPath = join(testRoot, "children.log");
  await mkdir(join(testRoot, "src", "ui"), { recursive: true });
  await writeFile(join(testRoot, "src", "backend.ts"), "export {};\n");
  const supervisor = startSupervisor(testRoot, logPath, 0, {
    FAKE_SERVER_STOP_DELAY_MS: "1500",
  });
  try {
    await waitForLog(logPath, (lines) => hasStarts(lines, "server", 1));
    const firstServerPid = startedPids(await logLines(logPath), "server")[0];
    await appendFile(join(testRoot, "src", "backend.ts"), "// first change\n");
    await waitForLog(
      logPath,
      (lines) => lines.includes(`signal server ${firstServerPid}`),
    );
    await appendFile(join(testRoot, "src", "backend.ts"), "// overlapping change\n");
    await waitForLog(logPath, (lines) => hasStarts(lines, "server", 2));
    await delay(1200);
    assert.equal(startedPids(await logLines(logPath), "server").length, 2);
  } finally {
    supervisor.kill("SIGTERM");
  }
  assert.equal((await waitForExit(supervisor)).code, 0);
}

async function testSpawnFailuresCleanUpChildren(testRoot) {
  const serverFailureRoot = join(testRoot, "server");
  const serverLog = join(serverFailureRoot, "children.log");
  await mkdir(join(serverFailureRoot, "src", "ui"), { recursive: true });
  const serverFailure = startSupervisor(serverFailureRoot, serverLog, 0, {}, {
    server: [join(serverFailureRoot, "missing-server")],
  });
  const serverResult = await waitForExit(serverFailure);
  assert.notEqual(serverResult.code, 0);
  await assertStartedProcessesExited(await logLines(serverLog), "ui-watch");

  const uiFailureRoot = join(testRoot, "ui");
  const uiLog = join(uiFailureRoot, "children.log");
  await mkdir(join(uiFailureRoot, "src", "ui"), { recursive: true });
  const uiFailure = startSupervisor(uiFailureRoot, uiLog, 0, {}, {
    ui: [join(uiFailureRoot, "missing-ui-builder")],
  });
  const uiResult = await waitForExit(uiFailure);
  assert.notEqual(uiResult.code, 0);
  const uiLines = await logLines(uiLog);
  await assertStartedProcessesExited(uiLines, "server");
}

async function testShutdownDuringInitialBuild(testRoot) {
  const logPath = join(testRoot, "children.log");
  await mkdir(join(testRoot, "src", "ui"), { recursive: true });
  const supervisor = startSupervisor(testRoot, logPath);
  await waitForLog(logPath, (lines) => hasStarts(lines, "initial", 1));
  supervisor.kill("SIGTERM");

  const result = await waitForExit(supervisor);
  assert.equal(result.code, 0);
  const lines = await logLines(logPath);
  assert.equal(hasStops(lines, "initial"), true);
  assert.equal(hasStarts(lines, "ui-watch", 1), false);
  assert.equal(hasStarts(lines, "server", 1), false);
}

function startSupervisor(
  testRoot,
  logPath,
  initialExitCode,
  extraEnv = {},
  commandOverrides = {},
) {
  const command = (kind, exitCode) => JSON.stringify([
    process.execPath,
    fixturePath,
    kind,
    logPath,
    ...(exitCode === undefined ? [] : [String(exitCode)]),
  ]);
  return spawn(process.execPath, [supervisorPath], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ...extraEnv,
      DEVSPACE_DEV_REPO_ROOT: testRoot,
      DEVSPACE_DEV_INITIAL_BUILD_COMMAND: command("initial", initialExitCode),
      DEVSPACE_DEV_UI_WATCH_COMMAND: commandOverrides.ui
        ? JSON.stringify(commandOverrides.ui)
        : command("ui-watch"),
      DEVSPACE_DEV_SERVER_COMMAND: commandOverrides.server
        ? JSON.stringify(commandOverrides.server)
        : command("server"),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
}

async function waitForLog(logPath, predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const lines = await logLines(logPath);
    if (predicate(lines)) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for child log condition: ${logPath}`);
}

async function logLines(logPath) {
  try {
    return (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function startedPids(lines, kind) {
  return lines
    .filter((line) => line.startsWith(`start ${kind} `))
    .map((line) => Number(line.split(" ")[2]));
}

function hasStarts(lines, kind, count) {
  return startedPids(lines, kind).length >= count;
}

function hasStops(lines, kind) {
  return lines.some((line) => line.startsWith(`stop ${kind} `));
}

async function assertStartedProcessesExited(lines, kind) {
  const deadline = Date.now() + 3_000;
  for (const pid of startedPids(lines, kind)) {
    while (processExists(pid) && Date.now() < deadline) await delay(25);
    assert.equal(processExists(pid), false, `${kind} process ${pid} is still running`);
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
