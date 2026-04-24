import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { findTrailingTools } from "../render.ts";
import type { ExecutionEvent } from "../types.ts";

describe("findTrailingTools", () => {
  it("returns empty when event log is empty", () => {
    const r = findTrailingTools([]);
    assert.deepEqual(r, { trailingToolIds: [], hasAnyText: false });
  });

  it("hasAnyText=false when only tool events exist (all tools are 'trailing')", () => {
    // When no text has been emitted, the caller treats hasAnyText=false as
    // "show all tools", so trailingToolIds will contain every tool_start.
    const events: ExecutionEvent[] = [
      { type: "tool_start", toolCallId: "t1", toolName: "read", argSummary: "a.ts", timestamp: 1 },
      { type: "tool_end", toolCallId: "t1", result: "ok", isError: false, durMs: 5, timestamp: 2 },
    ];
    const r = findTrailingTools(events);
    assert.equal(r.hasAnyText, false);
    assert.deepEqual(r.trailingToolIds, ["t1"]);
  });

  it("returns only tool_starts after the last text_delta", () => {
    const events: ExecutionEvent[] = [
      { type: "tool_start", toolCallId: "t1", toolName: "read", argSummary: "a.ts", timestamp: 1 },
      { type: "tool_end", toolCallId: "t1", result: "ok", isError: false, durMs: 5, timestamp: 2 },
      { type: "text_delta", text: "found stuff", timestamp: 3 },
      { type: "tool_start", toolCallId: "t2", toolName: "read", argSummary: "b.ts", timestamp: 4 },
      { type: "tool_start", toolCallId: "t3", toolName: "read", argSummary: "c.ts", timestamp: 5 },
    ];
    const r = findTrailingTools(events);
    assert.equal(r.hasAnyText, true);
    assert.deepEqual(r.trailingToolIds, ["t2", "t3"]);
  });

  it("returns empty trailing list when text is the last event", () => {
    const events: ExecutionEvent[] = [
      { type: "tool_start", toolCallId: "t1", toolName: "read", argSummary: "a.ts", timestamp: 1 },
      { type: "tool_end", toolCallId: "t1", result: "ok", isError: false, durMs: 5, timestamp: 2 },
      { type: "text_delta", text: "done", timestamp: 3 },
    ];
    const r = findTrailingTools(events);
    assert.equal(r.hasAnyText, true);
    assert.deepEqual(r.trailingToolIds, []);
  });

  it("uses the LAST text_delta as the boundary, not the first", () => {
    const events: ExecutionEvent[] = [
      { type: "text_delta", text: "thinking...", timestamp: 1 },
      { type: "tool_start", toolCallId: "t1", toolName: "read", argSummary: "a.ts", timestamp: 2 },
      { type: "tool_end", toolCallId: "t1", result: "ok", isError: false, durMs: 5, timestamp: 3 },
      { type: "text_delta", text: "found X", timestamp: 4 },
      { type: "tool_start", toolCallId: "t2", toolName: "read", argSummary: "b.ts", timestamp: 5 },
    ];
    const r = findTrailingTools(events);
    assert.deepEqual(r.trailingToolIds, ["t2"]);
  });

  it("deduplicates tool_starts with the same id", () => {
    const events: ExecutionEvent[] = [
      { type: "text_delta", text: "ok", timestamp: 1 },
      { type: "tool_start", toolCallId: "t1", toolName: "read", argSummary: "a.ts", timestamp: 2 },
      { type: "tool_start", toolCallId: "t1", toolName: "read", argSummary: "a.ts", timestamp: 3 },
    ];
    const r = findTrailingTools(events);
    assert.deepEqual(r.trailingToolIds, ["t1"]);
  });
});
