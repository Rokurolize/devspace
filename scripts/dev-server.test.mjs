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
      '  appendFileSync(logPath, `stop ${kind} ${process.pid}\\n`);',
      '  process.exit(0);',
      '};',
      'process.on("SIGINT", stop);',
      'process.on("SIGTERM", stop);',
      'setInterval(() => undefined, 1000);',
      'await new Promise(() => undefined);',
      '',
    ].join("\n"),
  );
  await testUiAndBackendWatches(join(root, "watching"));
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

function startSupervisor(testRoot, logPath, initialExitCode) {
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
      DEVSPACE_DEV_REPO_ROOT: testRoot,
      DEVSPACE_DEV_INITIAL_BUILD_COMMAND: command("initial", initialExitCode),
      DEVSPACE_DEV_UI_WATCH_COMMAND: command("ui-watch"),
      DEVSPACE_DEV_SERVER_COMMAND: command("server"),
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
