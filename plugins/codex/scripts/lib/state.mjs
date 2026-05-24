import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const DEFAULT_STATE_ROOT_DIR = path.join(os.homedir(), ".codex-companion", "state");
const LEGACY_TMPDIR_ROOT = path.join(os.tmpdir(), "codex-companion");
const CLAUDE_PLUGINS_DATA_DIR = path.join(os.homedir(), ".claude", "plugins", "data");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

const LEGACY_ROOTS_ENV = "CODEX_COMPANION_LEGACY_ROOTS";

function resolveStateRoot() {
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  return pluginDataDir ? path.join(pluginDataDir, "state") : DEFAULT_STATE_ROOT_DIR;
}

function discoverPluginDataCodexRoots() {
  const out = [];
  try {
    if (!fs.existsSync(CLAUDE_PLUGINS_DATA_DIR)) {
      return out;
    }
    for (const entry of fs.readdirSync(CLAUDE_PLUGINS_DATA_DIR, { withFileTypes: true })) {
      if (entry.isDirectory() && /codex/i.test(entry.name)) {
        out.push(path.join(CLAUDE_PLUGINS_DATA_DIR, entry.name, "state"));
      }
    }
  } catch {
    // Best-effort; ignore unreadable plugin data dir.
  }
  return out;
}

function resolveLegacyRoots() {
  const override = process.env[LEGACY_ROOTS_ENV];
  if (override === "") {
    return [];
  }
  if (override) {
    return override.split(path.delimiter).filter(Boolean);
  }
  return [DEFAULT_STATE_ROOT_DIR, LEGACY_TMPDIR_ROOT, ...discoverPluginDataCodexRoots()];
}

function collectCandidateStateRoots() {
  const seen = new Set();
  const roots = [];

  const push = (root) => {
    if (root && !seen.has(root)) {
      seen.add(root);
      roots.push(root);
    }
  };

  push(resolveStateRoot());
  for (const root of resolveLegacyRoots()) {
    push(root);
  }

  return roots;
}

function computeStateSlugHash(workspaceRoot) {
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  return `${slug}-${hash}`;
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  return path.join(resolveStateRoot(), computeStateSlugHash(workspaceRoot));
}

export function collectWorkspaceJobsAcrossRoots(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const slugHash = computeStateSlugHash(workspaceRoot);
  const merged = new Map();

  for (const stateRoot of collectCandidateStateRoots()) {
    const stateFile = path.join(stateRoot, slugHash, STATE_FILE_NAME);
    if (!fs.existsSync(stateFile)) {
      continue;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
      for (const job of jobs) {
        if (!job?.id) {
          continue;
        }
        const existing = merged.get(job.id);
        if (!existing) {
          merged.set(job.id, job);
          continue;
        }
        const existingUpdated = String(existing.updatedAt ?? "");
        const candidateUpdated = String(job.updatedAt ?? "");
        if (candidateUpdated.localeCompare(existingUpdated) > 0) {
          merged.set(job.id, job);
        }
      }
    } catch {
      // Skip corrupted state files.
    }
  }

  return [...merged.values()];
}

export function findJobByIdAcrossWorkspaces(jobId) {
  if (!jobId) {
    return null;
  }

  for (const stateRoot of collectCandidateStateRoots()) {
    if (!fs.existsSync(stateRoot)) {
      continue;
    }

    let entries;
    try {
      entries = fs.readdirSync(stateRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const stateDir = path.join(stateRoot, entry.name);
      const stateFile = path.join(stateDir, STATE_FILE_NAME);
      if (!fs.existsSync(stateFile)) {
        continue;
      }
      try {
        const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
        const job = jobs.find((entry) => entry.id === jobId);
        if (job) {
          return { stateDir, job };
        }
      } catch {
        // Skip corrupted state files
      }
    }
  }

  return null;
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function saveState(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
    removeFileIfExists(job.eventFile);
  }

  fs.writeFileSync(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  return nextState;
}

export function updateState(cwd, mutate) {
  const state = loadState(cwd);
  mutate(state);
  return saveState(cwd, state);
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  fs.writeFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobEventFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.events.jsonl`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
