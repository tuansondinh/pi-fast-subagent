import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { checkDepthGate } from "../runner.ts";

describe("checkDepthGate", () => {
  it("always allows top-level calls (depth 0)", () => {
    assert.deepEqual(checkDepthGate(0, 0), { allowed: true });
    assert.deepEqual(checkDepthGate(0, 5), { allowed: true });
  });

  it("blocks nested calls when depth exceeds maxDepth", () => {
    const gate = checkDepthGate(1, 0);
    assert.equal(gate.allowed, false);
    assert.match(gate.reason ?? "", /maxDepth/);
  });

  it("allows nested calls up to the configured maxDepth", () => {
    assert.deepEqual(checkDepthGate(1, 1), { allowed: true });
    assert.deepEqual(checkDepthGate(2, 2), { allowed: true });
  });

  it("blocks once nesting exceeds the configured maxDepth", () => {
    const gate = checkDepthGate(3, 2);
    assert.equal(gate.allowed, false);
    assert.ok(gate.reason);
  });
});
