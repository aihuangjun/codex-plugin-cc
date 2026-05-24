import { mkdtempSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createEventStream, emitEvent, closeEventStream, EVENT_TYPES } from "../plugins/codex/scripts/lib/event-stream.mjs";

describe("createEventStream", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "event-stream-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates an empty .events.jsonl file", () => {
    const stream = createEventStream("job-123", tempDir);
    assert.ok(stream.eventFile.endsWith("job-123.events.jsonl"));
    assert.ok(existsSync(stream.eventFile));
    assert.equal(readFileSync(stream.eventFile, "utf8"), "");
  });

  it("returns a stream object with eventFile and jobId", () => {
    const stream = createEventStream("job-abc", tempDir);
    assert.equal(stream.jobId, "job-abc");
    assert.ok(typeof stream.eventFile === "string");
  });
});

describe("emitEvent", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "event-stream-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("appends a JSON line to the event file", () => {
    const stream = createEventStream("job-1", tempDir);
    emitEvent(stream, EVENT_TYPES.PHASE, { phase: "starting", message: "Thread ready" });

    const content = readFileSync(stream.eventFile, "utf8").trim();
    const parsed = JSON.parse(content);
    assert.equal(parsed.type, "phase");
    assert.equal(parsed.phase, "starting");
    assert.equal(parsed.message, "Thread ready");
    assert.ok(parsed.t); // ISO timestamp
  });

  it("appends multiple events in order", () => {
    const stream = createEventStream("job-2", tempDir);
    emitEvent(stream, EVENT_TYPES.PHASE, { phase: "starting" });
    emitEvent(stream, EVENT_TYPES.TOOL_CALL, { tool: "Read", path: "src/foo.ts" });
    emitEvent(stream, EVENT_TYPES.TOOL_DONE, { tool: "Read" });

    const lines = readFileSync(stream.eventFile, "utf8").trim().split("\n");
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[0]).type, "phase");
    assert.equal(JSON.parse(lines[1]).type, "tool_call");
    assert.equal(JSON.parse(lines[2]).type, "tool_done");
  });

  it("silently ignores write failures when stream has no eventFile", () => {
    emitEvent({ eventFile: null }, EVENT_TYPES.PHASE, { phase: "test" });
    // No error thrown
  });

  it("silently ignores write failures on read-only directory", () => {
    const stream = createEventStream("job-3", tempDir);
    // Remove write permission on the file
    chmodSync(stream.eventFile, 0o444);
    // Should not throw
    emitEvent(stream, EVENT_TYPES.PHASE, { phase: "test" });
    // Restore permissions for cleanup
    chmodSync(stream.eventFile, 0o644);
  });
});

describe("closeEventStream", () => {
  it("is a no-op that does not throw", () => {
    assert.doesNotThrow(() => closeEventStream(null));
    assert.doesNotThrow(() => closeEventStream({ eventFile: "/tmp/fake" }));
  });
});

describe("EVENT_TYPES", () => {
  it("has all expected event type constants", () => {
    assert.equal(EVENT_TYPES.PHASE, "phase");
    assert.equal(EVENT_TYPES.TOOL_CALL, "tool_call");
    assert.equal(EVENT_TYPES.TOOL_DONE, "tool_done");
    assert.equal(EVENT_TYPES.COMMAND, "command");
    assert.equal(EVENT_TYPES.COMMAND_DONE, "command_done");
    assert.equal(EVENT_TYPES.FILE_CHANGE, "file_change");
    assert.equal(EVENT_TYPES.MESSAGE, "message");
    assert.equal(EVENT_TYPES.REASONING, "reasoning");
    assert.equal(EVENT_TYPES.COMPLETED, "completed");
  });

  it("is frozen (immutable)", () => {
    assert.ok(Object.isFrozen(EVENT_TYPES));
  });
});
