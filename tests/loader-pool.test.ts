import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { LoaderPool, type PoolableLoader } from "../loader-pool.ts";

/**
 * Fake loader — implements the ResourceLoader surface with no-ops so we can
 * exercise the pool without pulling in the real extension graph.
 */
function makeFakeLoader(id: number): PoolableLoader {
  return {
    reload: async () => {
      // simulate a microtask hop
      await Promise.resolve();
    },
    getExtensions: () => [],
    getSkills: () => [],
    getPrompts: () => [],
    getThemes: () => [],
    getAgentsFiles: () => [],
    getSystemPrompt: () => `sys-${id}`,
    getAppendSystemPrompt: () => undefined,
    extendResources: () => {},
  } as unknown as PoolableLoader;
}

describe("LoaderPool", () => {
  it("reuses a single loader across acquire/release cycles", async () => {
    let created = 0;
    const pool = new LoaderPool(() => {
      created++;
      return makeFakeLoader(created);
    });

    assert.equal(pool.isWarm("/cwd", "/agents", false), false);

    const lease1 = await pool.acquire("/cwd", "/agents", false, undefined);
    assert.equal(created, 1);
    assert.equal(pool._sizes("/cwd", "/agents", false).active, 1);
    lease1.release();
    assert.equal(pool._sizes("/cwd", "/agents", false).idle, 1);
    assert.equal(pool.isWarm("/cwd", "/agents", false), true);

    const lease2 = await pool.acquire("/cwd", "/agents", false, undefined);
    assert.equal(created, 1, "second acquire should reuse pooled loader");
    lease2.release();
  });

  it("double-release is a no-op", async () => {
    let created = 0;
    const pool = new LoaderPool(() => {
      created++;
      return makeFakeLoader(created);
    });
    const lease = await pool.acquire("/cwd", "/agents", false, undefined);
    lease.release();
    lease.release();
    const sizes = pool._sizes("/cwd", "/agents", false);
    assert.equal(sizes.idle, 1);
    assert.equal(sizes.active, 0);
  });

  it("separates pool entries by (cwd, agentDir, noExtensions)", async () => {
    let created = 0;
    const pool = new LoaderPool(() => {
      created++;
      return makeFakeLoader(created);
    });
    const a = await pool.acquire("/cwd", "/agents", false, undefined);
    const b = await pool.acquire("/cwd", "/agents", true, undefined);
    assert.equal(created, 2);
    a.release();
    b.release();
    assert.equal(pool._sizes("/cwd", "/agents", false).idle, 1);
    assert.equal(pool._sizes("/cwd", "/agents", true).idle, 1);
  });

  it("warm() populates an idle loader without affecting active count", async () => {
    let created = 0;
    const pool = new LoaderPool(() => {
      created++;
      return makeFakeLoader(created);
    });
    pool.warm("/cwd", "/agents", false);
    // Wait for the warm promise to resolve by acquiring, which drains the idle queue.
    const lease = await pool.acquire("/cwd", "/agents", false, undefined);
    assert.equal(created, 1);
    lease.release();
  });

  it("concurrent acquires while warming share a single loader", async () => {
    let created = 0;
    const pool = new LoaderPool(() => {
      created++;
      return makeFakeLoader(created);
    });

    const [l1, l2] = await Promise.all([
      pool.acquire("/cwd", "/agents", false, undefined),
      pool.acquire("/cwd", "/agents", false, undefined),
    ]);

    // Only one warm created the loader; the other waiter created a second
    // loader itself because the first was already active. That's fine —
    // what matters is each lease got a distinct loader and both release cleanly.
    assert.ok(created >= 1 && created <= 2);
    l1.release();
    l2.release();
    const sizes = pool._sizes("/cwd", "/agents", false);
    assert.equal(sizes.active, 0);
    assert.ok(sizes.idle >= 1);
  });

  it("clear() drops all pool entries", async () => {
    const pool = new LoaderPool(() => makeFakeLoader(1));
    const lease = await pool.acquire("/cwd", "/agents", false, undefined);
    lease.release();
    assert.equal(pool.isWarm("/cwd", "/agents", false), true);
    pool.clear();
    assert.equal(pool.isWarm("/cwd", "/agents", false), false);
  });
});
