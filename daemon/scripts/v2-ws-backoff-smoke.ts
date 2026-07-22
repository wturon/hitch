import assert from "node:assert/strict";

import { computeBackoffDelay } from "../src/v2/ws.js";

// Capped exponential backoff: 1s, 2s, 4s, 8s, ... clamped to the ceiling.
assert.equal(computeBackoffDelay(0), 1000, "attempt 0 → 1s");
assert.equal(computeBackoffDelay(1), 2000, "attempt 1 → 2s");
assert.equal(computeBackoffDelay(2), 4000, "attempt 2 → 4s");
assert.equal(computeBackoffDelay(3), 8000, "attempt 3 → 8s");
assert.equal(computeBackoffDelay(4), 16000, "attempt 4 → 16s");

// Clamped at the default 30s ceiling.
assert.equal(computeBackoffDelay(5), 30000, "attempt 5 (32s) clamped to 30s");
assert.equal(computeBackoffDelay(50), 30000, "large attempt stays at the 30s ceiling");

// Custom ceiling (the test-fast path).
assert.equal(computeBackoffDelay(0, 500), 500, "1s clamped to a 500ms ceiling");
assert.equal(computeBackoffDelay(10, 500), 500, "large attempt clamped to 500ms ceiling");

console.log("v2-ws-backoff smoke OK");
