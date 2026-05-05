import { test } from "node:test";
import assert from "node:assert/strict";
import { interpolate, listProfiles, loadProfile } from "../src/profile.js";

test("loadProfile loads the bundled litellm profile from disk", () => {
  const profile = loadProfile("litellm");

  assert.equal(profile.name, "litellm");
  assert.equal(profile.cloneUrl, "https://github.com/BerriAI/litellm.git");
  assert.equal(profile.defaultRef, "main");
  assert.ok(
    profile.start.command.includes("litellm"),
    "start command should reference litellm"
  );
  assert.ok(
    profile.start.env["LITELLM_MASTER_KEY"]?.includes("{master_key}"),
    "env should declare LITELLM_MASTER_KEY with placeholder"
  );
  assert.ok(
    profile.healthCheck.url.includes("{port}"),
    "health check URL should be parameterized by port"
  );
  assert.ok(profile.healthCheck.timeoutMs > 0);
  assert.ok(profile.repro.length > 100, "repro skill should not be empty");
  assert.ok(profile.prompt.length > 0, "prompt addendum should not be empty");
});

test("loadProfile throws a clear error when the profile folder is missing", () => {
  assert.throws(
    () => loadProfile("definitely-not-a-real-profile"),
    /Profile 'definitely-not-a-real-profile' not found/
  );
});

test("listProfiles includes the bundled litellm profile", () => {
  const profiles = listProfiles();
  assert.ok(
    profiles.includes("litellm"),
    `expected 'litellm' in [${profiles.join(", ")}]`
  );
});

test("interpolate substitutes known placeholders", () => {
  const result = interpolate(
    "service --port {port} --key {master_key}",
    { port: 5001, master_key: "sk-abc" }
  );
  assert.equal(result, "service --port 5001 --key sk-abc");
});

test("interpolate leaves unknown placeholders untouched", () => {
  const result = interpolate("port={port} mystery={unknown}", { port: 5001 });
  assert.equal(result, "port=5001 mystery={unknown}");
});

test("interpolate handles strings with no placeholders", () => {
  const result = interpolate("static value", { port: 5001 });
  assert.equal(result, "static value");
});
