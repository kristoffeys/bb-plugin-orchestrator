import assert from "node:assert/strict";
import test from "node:test";
import { classifyIdleWorker } from "../lib/liveness.ts";

test("classifies why a worker stopped without a completion record", () => {
  assert.equal(classifyIdleWorker(null), "empty");
  assert.equal(classifyIdleWorker("  ok  "), "empty");
  assert.equal(classifyIdleWorker("I read the router. Next, I will add the validation and then run the tests."), "plan_only");
  assert.equal(classifyIdleWorker("I cannot proceed until I have access to the staging database."), "blocked");
  assert.equal(classifyIdleWorker("Implemented the handler and the tests pass. Nothing is blocking this."), "unreported");
  assert.equal(classifyIdleWorker("I added the migration and updated the service. Let me know if you want more."), "unreported");
  assert.equal(classifyIdleWorker("I updated the auth middleware so unauthorized requests are blocked. Tests pass."), "unreported");
  assert.equal(classifyIdleWorker("All changes committed. Let me know if you need anything else."), "unreported");
  assert.equal(classifyIdleWorker("I'm blocked on the missing schema from the api workstream."), "blocked");
});
