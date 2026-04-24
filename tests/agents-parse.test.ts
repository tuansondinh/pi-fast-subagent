import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseMaxDepthField, parseToolsField } from "../agents.ts";

describe("parseToolsField", () => {
  it("defaults to 'all' when unset/empty/whitespace", () => {
    assert.equal(parseToolsField(undefined), "all");
    assert.equal(parseToolsField(null), "all");
    assert.equal(parseToolsField(""), "all");
    assert.equal(parseToolsField("   "), "all");
  });

  it("recognises canonical keywords case-insensitively", () => {
    assert.equal(parseToolsField("all"), "all");
    assert.equal(parseToolsField("ALL"), "all");
    assert.equal(parseToolsField("none"), "none");
    assert.equal(parseToolsField("NONE"), "none");
    assert.equal(parseToolsField("builtins"), "builtins");
    assert.equal(parseToolsField("builtin"), "builtins"); // legacy singular
  });

  it("parses comma-separated allowlists", () => {
    assert.deepEqual(parseToolsField("read, bash, web_search"), [
      "read",
      "bash",
      "web_search",
    ]);
  });

  it("trims blanks out of allowlists and falls back to 'all' when empty", () => {
    assert.deepEqual(parseToolsField("read, , bash"), ["read", "bash"]);
    assert.equal(parseToolsField(","), "all");
    assert.equal(parseToolsField(" , , "), "all");
  });
});

describe("parseMaxDepthField", () => {
  it("defaults to 0 when missing/empty", () => {
    assert.equal(parseMaxDepthField(undefined), 0);
    assert.equal(parseMaxDepthField(null), 0);
    assert.equal(parseMaxDepthField(""), 0);
  });

  it("accepts numeric and string inputs", () => {
    assert.equal(parseMaxDepthField(2), 2);
    assert.equal(parseMaxDepthField("3"), 3);
  });

  it("floors fractional values", () => {
    assert.equal(parseMaxDepthField(2.9), 2);
    assert.equal(parseMaxDepthField("1.4"), 1);
  });

  it("clamps invalid / negative values to 0", () => {
    assert.equal(parseMaxDepthField("NaN"), 0);
    assert.equal(parseMaxDepthField("abc"), 0);
    assert.equal(parseMaxDepthField(-1), 0);
    assert.equal(parseMaxDepthField("-5"), 0);
    assert.equal(parseMaxDepthField(Infinity), 0);
  });
});
