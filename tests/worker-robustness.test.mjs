import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  listJobs,
  readJobFile,
  resolveJobFile,
  resolveJobsDir,
  upsertJob,
  writeJobFile,
  writeFileAtomic
} from "../plugins/codex/scripts/lib/state.mjs";
import { reconcileStaleJobs } from "../plugins/codex/scripts/lib/job-control.mjs";
import { isProcessAlive } from "../plugins/codex/scripts/lib/process.mjs";
import { promptLooksLikeFlagsOnly } from "../plugins/codex/scripts/codex-companion.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

function makeWorkspace() {
  const repo = makeTempDir();
  initGitRepo(repo);
  return repo;
}

function seedQueuedJob(repo, jobId, overrides = {}) {
  const jobsDir = resolveJobsDir(repo);
  fs.mkdirSync(jobsDir, { recursive: true });
  const logFile = path.join(jobsDir, `${jobId}.log`);
  fs.writeFileSync(logFile, "", "utf8");
  const record = {
    id: jobId,
    kind: "task",
    title: "Codex Task",
    workspaceRoot: repo,
    jobClass: "task",
    summary: "seeded",
    write: false,
    createdAt: new Date().toISOString(),
    status: "queued",
    phase: "queued",
    pid: null,
    logFile,
    eventFile: path.join(jobsDir, `${jobId}.events.jsonl`),
    signalFile: path.join(jobsDir, `${jobId}.done`),
    request: {
      cwd: repo,
      model: null,
      effort: null,
      prompt: "investigate the failing test",
      write: false,
      resumeLast: false,
      jobId
    },
    ...overrides
  };
  writeJobFile(repo, jobId, record);
  upsertJob(repo, record);
  return record;
}

test("task --help prints usage instead of forwarding '--help' to Codex", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const repo = makeWorkspace();

  const result = run("node", [SCRIPT, "task", "--help"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.equal(listJobs(repo).length, 0, "no job must be created for --help");

  const short = run("node", [SCRIPT, "task", "-h", "--background"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(short.status, 0, short.stderr);
  assert.match(short.stdout, /Usage:/);
});

test("task rejects a prompt that is only unrecognized flags", () => {
  assert.equal(promptLooksLikeFlagsOnly("--verbose --foo=bar"), true);
  assert.equal(promptLooksLikeFlagsOnly("fix the --verbose flag handling"), false);
  assert.equal(promptLooksLikeFlagsOnly(""), false);

  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const repo = makeWorkspace();
  const result = run("node", [SCRIPT, "task", "--json", "--wibble"], { cwd: repo, env: buildEnv(binDir) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only contains unrecognized flags/);
  assert.equal(listJobs(repo).length, 0);
});

test("task --background persists the request before spawning the worker and records the worker pid", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const repo = makeWorkspace();

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(launched.status, 0, launched.stderr);
  const payload = JSON.parse(launched.stdout);

  // The job record must already carry the request; the index learns the worker pid.
  const stored = readJobFile(resolveJobFile(repo, payload.jobId));
  assert.ok(stored.request && stored.request.prompt, "request payload must be persisted with the queued record");
  const indexed = listJobs(repo).find((job) => job.id === payload.jobId);
  assert.equal(typeof indexed.pid, "number");
  assert.ok(isProcessAlive(indexed.pid) || fs.existsSync(payload.signalFile));

  await waitFor(() => fs.existsSync(payload.signalFile));
  const final = readJobFile(resolveJobFile(repo, payload.jobId));
  assert.equal(final.status, "completed", JSON.stringify(final));
  assert.match(fs.readFileSync(payload.signalFile, "utf8"), /completed/);
});

test("task-worker waits for a late job record instead of exiting silently", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const repo = makeWorkspace();
  const jobId = "task-late-record";
  fs.mkdirSync(resolveJobsDir(repo), { recursive: true });

  const worker = spawn(process.execPath, [SCRIPT, "task-worker", "--cwd", repo, "--job-id", jobId], {
    cwd: repo,
    env: buildEnv(binDir),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  worker.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  // Simulate the slow parent: the record shows up well after the worker started.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  seedQueuedJob(repo, jobId);

  const exitCode = await new Promise((resolve) => worker.on("exit", resolve));
  assert.equal(exitCode, 0, stderr);
  const final = readJobFile(resolveJobFile(repo, jobId));
  assert.equal(final.status, "completed", JSON.stringify(final));
  assert.ok(fs.existsSync(path.join(resolveJobsDir(repo), `${jobId}.done`)));
});

test("task-worker marks the job failed and writes the signal file when it cannot start", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const repo = makeWorkspace();
  const jobId = "task-broken-record";
  // Present, queued, but without a request payload → worker must fail fast, not vanish.
  seedQueuedJob(repo, jobId, { request: null });

  const env = { ...buildEnv(binDir) };
  const result = run("node", [SCRIPT, "task-worker", "--cwd", repo, "--job-id", jobId], { cwd: repo, env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing its task request payload/);

  const final = readJobFile(resolveJobFile(repo, jobId));
  assert.equal(final.status, "failed");
  assert.match(final.errorMessage, /missing its task request payload/);
  const signalFile = path.join(resolveJobsDir(repo), `${jobId}.done`);
  assert.ok(fs.existsSync(signalFile), "signal file must exist so Monitor-based waiters wake up");
  assert.match(fs.readFileSync(signalFile, "utf8"), /failed/);
  assert.match(fs.readFileSync(final.logFile, "utf8"), /Failed before start/);
  const indexed = listJobs(repo).find((job) => job.id === jobId);
  assert.equal(indexed.status, "failed");
});

test("task-worker does not rerun a job that is no longer queued", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const repo = makeWorkspace();
  const jobId = "task-already-done";
  seedQueuedJob(repo, jobId, { status: "completed", phase: "done" });

  const result = run("node", [SCRIPT, "task-worker", "--cwd", repo, "--job-id", jobId], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /worker exiting without rerun/);
  assert.equal(readJobFile(resolveJobFile(repo, jobId)).status, "completed");
});

test("status reconciles a job whose worker process is dead into failed and writes the signal file", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const repo = makeWorkspace();
  const jobId = "task-dead-worker";
  // Pick a pid that is certainly not alive.
  let deadPid = 2 ** 22 - 7;
  while (isProcessAlive(deadPid)) {
    deadPid -= 1;
  }
  seedQueuedJob(repo, jobId, { status: "running", phase: "investigating", pid: deadPid });

  const result = run("node", [SCRIPT, "status", jobId, "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout);
  assert.equal(snapshot.job.status, "failed");
  assert.match(snapshot.job.errorMessage, new RegExp(`Worker process ${deadPid} exited`));
  assert.ok(fs.existsSync(path.join(resolveJobsDir(repo), `${jobId}.done`)));
  assert.equal(readJobFile(resolveJobFile(repo, jobId)).status, "failed");

  // result now works (job is terminal) and cancel refuses (nothing active).
  const shown = run("node", [SCRIPT, "result", jobId, "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(shown.status, 0, shown.stderr);
  const cancel = run("node", [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.notEqual(cancel.status, 0);
});

test("reconcileStaleJobs keeps live jobs and freshly queued jobs untouched", () => {
  const repo = makeWorkspace();
  const live = seedQueuedJob(repo, "task-live", { status: "running", pid: process.pid });
  const fresh = seedQueuedJob(repo, "task-fresh", { pid: null });
  const reconciled = reconcileStaleJobs(repo, [live, fresh]);
  assert.equal(reconciled[0].status, "running");
  assert.equal(reconciled[1].status, "queued");

  const old = seedQueuedJob(repo, "task-old", {
    pid: null,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString()
  });
  const [stale] = reconcileStaleJobs(repo, [old]);
  assert.equal(stale.status, "failed");
  assert.match(stale.errorMessage, /never started/);
});

test("reconcileStaleJobs adopts a terminal job file that the index missed", () => {
  const repo = makeWorkspace();
  const record = seedQueuedJob(repo, "task-index-lag", { status: "running", pid: process.pid });
  writeJobFile(repo, record.id, { ...record, status: "completed", phase: "done", pid: null, completedAt: "2026-01-01T00:00:00.000Z" });
  const [reconciled] = reconcileStaleJobs(repo, [record]);
  assert.equal(reconciled.status, "completed");
  assert.equal(listJobs(repo).find((job) => job.id === record.id).status, "completed");
});

test("job and state files are written atomically", () => {
  const repo = makeWorkspace();
  const jobsDir = resolveJobsDir(repo);
  fs.mkdirSync(jobsDir, { recursive: true });
  const target = path.join(jobsDir, "atomic.json");
  writeFileAtomic(target, '{"ok":true}\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { ok: true });
  assert.deepEqual(fs.readdirSync(jobsDir).filter((name) => name.endsWith(".tmp")), [], "no temp files left behind");

  seedQueuedJob(repo, "task-atomic");
  assert.deepEqual(
    fs.readdirSync(path.dirname(jobsDir)).filter((name) => name.endsWith(".tmp")),
    [],
    "state.json must not leave temp files"
  );
});

test("isProcessAlive reports the current process as alive and an impossible pid as dead", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(Number.NaN), false);
  assert.equal(isProcessAlive(0, { killImpl: () => { throw Object.assign(new Error("x"), { code: "ESRCH" }); } }), false);
  assert.equal(isProcessAlive(1, { killImpl: () => { throw Object.assign(new Error("x"), { code: "EPERM" }); } }), true);
});

test("task reads a prompt from a child_process stdin pipe (socket) and skips flags-only check after --", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const repo = makeWorkspace();
  const piped = run("node", [SCRIPT, "task", "--json"], { cwd: repo, env: buildEnv(binDir), input: "investigate the failing test" });
  assert.equal(piped.status, 0, piped.stderr);
  const pipedJob = listJobs(repo)[0];
  assert.equal(readJobFile(resolveJobFile(repo, pipedJob.id)).request.prompt, "investigate the failing test");

  const literal = run("node", [SCRIPT, "task", "--json", "--", "--verbose"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(literal.status, 0, literal.stderr);
});

test("reconcileStaleJobs treats a job started before the last boot as dead even if its pid is alive", () => {
  const repo = makeWorkspace();
  const job = seedQueuedJob(repo, "task-pre-boot", {
    status: "running",
    pid: process.pid,
    startedAt: "2020-01-01T00:00:00.000Z",
    createdAt: "2020-01-01T00:00:00.000Z"
  });
  const [reconciled] = reconcileStaleJobs(repo, [job], { uptimeSeconds: 60 });
  assert.equal(reconciled.status, "failed");
  assert.match(reconciled.errorMessage, /predates the last system boot/);
});
