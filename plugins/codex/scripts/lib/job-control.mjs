import fs from "node:fs";
import os from "node:os";

import { getSessionRuntimeStatus } from "./codex.mjs";
import { isProcessAlive } from "./process.mjs";
import {
  collectWorkspaceJobsAcrossRoots,
  findJobByIdAcrossWorkspaces,
  getConfig,
  listJobs,
  readJobFile,
  resolveJobFile,
  resolveJobsDir,
  upsertJob,
  writeJobFile
} from "./state.mjs";
import { appendLogLine, SESSION_ID_ENV, writeCompletionSignalFile } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
// A freshly enqueued job may briefly have no pid while the parent is still
// spawning the worker; do not declare it dead inside this window.
const STALE_JOB_GRACE_MS = 5000;

function readStoredJobOrNull(workspaceRoot, jobId) {
  try {
    const jobFile = resolveJobFile(workspaceRoot, jobId);
    return fs.existsSync(jobFile) ? readJobFile(jobFile) : null;
  } catch {
    return null;
  }
}

/**
 * Detect jobs whose worker process is gone without leaving a terminal state
 * (crashed, killed, machine rebooted) and convert them to `failed` so status,
 * result, cancel and Monitor-based waiters stop treating them as active.
 * Returns the reconciled list; callers keep using it like the input.
 */
export function reconcileStaleJobs(workspaceRoot, jobs, options = {}) {
  const alive = options.isProcessAlive ?? isProcessAlive;
  const now = options.now ?? Date.now();
  const jobsDir = resolveJobsDir(workspaceRoot);

  return jobs.map((job) => {
    if (!job || (job.status !== "queued" && job.status !== "running")) {
      return job;
    }

    const stored = readStoredJobOrNull(workspaceRoot, job.id);
    if (stored && TERMINAL_STATUSES.has(stored.status)) {
      // The worker finished but the state index missed the update.
      const patch = {
        id: job.id,
        status: stored.status,
        phase: stored.phase ?? stored.status,
        pid: null,
        errorMessage: stored.errorMessage ?? job.errorMessage ?? null,
        completedAt: stored.completedAt ?? new Date(now).toISOString()
      };
      upsertJob(workspaceRoot, patch);
      return { ...job, ...patch };
    }

    const pid = Number.isFinite(job.pid) ? job.pid : Number.isFinite(stored?.pid) ? stored.pid : null;
    // A job started before the last boot cannot have a live worker even if the
    // pid number has since been reused by an unrelated process.
    const bootTime = now - (options.uptimeSeconds ?? os.uptime()) * 1000;
    const startedAt = Date.parse(job.startedAt ?? job.createdAt ?? "") || 0;
    const startedBeforeBoot = startedAt > 0 && startedAt < bootTime;
    if (pid !== null && !startedBeforeBoot && alive(pid)) {
      return job;
    }

    const lastTouch = Date.parse(job.updatedAt ?? job.createdAt ?? "") || 0;
    if (pid === null && now - lastTouch < STALE_JOB_GRACE_MS) {
      return job;
    }

    const errorMessage =
      pid === null
        ? "No worker process was recorded for this job; it never started."
        : startedBeforeBoot
          ? `Worker process ${pid} predates the last system boot and cannot be running.`
          : `Worker process ${pid} exited before the job finished.`;
    const completedAt = new Date(now).toISOString();
    const patch = {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage,
      completedAt
    };
    try {
      appendLogLine(stored?.logFile ?? job.logFile ?? null, `Marked failed by reconciliation: ${errorMessage}`);
    } catch {
      // best-effort
    }
    try {
      writeJobFile(workspaceRoot, job.id, { ...(stored ?? job), ...patch });
    } catch {
      // best-effort
    }
    upsertJob(workspaceRoot, patch);
    writeCompletionSignalFile(jobsDir, job.id, "failed", errorMessage);
    return { ...job, ...patch };
  });
}

function listReconciledJobs(workspaceRoot) {
  return reconcileStaleJobs(workspaceRoot, listJobs(workspaceRoot));
}

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function getCurrentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    return "rescue";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "rescue";
  }
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function looksLikeVerificationCommand(line) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line
  );
}

function inferLegacyJobPhase(job, progressPreview = []) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "done";
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index].toLowerCase();
    if (line.startsWith("starting codex") || line.startsWith("thread ready") || line.startsWith("turn started")) {
      return "starting";
    }
    if (line.startsWith("reviewer started") || line.includes("review mode")) {
      return "reviewing";
    }
    if (line.startsWith("searching:") || line.startsWith("calling ") || line.startsWith("running tool:")) {
      return "investigating";
    }
    if (line.startsWith("starting collaboration tool:")) {
      return "investigating";
    }
    if (line.startsWith("running command:")) {
      return looksLikeVerificationCommand(line)
        ? "verifying"
        : job.jobClass === "review"
          ? "reviewing"
          : "investigating";
    }
    if (line.startsWith("command completed:")) {
      return looksLikeVerificationCommand(line) ? "verifying" : "running";
    }
    if (line.startsWith("applying ") || line.startsWith("file changes ")) {
      return "editing";
    }
    if (line.startsWith("turn completed")) {
      return "finalizing";
    }
    if (line.startsWith("codex error:") || line.startsWith("failed:")) {
      return "failed";
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running";
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      job.status === "queued" || job.status === "running" || job.status === "failed"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      job.status === "completed" || job.status === "failed" || job.status === "cancelled"
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null
  };

  return {
    ...enriched,
    phase: enriched.phase ?? inferLegacyJobPhase(enriched, enriched.progressPreview)
  };
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  return null;
}

function findCrossWorkspaceMatch(reference, predicate) {
  if (!reference) {
    return null;
  }
  const cross = findJobByIdAcrossWorkspaces(reference);
  if (!cross) {
    return null;
  }
  if (predicate && !predicate(cross.job)) {
    return { ...cross, predicateRejected: true };
  }
  return cross;
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  // Reconcile the current root first so `--all` (which merges legacy roots)
  // also reflects dead workers without writing into foreign state roots.
  const currentJobs = listReconciledJobs(workspaceRoot);
  const rawJobs = options.all
    ? collectWorkspaceJobsAcrossRoots(workspaceRoot)
    : filterJobsForCurrentSession(currentJobs, options);
  const jobs = sortJobsNewestFirst(rawJobs);
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw = jobs.find((job) => job.status !== "queued" && job.status !== "running") ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => job.status !== "queued" && job.status !== "running" && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(options.env, workspaceRoot),
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate)
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listReconciledJobs(workspaceRoot));
  const selected = matchJobReference(jobs, reference);

  if (selected) {
    return {
      workspaceRoot,
      job: enrichJob(selected, { maxProgressLines: options.maxProgressLines })
    };
  }

  const cross = findCrossWorkspaceMatch(reference);
  if (cross) {
    return {
      workspaceRoot: cross.job.workspaceRoot ?? workspaceRoot,
      job: enrichJob(cross.job, { maxProgressLines: options.maxProgressLines }),
      crossWorkspace: true,
      crossWorkspaceStateDir: cross.stateDir
    };
  }

  throw new Error(`No job found for "${reference}". Run /codex:status to inspect known jobs.`);
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const allJobs = listReconciledJobs(workspaceRoot);
  const jobs = sortJobsNewestFirst(reference ? allJobs : filterJobsForCurrentSession(allJobs));
  const isFinished = (job) =>
    job.status === "completed" || job.status === "failed" || job.status === "cancelled";
  const isActive = (job) => job.status === "queued" || job.status === "running";

  const selected = matchJobReference(jobs, reference, isFinished);
  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const active = matchJobReference(jobs, reference, isActive);
  if (active) {
    throw new Error(`Job ${active.id} is still ${active.status}. Check /codex:status and try again once it finishes.`);
  }

  const cross = findCrossWorkspaceMatch(reference, isFinished);
  if (cross && !cross.predicateRejected) {
    return {
      workspaceRoot: cross.job.workspaceRoot ?? workspaceRoot,
      job: cross.job,
      crossWorkspace: true,
      crossWorkspaceStateDir: cross.stateDir
    };
  }
  if (cross && cross.predicateRejected) {
    throw new Error(
      `Job ${cross.job.id} is still ${cross.job.status} in another workspace. Check /codex:status and try again once it finishes.`
    );
  }

  if (reference) {
    throw new Error(`No finished job found for "${reference}". Run /codex:status to inspect active jobs.`);
  }

  throw new Error("No finished Codex jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listReconciledJobs(workspaceRoot));
  const isActive = (job) => job.status === "queued" || job.status === "running";
  const activeJobs = jobs.filter(isActive);

  if (reference) {
    const selected = matchJobReference(activeJobs, reference);
    if (selected) {
      return { workspaceRoot, job: selected };
    }
    const cross = findCrossWorkspaceMatch(reference, isActive);
    if (cross && !cross.predicateRejected) {
      return {
        workspaceRoot: cross.job.workspaceRoot ?? workspaceRoot,
        job: cross.job,
        crossWorkspace: true,
        crossWorkspaceStateDir: cross.stateDir
      };
    }
    if (cross && cross.predicateRejected) {
      throw new Error(
        `Job ${cross.job.id} is not active (status: ${cross.job.status}). Nothing to cancel.`
      );
    }
    throw new Error(`No active job found for "${reference}".`);
  }

  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);

  if (sessionScopedActiveJobs.length === 1) {
    return { workspaceRoot, job: sessionScopedActiveJobs[0] };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new Error("Multiple Codex jobs are active. Pass a job id to /codex:cancel.");
  }

  if (getCurrentSessionId(options)) {
    throw new Error("No active Codex jobs to cancel for this session.");
  }

  throw new Error("No active Codex jobs to cancel.");
}
