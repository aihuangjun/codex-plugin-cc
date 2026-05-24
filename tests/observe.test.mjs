import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { readEventsFromOffset, renderEvent } from "../plugins/codex/scripts/lib/observe.mjs";
import { EVENT_TYPES } from "../plugins/codex/scripts/lib/event-stream.mjs";
import { findJobByIdAcrossWorkspaces } from "../plugins/codex/scripts/lib/state.mjs";

describe("readEventsFromOffset", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "observe-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty events for missing file", () => {
    const result = readEventsFromOffset(join(tempDir, "missing.jsonl"), 0);
    assert.deepEqual(result.events, []);
    assert.equal(result.newOffset, 0);
  });

  it("returns empty events for empty file", () => {
    const file = join(tempDir, "empty.jsonl");
    writeFileSync(file, "");
    const result = readEventsFromOffset(file, 0);
    assert.deepEqual(result.events, []);
    assert.equal(result.newOffset, 0);
  });

  it("parses all lines from offset 0", () => {
    const file = join(tempDir, "events.jsonl");
    const line1 = JSON.stringify({ t: "2026-01-01", type: "phase", phase: "starting" });
    const line2 = JSON.stringify({ t: "2026-01-01", type: "message", text: "hello" });
    writeFileSync(file, `${line1}\n${line2}\n`);

    const result = readEventsFromOffset(file, 0);
    assert.equal(result.events.length, 2);
    assert.equal(result.events[0].type, "phase");
    assert.equal(result.events[1].type, "message");
    assert.ok(result.newOffset > 0);
  });

  it("reads only new content from given offset", () => {
    const file = join(tempDir, "events.jsonl");
    const line1 = JSON.stringify({ t: "2026-01-01", type: "phase", phase: "starting" });
    writeFileSync(file, `${line1}\n`);

    const first = readEventsFromOffset(file, 0);
    assert.equal(first.events.length, 1);

    const line2 = JSON.stringify({ t: "2026-01-01", type: "tool_call", tool: "Read" });
    writeFileSync(file, `${line1}\n${line2}\n`);

    const second = readEventsFromOffset(file, first.newOffset);
    assert.equal(second.events.length, 1);
    assert.equal(second.events[0].type, "tool_call");
  });

  it("skips malformed lines without throwing", () => {
    const file = join(tempDir, "events.jsonl");
    const valid = JSON.stringify({ t: "2026-01-01", type: "phase", phase: "done" });
    writeFileSync(file, `not-json\n${valid}\n{broken\n`);

    const result = readEventsFromOffset(file, 0);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].type, "phase");
  });
});

describe("renderEvent", () => {
  it("renders phase events with spinner and color", () => {
    const output = renderEvent({ type: EVENT_TYPES.PHASE, phase: "starting", message: "Thread ready" });
    assert.ok(output.includes("starting"));
    assert.ok(output.includes("Thread ready"));
  });

  it("renders tool_call events", () => {
    const output = renderEvent({ type: EVENT_TYPES.TOOL_CALL, tool: "Read", path: "src/foo.ts" });
    assert.ok(output.includes("→"));
    assert.ok(output.includes("Read"));
    assert.ok(output.includes("src/foo.ts"));
  });

  it("renders tool_done events", () => {
    const output = renderEvent({ type: EVENT_TYPES.TOOL_DONE, tool: "Read" });
    assert.ok(output.includes("✓"));
    assert.ok(output.includes("completed"));
  });

  it("renders command events", () => {
    const output = renderEvent({ type: EVENT_TYPES.COMMAND, cmd: "npm test" });
    assert.ok(output.includes("$"));
    assert.ok(output.includes("npm test"));
  });

  it("renders command_done with exit 0 in green", () => {
    const output = renderEvent({ type: EVENT_TYPES.COMMAND_DONE, cmd: "npm test", exit: 0 });
    assert.ok(output.includes("exit 0"));
    assert.ok(output.includes("\x1b[32m")); // green
  });

  it("renders command_done with non-zero exit in red", () => {
    const output = renderEvent({ type: EVENT_TYPES.COMMAND_DONE, cmd: "npm test", exit: 1 });
    assert.ok(output.includes("exit 1"));
    assert.ok(output.includes("\x1b[31m")); // red
  });

  it("renders file_change events", () => {
    const output = renderEvent({ type: EVENT_TYPES.FILE_CHANGE, path: "src/auth.ts", action: "modify" });
    assert.ok(output.includes("✎"));
    assert.ok(output.includes("src/auth.ts"));
    assert.ok(output.includes("modify"));
  });

  it("renders message events with border", () => {
    const output = renderEvent({ type: EVENT_TYPES.MESSAGE, text: "Fixed the bug" });
    assert.ok(output.includes("│"));
    assert.ok(output.includes("Fixed the bug"));
  });

  it("renders reasoning events with bullets", () => {
    const output = renderEvent({ type: EVENT_TYPES.REASONING, sections: ["Step 1", "Step 2"] });
    assert.ok(output.includes("•"));
    assert.ok(output.includes("Step 1"));
    assert.ok(output.includes("Step 2"));
  });

  it("renders completed events with timestamp", () => {
    const output = renderEvent({ type: EVENT_TYPES.COMPLETED, status: "success", t: "2026-05-20T15:42:33Z" });
    assert.ok(output.includes("●"));
    assert.ok(output.includes("completed at"));
    assert.ok(output.includes("2026-05-20T15:42:33Z"));
    assert.ok(output.includes("\x1b[32m")); // green for success
  });

  it("renders completed failure events in red", () => {
    const output = renderEvent({ type: EVENT_TYPES.COMPLETED, status: "failure", t: "2026-05-20T15:42:33Z" });
    assert.ok(output.includes("\x1b[31m")); // red for failure
  });

  it("returns empty string for empty message events", () => {
    const output = renderEvent({ type: EVENT_TYPES.MESSAGE, text: "" });
    assert.equal(output, "");
  });
});

describe("findJobByIdAcrossWorkspaces", () => {
  let pluginDataDir;
  let previousPluginData;

  beforeEach(() => {
    pluginDataDir = mkdtempSync(join(tmpdir(), "observe-cross-ws-"));
    previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  });

  afterEach(() => {
    if (previousPluginData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    }
    rmSync(pluginDataDir, { recursive: true, force: true });
  });

  function writeWorkspaceState(slug, state) {
    const dir = join(pluginDataDir, "state", slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
    return dir;
  }

  it("returns null when stateRoot does not exist", () => {
    assert.equal(findJobByIdAcrossWorkspaces("task-abc"), null);
  });

  it("returns null for missing jobId", () => {
    assert.equal(findJobByIdAcrossWorkspaces(""), null);
    assert.equal(findJobByIdAcrossWorkspaces(null), null);
  });

  it("finds a job stored in a different workspace state file", () => {
    const jobRecord = {
      id: "task-mpgzdj45-hcr1o6",
      status: "running",
      eventFile: "/abs/path/events.jsonl"
    };
    const expectedDir = writeWorkspaceState("security-planck-7a3129dd96b457cb", {
      version: 1,
      jobs: [jobRecord]
    });

    const result = findJobByIdAcrossWorkspaces("task-mpgzdj45-hcr1o6");
    assert.ok(result, "expected cross-workspace match");
    assert.equal(result.stateDir, expectedDir);
    assert.equal(result.job.id, "task-mpgzdj45-hcr1o6");
    assert.equal(result.job.eventFile, "/abs/path/events.jsonl");
  });

  it("returns null when no workspace contains the jobId", () => {
    writeWorkspaceState("other-1234567890abcdef", {
      version: 1,
      jobs: [{ id: "task-other", status: "completed" }]
    });
    assert.equal(findJobByIdAcrossWorkspaces("task-missing"), null);
  });

  it("skips corrupted state.json files instead of throwing", () => {
    const corruptedDir = join(pluginDataDir, "state", "corrupt-aaaaaaaaaaaaaaaa");
    mkdirSync(corruptedDir, { recursive: true });
    writeFileSync(join(corruptedDir, "state.json"), "{not valid json", "utf8");

    writeWorkspaceState("good-bbbbbbbbbbbbbbbb", {
      version: 1,
      jobs: [{ id: "task-good", status: "completed" }]
    });

    const result = findJobByIdAcrossWorkspaces("task-good");
    assert.ok(result);
    assert.equal(result.job.id, "task-good");
  });
});
