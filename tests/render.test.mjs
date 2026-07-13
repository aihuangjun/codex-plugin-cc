import test from "node:test";
import assert from "node:assert/strict";

import {
  renderReviewResult,
  renderStoredJobResult,
  renderTaskResult,
  describeModelRejection
} from "../plugins/codex/scripts/lib/render.mjs";

test("describeModelRejection returns an actionable hint for backend model rejections", () => {
  const hint = describeModelRejection(
    "The 'pytest' model is not supported when using Codex with a ChatGPT account.",
    "pytest"
  );
  assert.ok(hint, "expected a hint for a model-not-supported failure");
  assert.match(hint, /--model pytest/);
  assert.match(hint, /retry without `--model`/);
});

test("describeModelRejection ignores unrelated failures", () => {
  assert.equal(describeModelRejection("Codex went silent for 600s without completing the turn.", null), null);
  assert.equal(describeModelRejection("", "pytest"), null);
  assert.equal(describeModelRejection(null, null), null);
});

test("renderTaskResult appends the model hint on a model-rejection failure", () => {
  const output = renderTaskResult(
    {
      rawOutput: "",
      failureMessage: "The 'o3' model is not supported when using Codex with a ChatGPT account."
    },
    { title: "Rescue task", requestedModel: "o3" }
  );
  assert.match(output, /is not supported/);
  assert.match(output, /Codex rejected the requested model \(`--model o3`\)/);
});

test("renderTaskResult leaves a successful task output untouched", () => {
  const output = renderTaskResult({ rawOutput: "## Done\nAll good." }, { title: "Rescue task" });
  assert.equal(output, "## Done\nAll good.\n");
});

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Codex returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Codex Adversarial Review",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Codex Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Codex Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Codex session ID: thr_123/);
  assert.match(output, /Resume in Codex: codex resume thr_123/);
});
