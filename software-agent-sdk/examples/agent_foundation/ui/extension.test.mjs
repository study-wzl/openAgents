import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { activate, createTaskSubmitter } from "./extension.mjs";

// @spec GAF-006 — Form retries preserve the canonical task's idempotency key.
test("task form retries reuse the request identity and changed input starts a new request", async () => {
  const requests = [];
  const submit = createTaskSubmitter({ createTask: async (input) => {
    requests.push(input);
    if (requests.length === 1) throw new Error("Connection lost after submit");
    return { conversation_id: "conversation-1" };
  } });
  await assert.rejects(submit("research/coordinator", "Compare evidence"));
  await submit("research/coordinator", "Compare evidence");
  assert.deepEqual(requests[0], requests[1]);
  await submit("operations/coordinator", "Review queue");
  assert.notEqual(requests[2].idempotency_key, requests[1].idempotency_key);
  assert.equal(requests[2].agent_id, "operations/coordinator");
  await assert.rejects(submit("unknown/agent", "Task"));
  assert.equal(requests.length, 3);
});

test("registrations match the manifest and activation disposal unregisters all contributions", async () => {
  const manifest = JSON.parse(await readFile(new URL("./canvas-extension.json", import.meta.url), "utf8"));
  const pages = [];
  const renderers = [];
  const disposed = [];
  const cleanup = activate({
    registerPage: (id) => { pages.push(id); return () => disposed.push(id); },
    registerResultRenderer: (id) => { renderers.push(id); return () => disposed.push(id); },
  });
  assert.deepEqual(pages, manifest.contributes.pages.map((page) => page.id));
  assert.deepEqual(renderers, manifest.contributes.result_renderers.map((renderer) => renderer.id));
  cleanup();
  assert.equal(disposed.length, pages.length + renderers.length);
});

test("older v1 hosts without result rendering can still register the business page", () => {
  let registered;
  const cleanup = activate({ registerPage: (id) => { registered = id; return () => {}; } });
  assert.equal(registered, "business-task");
  cleanup();
});
