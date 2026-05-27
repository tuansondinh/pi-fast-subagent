import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { DEFAULT_MAX_DEPTH, type DepthState, getDepthState, runWithDepth } from "../runner.ts";

function barrier(n: number): () => Promise<void> {
  let resolve!: () => void;
  let count = 0;
  const promise = new Promise<void>((r) => { resolve = r; });
  return async () => {
    count++;
    if (count === n) resolve();
    await promise;
  };
}

describe("depth context propagation", () => {
  it("returns top-level defaults when no context is active", () => {
    assert.deepEqual(getDepthState(), { depth: 0, maxDepth: DEFAULT_MAX_DEPTH });
  });

  it("isolates depth state across overlapping async contexts", async () => {
    const both = barrier(2);
    const seen = new Map<string, DepthState>();
    await Promise.all([
      runWithDepth({ depth: 1, maxDepth: 0 }, async () => {
        await both();
        seen.set("a", getDepthState());
      }),
      runWithDepth({ depth: 1, maxDepth: 2 }, async () => {
        await both();
        seen.set("b", getDepthState());
      }),
    ]);
    assert.deepEqual(seen.get("a"), { depth: 1, maxDepth: 0 });
    assert.deepEqual(seen.get("b"), { depth: 1, maxDepth: 2 });
  });

  it("restores top-level state after concurrent contexts exit", async () => {
    const both = barrier(2);
    await Promise.all([
      runWithDepth({ depth: 1, maxDepth: 0 }, () => both()),
      runWithDepth({ depth: 1, maxDepth: 5 }, () => both()),
    ]);
    assert.deepEqual(getDepthState(), { depth: 0, maxDepth: DEFAULT_MAX_DEPTH });
  });

  it("restores top-level state even when the inner fn throws", async () => {
    await assert.rejects(
      runWithDepth({ depth: 7, maxDepth: 9 }, async () => { throw new Error("boom"); }),
      /boom/,
    );
    assert.deepEqual(getDepthState(), { depth: 0, maxDepth: DEFAULT_MAX_DEPTH });
  });
});
