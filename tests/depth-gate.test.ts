import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { checkDepthGate, resolveModelObject } from "../runner.ts";

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

describe("resolveModelObject", () => {
  const sonnet = { provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet", api: "anthropic" };
  const haiku = { provider: "anthropic", id: "claude-haiku-4-5", name: "Haiku", api: "anthropic" };
  const registry = {
    getAll: () => [haiku, sonnet],
    find: (provider: string, id: string) => [haiku, sonnet].find((m) => m.provider === provider && m.id === id),
  };

  it("returns exact registry match", () => {
    assert.equal(resolveModelObject(registry as any, "anthropic/claude-sonnet-4-5"), sonnet);
  });

  it("clones provider model for unknown ad-hoc model id", () => {
    const model = resolveModelObject(registry as any, "anthropic/claude-sonnet-4-6");
    assert.equal(model?.provider, "anthropic");
    assert.equal(model?.id, "claude-sonnet-4-6");
    assert.equal(model?.api, "anthropic");
  });
});
