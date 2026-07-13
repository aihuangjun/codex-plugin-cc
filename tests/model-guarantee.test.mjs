import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveTaskModel,
  isModelOverrideAllowed
} from "../plugins/codex/scripts/codex-companion.mjs";

test("resolveTaskModel ignores an injected model by default so the Codex config default is used", () => {
  const bogus = resolveTaskModel("pytest", {});
  assert.equal(bogus.model, null, "model must fall back to the config default");
  assert.equal(bogus.ignoredModel, "pytest", "the ignored model is reported so the runtime can note it");

  const real = resolveTaskModel("gpt-5.4-mini", {});
  assert.equal(real.model, null);
  assert.equal(real.ignoredModel, "gpt-5.4-mini");
});

test("resolveTaskModel leaves the default untouched when no model was requested", () => {
  const none = resolveTaskModel(null, {});
  assert.equal(none.model, null);
  assert.equal(none.ignoredModel, null);
  const blank = resolveTaskModel("   ", {});
  assert.equal(blank.model, null);
  assert.equal(blank.ignoredModel, null);
});

test("resolveTaskModel honors --model only when the override env is explicitly enabled", () => {
  const env = { CODEX_COMPANION_ALLOW_MODEL_OVERRIDE: "1" };
  const spark = resolveTaskModel("spark", env);
  assert.equal(spark.model, "gpt-5.3-codex-spark", "spark alias resolves when overrides are allowed");
  assert.equal(spark.ignoredModel, null);

  const explicit = resolveTaskModel("gpt-5.4-mini", { CODEX_COMPANION_ALLOW_MODEL_OVERRIDE: "true" });
  assert.equal(explicit.model, "gpt-5.4-mini");
  assert.equal(explicit.ignoredModel, null);
});

test("isModelOverrideAllowed only accepts explicit truthy values", () => {
  assert.equal(isModelOverrideAllowed({}), false);
  assert.equal(isModelOverrideAllowed({ CODEX_COMPANION_ALLOW_MODEL_OVERRIDE: "0" }), false);
  assert.equal(isModelOverrideAllowed({ CODEX_COMPANION_ALLOW_MODEL_OVERRIDE: "false" }), false);
  assert.equal(isModelOverrideAllowed({ CODEX_COMPANION_ALLOW_MODEL_OVERRIDE: "1" }), true);
  assert.equal(isModelOverrideAllowed({ CODEX_COMPANION_ALLOW_MODEL_OVERRIDE: "on" }), true);
});
