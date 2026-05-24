import fs from "node:fs";
import path from "node:path";

const EVENT_TYPES = Object.freeze({
  PHASE: "phase",
  TOOL_CALL: "tool_call",
  TOOL_DONE: "tool_done",
  COMMAND: "command",
  COMMAND_DONE: "command_done",
  FILE_CHANGE: "file_change",
  MESSAGE: "message",
  REASONING: "reasoning",
  COMPLETED: "completed"
});

const EVENT_FILE_EXTENSION = ".events.jsonl";

function nowIso() {
  return new Date().toISOString();
}

function resolveEventFilePath(jobsDir, jobId) {
  return path.join(jobsDir, `${jobId}${EVENT_FILE_EXTENSION}`);
}

export function createEventStream(jobId, jobsDir) {
  const eventFile = resolveEventFilePath(jobsDir, jobId);
  try {
    fs.writeFileSync(eventFile, "", "utf8");
  } catch {
    // Best-effort; do not fail if the file cannot be created.
  }
  return { eventFile, jobId };
}

export function emitEvent(stream, type, data = {}) {
  if (!stream || !stream.eventFile) {
    return;
  }
  try {
    const line = JSON.stringify({ t: nowIso(), type, ...data });
    fs.appendFileSync(stream.eventFile, `${line}\n`, "utf8");
  } catch {
    // Write failures are silently ignored; event stream is best-effort.
  }
}

export function closeEventStream(_stream) {
  // No-op placeholder for future cleanup.
}

export function resolveJobEventFile(jobsDir, jobId) {
  return resolveEventFilePath(jobsDir, jobId);
}

export { EVENT_TYPES, EVENT_FILE_EXTENSION };
