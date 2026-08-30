#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { resolveCodexSandboxMode } from "./lib/codex-config.mjs";
import { createEventStream, EVENT_TYPES, emitEvent } from "./lib/event-stream.mjs";
import { handleObserveCommand } from "./lib/observe.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    importExternalAgentSession,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerTurn
  } from "./lib/codex.mjs";
import { resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { buildDiffReviewContext, collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  collectWorkspaceJobsAcrossRoots,
  generateJobId,
  getConfig,
  listJobs,
  resolveJobsDir,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  reconcileStaleJobs,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  SESSION_ID_ENV,
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  resolveSignalFile,
  runTrackedJob,
  writeCompletionSignalFile
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot, createWorktree } from "./lib/workspace.mjs";
import {
  renderHistoryReport,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);
// A `task` run defaults to whatever model is configured in Codex (`~/.codex/config.toml`).
// The rescue subagent (an LLM) has repeatedly injected a bogus/unsupported `--model`
// (e.g. `pytest`, `py_compile`), overriding that default and making every rescue fail
// with "The 'X' model is not supported". To guarantee the configured default is used,
// `task` ignores `--model` unless the operator explicitly opts into per-run overrides
// via this env var. Set it to 1/true to allow `--model` to take effect again.
const MODEL_OVERRIDE_ENV = "CODEX_COMPANION_ALLOW_MODEL_OVERRIDE";
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

// 这两个阈值同时硬编码在 commands/review.md 和 commands/adversarial-review.md 的 Step 3 里。
// 修改时**必须**同步更新两个命令模板（搜索 "files ≤" / "files >"）。
export const SMART_ESTIMATE_THRESHOLDS = {
  maxFiles: 30,
  maxTotalLines: 3000
};

const REVIEW_KINDS = {
  REVIEW: {
    name: "Review",
    template: "review",
    jobKind: "review",
    title: "Codex Review"
  },
  ADVERSARIAL: {
    name: "Adversarial Review",
    template: "adversarial-review",
    jobKind: "adversarial-review",
    title: "Codex Adversarial Review"
  }
};

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/codex-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]",
      "  node scripts/codex-companion.mjs transfer [--source <claude-jsonl>] [--json]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/codex-companion.mjs result [job-id] [--json]",
      "  node scripts/codex-companion.mjs cancel [job-id] [--json]",
      "  node scripts/codex-companion.mjs observe [job-id] [--cwd <path>]",
      "  node scripts/codex-companion.mjs history [--all] [--limit <N>] [--json]",
      "  node scripts/codex-companion.mjs diff (--file <path>|--commit <sha>|--range <a>..<b>) [focus]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

export function isModelOverrideAllowed(env = process.env) {
  const raw = env?.[MODEL_OVERRIDE_ENV];
  if (raw == null) {
    return false;
  }
  const normalized = String(raw).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

// Resolve the model for a `task` run while guaranteeing the Codex-configured
// default is used unless per-run overrides are explicitly enabled. Returns the
// model to use (null = use the config default) plus an optional note to surface.
export function resolveTaskModel(requestedModel, env = process.env) {
  const model = normalizeRequestedModel(requestedModel);
  if (!model || isModelOverrideAllowed(env)) {
    return { model, ignoredModel: null };
  }
  return { model: null, ignoredModel: model };
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh.`
    );
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/codex:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildReviewPrompt(context, focusText, reviewKind) {
  const template = loadPromptTemplate(ROOT_DIR, reviewKind.template);
  return interpolateTemplate(template, {
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /codex:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const focusText = request.focusText?.trim() ?? "";
  const reviewKind = request.reviewKind ?? REVIEW_KINDS.REVIEW;

  let context;
  let target;
  if (request.diffSpec) {
    context = buildDiffReviewContext(request.cwd, request.diffSpec);
    target = context.target;
  } else {
    target = resolveReviewTarget(request.cwd, {
      base: request.base,
      scope: request.scope
    });
    context = collectReviewContext(request.cwd, target);
  }

  const prompt = buildReviewPrompt(context, focusText, reviewKind);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewKind.name,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewKind.name,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewKind.name} finished.`),
    jobTitle: reviewKind.title,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  const codexCwd = request.worktreePath ?? workspaceRoot;
  ensureCodexAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeThreadId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const result = await runAppServerTurn(codexCwd, {
    resumeThreadId,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    sandbox: resolveCodexSandboxMode(workspaceRoot) ?? (request.write ? "workspace-write" : "read-only"),
    onProgress: request.onProgress,
    persistThread: true,
    threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write),
      requestedModel: request.model ?? null,
      worktreePath: request.worktreePath ?? null,
      worktreeBranch: request.worktreeBranch ?? null,
      worktreeBaseBranch: request.worktreeBaseBranch ?? null
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary,
    worktreePath: request.worktreePath ?? null,
    worktreeBranch: request.worktreeBranch ?? null,
    worktreeBaseBranch: request.worktreeBaseBranch ?? null
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewKind, target) {
  return {
    kind: reviewKind.jobKind,
    title: reviewKind.title,
    summary: `${reviewKind.name} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  const lines = [
    `${payload.title} started in the background.`,
    `  Job id: ${payload.jobId}`,
    "",
    "Async control:",
    `  /codex:status ${payload.jobId}     — current state, phase, recent progress`,
    `  /codex:observe ${payload.jobId}    — live event stream (read-only, Ctrl+C exits observer only)`,
    `  /codex:result ${payload.jobId}     — full final output (once status is completed/failed)`,
    `  /codex:cancel ${payload.jobId}     — abort the run`
  ];
  if (payload.worktreePath) {
    lines.push("", "Worktree:", `  Path:   ${payload.worktreePath}`);
    if (payload.worktreeBranch) {
      lines.push(`  Branch: ${payload.worktreeBranch}`);
    }
  }
  if (payload.signalFile) {
    lines.push("", `Signal file: ${payload.signalFile}`);
  }
  lines.push("", "A PushNotification will fire automatically when the job finishes.");
  return `${lines.join("\n")}\n`;
}

const JOB_KIND_LABELS = {
  review: "review",
  "adversarial-review": "adversarial-review",
  task: "rescue"
};

function getJobKindLabel(kind) {
  return JOB_KIND_LABELS[kind] ?? "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false, id }) {
  return createJobRecord({
    id: id ?? generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  const jobsDir = resolveJobsDir(job.workspaceRoot);
  const eventStream = createEventStream(job.id, jobsDir);
  return {
    logFile,
    eventFile: eventStream.eventFile,
    eventStream,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      eventStream,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write, worktreeInfo = null, id = null) {
  const base = createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write,
    id
  });

  if (!worktreeInfo) {
    return base;
  }

  return {
    ...base,
    worktreePath: worktreeInfo.worktreePath,
    worktreeBranch: worktreeInfo.worktreeBranch,
    worktreeBaseBranch: worktreeInfo.worktreeBaseBranch
  };
}

function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId, worktreePath = null, worktreeBranch = null, worktreeBaseBranch = null }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId,
    worktreePath,
    worktreeBranch,
    worktreeBaseBranch
  };
}

function renderTransferResult(payload) {
  const lines = [
    "Transferred the Claude session into a Codex thread with visible turn history.",
    `Codex session ID: ${payload.threadId}`,
    `Resume in Codex: ${payload.resumeCommand}`
  ];
  return `${lines.join("\n")}\n`;
}

async function executeTransfer(cwd, options = {}) {
  const sourcePath = resolveClaudeSessionPath(cwd, {
    source: options.source
  });
  const result = await importExternalAgentSession(cwd, { sourcePath });
  const payload = {
    threadId: result.threadId,
    resumeCommand: `codex resume ${result.threadId}`,
    sourcePath,
    sessionId: path.basename(sourcePath, ".jsonl")
  };

  return {
    payload,
    rendered: renderTransferResult(payload)
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, eventFile, eventStream, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile, eventFile });
  if (eventStream) {
    emitEvent(eventStream, EVENT_TYPES.COMPLETED, {
      status: execution.exitStatus === 0 ? "success" : "failure",
      phase: execution.exitStatus === 0 ? "done" : "failed",
      summary: execution.summary ?? null
    });
  }
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId, logFile = null) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  // Route the worker's stdout/stderr into the job log so a crash before the
  // worker takes over the job record is never silent.
  const logFd = logFile ? fs.openSync(logFile, "a") : null;
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: logFd === null ? "ignore" : ["ignore", logFd, logFd],
    windowsHide: true
  });
  child.unref();
  if (logFd !== null) {
    fs.closeSync(logFd);
  }
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile, eventFile } = createTrackedProgress(job);
  const jobsDir = resolveJobsDir(job.workspaceRoot);
  const signalFile = resolveSignalFile(jobsDir, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    logFile,
    eventFile,
    signalFile,
    request
  };

  // Persist the full job record (including the request payload) BEFORE the
  // worker exists. The worker's first action is to read this file; spawning
  // first used to lose the race whenever `git rev-parse` in this workspace was
  // slow, leaving the job stuck in `queued` forever.
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id, logFile);
  const pid = child.pid ?? null;
  if (pid === null) {
    const errorMessage = "Failed to spawn the background task worker.";
    markJobFailedBeforeRun(job.workspaceRoot, job.id, errorMessage, { logFile });
    throw new Error(errorMessage);
  }
  // Only the index learns the pid here. Rewriting the job file could race
  // with the worker's own `running` record; the worker stores its pid itself.
  upsertJob(job.workspaceRoot, { id: job.id, pid });

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile,
      eventFile,
      jobsDir,
      signalFile,
      worktreePath: job.worktreePath ?? null,
      worktreeBranch: job.worktreeBranch ?? null
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  const metadata = buildReviewJobMetadata(config.reviewKind, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });

  if (options.background) {
    ensureCodexAvailable(cwd);
    const request = {
      cwd,
      base: options.base,
      scope: options.scope,
      model: options.model,
      focusText,
      reviewKind: config.reviewKind
    };
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: options.model,
        focusText,
        reviewKind: config.reviewKind,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewKind: REVIEW_KINDS.REVIEW
  });
}

function resolveDiffSpec(options) {
  const provided = ["file", "commit", "range"].filter((key) => options[key] != null && String(options[key]).trim() !== "");
  if (provided.length === 0) {
    throw new Error("/codex:diff requires exactly one of --file <path>, --commit <sha>, or --range <a>..<b>.");
  }
  if (provided.length > 1) {
    throw new Error(`/codex:diff accepts only one selector at a time; got: ${provided.map((k) => `--${k}`).join(", ")}.`);
  }
  const mode = provided[0];
  return { mode, value: String(options[mode]).trim() };
}

async function handleDiff(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["file", "commit", "range", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const diffSpec = resolveDiffSpec(options);
  const reviewKind = REVIEW_KINDS.REVIEW;

  const metadata = {
    kind: reviewKind.jobKind,
    title: `Codex Diff Review (${diffSpec.mode})`,
    summary: `${reviewKind.name} ${diffSpec.mode} ${diffSpec.value}`
  };
  const job = createCompanionJob({
    prefix: "diff",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });

  if (options.background) {
    ensureCodexAvailable(cwd);
    const request = {
      cwd,
      model: options.model,
      focusText,
      reviewKind,
      diffSpec
    };
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        model: options.model,
        focusText,
        reviewKind,
        diffSpec,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "timeout-ms"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "worktree"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const { model, ignoredModel } = resolveTaskModel(options.model);
  if (ignoredModel) {
    process.stderr.write(
      `[codex] Ignoring --model ${ignoredModel}; using the model configured in Codex (~/.codex/config.toml). ` +
        `Set ${MODEL_OVERRIDE_ENV}=1 to allow per-run model overrides.\n`
    );
  }
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);
  if (!argv.includes("--") && promptLooksLikeFlagsOnly(prompt)) {
    throw new Error(
      `The task prompt "${shorten(prompt, 60)}" only contains unrecognized flags. ` +
        "Pass the natural-language task text, or run `codex-companion.mjs --help` for usage."
    );
  }

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  const worktree = Boolean(options.worktree);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  if (worktree && resumeLast) {
    throw new Error("Choose either --worktree or --resume/--resume-last.");
  }
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });

  // Create worktree if requested (before job creation so we have the path)
  let worktreeInfo = null;
  let preassignedJobId = null;
  if (worktree) {
    preassignedJobId = generateJobId("task");
    worktreeInfo = createWorktree(workspaceRoot, preassignedJobId, prompt);
  }

  if (options.background) {
    ensureCodexAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write, worktreeInfo, preassignedJobId);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      resumeLast,
      jobId: job.id,
      worktreePath: worktreeInfo?.worktreePath ?? null,
      worktreeBranch: worktreeInfo?.worktreeBranch ?? null,
      worktreeBaseBranch: worktreeInfo?.worktreeBaseBranch ?? null
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write, worktreeInfo, preassignedJobId);
  const request = buildTaskRequest({
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId: job.id,
    worktreePath: worktreeInfo?.worktreePath ?? null,
    worktreeBranch: worktreeInfo?.worktreeBranch ?? null,
    worktreeBaseBranch: worktreeInfo?.worktreeBaseBranch ?? null
  });

  if (isInlineForegroundEnabled()) {
    await runForegroundCommand(
      job,
      (progress) => executeTaskRun({ ...request, onProgress: progress }),
      { json: options.json }
    );
    return;
  }

  // Default foreground mode: the Codex turn runs in a detached worker exactly
  // like `--background`, and this process only waits, streams progress and
  // prints the stored result. If the caller (typically a tool harness with a
  // hard command timeout) kills this process, the job keeps running and the
  // result stays retrievable through `status`/`result`.
  ensureCodexAvailable(cwd);
  requireTaskRequest(prompt, resumeLast);
  await runTaskViaWorker(cwd, job, request, {
    json: options.json,
    timeoutMs: options["timeout-ms"]
  });
}

export const FOREGROUND_INLINE_ENV = "CODEX_COMPANION_FOREGROUND_INLINE";
export const FOREGROUND_TIMEOUT_ENV = "CODEX_COMPANION_FOREGROUND_TIMEOUT_MS";
// Slightly below Claude Code's 10-minute Bash ceiling so the "still running"
// hint is printed before the harness can kill us.
const DEFAULT_FOREGROUND_TIMEOUT_MS = 570_000;
const FOREGROUND_POLL_INTERVAL_MS = 250;
const LOG_LINE_PATTERN = /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] (.*)$/;
// Multi-line log blocks start with one of these titles; their bodies are not
// progress and the inline reporter never echoed them either.
const LOG_BLOCK_TITLES = new Set(["Assistant message", "Reasoning summary", "Final output", "Review output"]);

function isInlineForegroundEnabled(env = process.env) {
  const raw = env[FOREGROUND_INLINE_ENV];
  return raw === "1" || raw === "true";
}

function resolveForegroundTimeoutMs(explicit, env = process.env) {
  const candidates = [explicit, env[FOREGROUND_TIMEOUT_ENV]];
  for (const candidate of candidates) {
    if (candidate == null || candidate === "") {
      continue;
    }
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return DEFAULT_FOREGROUND_TIMEOUT_MS;
}

function renderStillRunningHint(jobId) {
  return [
    `Codex task ${jobId} is still running; this command stopped waiting but the job continues in the background.`,
    "",
    `  /codex:status ${jobId} --wait   — keep waiting for completion`,
    `  /codex:result ${jobId}          — final output once it finishes`,
    `  /codex:cancel ${jobId}          — abort the run`
  ].join("\n");
}

function createLogTailer(logFile, onLine) {
  let offset = 0;
  let carry = "";
  return () => {
    if (!logFile || !fs.existsSync(logFile)) {
      return;
    }
    let content;
    try {
      const stat = fs.statSync(logFile);
      if (stat.size <= offset) {
        return;
      }
      const fd = fs.openSync(logFile, "r");
      try {
        const buffer = Buffer.alloc(stat.size - offset);
        fs.readSync(fd, buffer, 0, buffer.length, offset);
        content = buffer.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
      offset = stat.size;
    } catch {
      return;
    }
    const chunks = (carry + content).split("\n");
    carry = chunks.pop() ?? "";
    for (const line of chunks) {
      const match = LOG_LINE_PATTERN.exec(line);
      if (match && !LOG_BLOCK_TITLES.has(match[1])) {
        onLine(match[1]);
      }
    }
  };
}

async function runTaskViaWorker(cwd, job, request, options = {}) {
  const { payload: launch } = enqueueBackgroundTask(cwd, job, request);
  const timeoutMs = resolveForegroundTimeoutMs(options.timeoutMs);
  const deadline = Date.now() + timeoutMs;
  const streamProgress = !options.json;
  const tail = createLogTailer(launch.logFile, (line) => {
    if (streamProgress) {
      process.stderr.write(`[codex] ${line}\n`);
    }
  });

  let interrupted = null;
  const onSignal = (signal) => {
    interrupted = signal;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);

  let stored = null;
  try {
    for (;;) {
      tail();
      try {
        stored = readStoredJob(job.workspaceRoot, job.id);
      } catch {
        stored = null; // transiently unreadable: keep waiting
      }
      if (stored && ["completed", "failed", "cancelled"].includes(stored.status)) {
        break;
      }
      if (interrupted) {
        process.stderr.write(`${renderStillRunningHint(job.id)}\n`);
        process.exitCode = interrupted === "SIGINT" ? 130 : 143;
        return;
      }
      if (Date.now() >= deadline) {
        // Not a failure: the job is alive. Print the hint on both streams so
        // a forwarder that only relays stdout still shows the user what to do.
        process.stderr.write(`${renderStillRunningHint(job.id)}\n`);
        if (options.json) {
          outputResult({ ...launch, status: "running", waitTimedOut: true, timeoutMs }, true);
        } else {
          process.stdout.write(`${renderStillRunningHint(job.id)}\n`);
        }
        return;
      }
      // Give up early if the worker vanished; reconciliation converts it to failed.
      const [reconciled] = reconcileStaleJobs(job.workspaceRoot, [{ ...(stored ?? job), id: job.id }]);
      if (reconciled && reconciled.status === "failed") {
        stored = readStoredJob(job.workspaceRoot, job.id) ?? { ...reconciled };
        break;
      }
      await sleep(FOREGROUND_POLL_INTERVAL_MS);
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
  }
  tail();

  if (stored.status === "completed") {
    outputResult(options.json ? stored.result ?? {} : stored.rendered ?? "", options.json);
    return;
  }

  const errorMessage = stored.errorMessage ?? (stored.status === "cancelled" ? "Cancelled by user." : null);
  if (stored.rendered) {
    outputResult(options.json ? stored.result ?? { errorMessage } : stored.rendered, options.json);
  } else if (options.json) {
    outputResult({ jobId: job.id, status: stored.status, errorMessage: errorMessage ?? "Codex task failed." }, true);
  }
  if (errorMessage) {
    process.stderr.write(`${errorMessage}\n`);
  } else if (!stored.rendered) {
    process.stderr.write("Codex task failed.\n");
  }
  // Preserve the executor's exit status (the inline path used it directly).
  const storedStatus = stored.result?.status;
  process.exitCode = Number.isInteger(storedStatus) && storedStatus !== 0 ? storedStatus : 1;
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const { payload, rendered } = await executeTransfer(cwd, {
    source: options.source
  });
  outputCommandResult(payload, rendered, options.json);
}

const WORKER_JOB_LOOKUP_TIMEOUT_MS = 10_000;
const WORKER_JOB_LOOKUP_INTERVAL_MS = 100;

async function readStoredJobWithRetry(workspaceRoot, jobId, timeoutMs = WORKER_JOB_LOOKUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const storedJob = readStoredJob(workspaceRoot, jobId);
      if (storedJob && storedJob.request && typeof storedJob.request === "object") {
        return storedJob;
      }
      if (storedJob) {
        // Records are written atomically: present means complete, so this is final.
        throw new Error(`Stored job ${jobId} is missing its task request payload.`);
      }
      lastError = new Error(`No stored job found for ${jobId}.`);
    } catch (error) {
      // A partially written or transiently unreadable record: keep waiting.
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (Date.now() >= deadline) {
      throw lastError;
    }
    await sleep(WORKER_JOB_LOOKUP_INTERVAL_MS);
  }
}

/**
 * Mark a job as failed when the worker dies before `runTrackedJob` took
 * ownership of the record. Without this, a crash during worker start-up
 * leaves the job in `queued` with no signal file, so Monitor-based waiters
 * never wake up.
 */
function markJobFailedBeforeRun(workspaceRoot, jobId, errorMessage, options = {}) {
  const completedAt = nowIso();
  let existing = null;
  try {
    existing = readStoredJob(workspaceRoot, jobId);
  } catch {
    existing = null;
  }
  if (existing && ["completed", "failed", "cancelled"].includes(existing.status)) {
    return;
  }
  const logFile = options.logFile ?? existing?.logFile ?? null;
  try {
    appendLogLine(logFile, `Failed before start: ${errorMessage}`);
  } catch {
    // best-effort
  }
  const failedRecord = {
    ...(existing ?? { id: jobId, workspaceRoot }),
    status: "failed",
    phase: "failed",
    pid: null,
    errorMessage,
    completedAt
  };
  try {
    writeJobFile(workspaceRoot, jobId, failedRecord);
  } catch {
    // best-effort
  }
  try {
    upsertJob(workspaceRoot, {
      id: jobId,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage,
      completedAt
    });
  } catch {
    // best-effort
  }
  writeCompletionSignalFile(resolveJobsDir(workspaceRoot), jobId, "failed", errorMessage);
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const jobId = options["job-id"];

  // Anything that escapes before runTrackedJob owns the record must still
  // leave a terminal state behind: the worker is detached and its stderr
  // only reaches the job log, so a silent exit would strand the job.
  const failFast = (error) => {
    const message = error instanceof Error ? error.message : String(error);
    markJobFailedBeforeRun(workspaceRoot, jobId, message);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  };
  process.on("uncaughtException", failFast);
  process.on("unhandledRejection", failFast);

  let storedJob;
  try {
    storedJob = await readStoredJobWithRetry(workspaceRoot, jobId);
  } catch (error) {
    failFast(error);
    return;
  }
  const request = storedJob.request;
  if (storedJob.status !== "queued") {
    // Already claimed (or finished/cancelled) by someone else — do not rerun.
    process.stderr.write(`Job ${jobId} is ${storedJob.status}; worker exiting without rerun.\n`);
    return;
  }

  const { logFile, eventFile, eventStream, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  const executor = storedJob.jobClass === "review" ? executeReviewRun : executeTaskRun;
  const execution = await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile,
      eventFile
    },
    () =>
      executor({
        ...request,
        onProgress: progress
      }),
    { logFile, eventFile }
  );
  if (eventStream) {
    emitEvent(eventStream, EVENT_TYPES.COMPLETED, {
      status: execution.exitStatus === 0 ? "success" : "failure",
      phase: execution.exitStatus === 0 ? "done" : "failed",
      summary: execution.summary ?? null
    });
  }
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;

  const interrupt = await interruptAppServerTurn(workspaceRoot, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

const DEFAULT_HISTORY_LIMIT = 20;
const REVIEW_KIND_FILTER = new Set(["review", "adversarial-review"]);

function enrichHistoryJob(workspaceRoot, job) {
  const enriched = {
    id: job.id,
    kind: job.kind,
    kindLabel: job.kindLabel ?? job.kind,
    title: job.title ?? null,
    summary: job.summary ?? null,
    status: job.status,
    createdAt: job.createdAt ?? null,
    completedAt: job.completedAt ?? null,
    verdict: null,
    findingsCount: 0,
    workspaceRoot: job.workspaceRoot ?? workspaceRoot
  };

  const stored = readStoredJob(enriched.workspaceRoot, job.id);
  const review = stored?.result?.result;
  if (review && typeof review === "object") {
    if (typeof review.verdict === "string") {
      enriched.verdict = review.verdict;
    }
    if (Array.isArray(review.findings)) {
      enriched.findingsCount = review.findings.length;
    }
  }
  return enriched;
}

function handleHistory(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "limit"],
    booleanOptions: ["json", "all"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const limit = Math.max(1, Number(options.limit) || DEFAULT_HISTORY_LIMIT);

  const rawJobs = options.all
    ? collectWorkspaceJobsAcrossRoots(workspaceRoot)
    : listJobs(workspaceRoot);

  const reviewJobs = sortJobsNewestFirst(rawJobs).filter((job) => REVIEW_KIND_FILTER.has(job.kind));
  const sliced = reviewJobs.slice(0, limit);
  const enriched = sliced.map((job) => enrichHistoryJob(workspaceRoot, job));

  const payload = {
    workspaceRoot,
    total: reviewJobs.length,
    returned: enriched.length,
    limit,
    all: Boolean(options.all),
    jobs: enriched
  };

  outputCommandResult(payload, renderHistoryReport(payload), options.json);
}

function wantsHelp(argv) {
  for (const token of argv) {
    if (token === "--") {
      return false;
    }
    if (token === "--help" || token === "-h") {
      return true;
    }
  }
  return false;
}

export function promptLooksLikeFlagsOnly(prompt) {
  const tokens = String(prompt ?? "").trim().split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => /^--?[a-z][\w-]*(=.*)?$/i.test(token));
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    return;
  }
  if (wantsHelp(argv)) {
    // `task --help` must never be forwarded to Codex as a prompt.
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewKind: REVIEW_KINDS.ADVERSARIAL
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    case "observe":
      await handleObserveCommand(argv);
      break;
    case "history":
      handleHistory(argv);
      break;
    case "diff":
      await handleDiff(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

// Only run the CLI when executed directly (`node codex-companion.mjs …`), so the
// module's exported helpers can be imported by unit tests without triggering main().
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
