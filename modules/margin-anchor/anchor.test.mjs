import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { capture, resolve } from "./anchor.mjs";

const dir = fileURLToPath(new URL(".", import.meta.url));
const quote = (exact, prefix = "", suffix = "") => ({ type: "TextQuoteSelector", exact, prefix, suffix });

test("CLI saves the night-shift selection and follows the moved paragraph", t => {
  const tmp = mkdtempSync(join(tmpdir(), "margin-anchor-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const call = (...args) => spawnSync(process.execPath, ["cli.mjs", ...args], { cwd: dir, encoding: "utf8" });
  const path = join(tmp, "選取.json");
  assert.equal(call("capture", "examples/before.txt", "18", "22", path).status, 0);
  const saved = readFileSync(path, "utf8");
  assert.equal(JSON.parse(saved).exact, "核對箱數");
  assert.equal(call("capture", "examples/before.txt", "0", "1", path).status, 2);
  assert.equal(readFileSync(path, "utf8"), saved);
  const moved = call("resolve", "examples/after.txt", path);
  assert.equal(moved.status, 0, moved.stderr);
  assert.deepEqual(JSON.parse(moved.stdout), { status: "attached", occurrences: 2,
    candidates: [{ start: 13, end: 17, before: 6, after: 6 }] });
  const review = join(tmp, "revision.txt");
  for (const [revision, expected] of [["已移除此項。", "missing"], ["核對箱數／核對箱數", "ambiguous"]]) {
    writeFileSync(review, revision);
    const result = call("resolve", review, path);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).status, expected);
  }
  writeFileSync(review, Buffer.from([0xff]));
  assert.equal(call("resolve", review, path).status, 2);
});

test("canonical and line-end equivalents return offsets into the unmodified revision", () => {
  const old = "前é\n👩🏽‍💻後";
  const changed = "加前e\u0301\r\n👩🏽‍💻後";
  const selector = capture(old, 1, old.indexOf("後"));
  const result = resolve(changed, selector);
  const [range] = result.candidates;
  assert.equal(result.status, "attached");
  assert.equal(changed.slice(range.start, range.end), "e\u0301\r\n👩🏽‍💻");
  assert.deepEqual([range.before, range.after], [1, 1]);
  for (const piece of ["👩", "🏽", "💻", "e"]) assert.equal(resolve(changed, quote(piece)).status, "missing");
  for (const [start, end] of [[3, 4], [5, 6], [7, 8], [2, 2], [-1, 2], [0, 100]]) {
    assert.throws(() => capture(changed, start, end), RangeError);
  }
});

test("context is bounded in graphemes and a tied overlap remains open for review", () => {
  const run = "📝".repeat(40);
  const selector = capture(run + "a" + run, run.length, run.length + 1);
  assert.equal(selector.prefix, "📝".repeat(32));
  assert.equal(selector.suffix, selector.prefix);
  const overlap = resolve("aaaa", { type: "TextQuoteSelector", exact: "aaa" });
  assert.equal(overlap.status, "ambiguous");
  assert.deepEqual(overlap.candidates.map(r => [r.start, r.end]), [[0, 3], [1, 4]]);
  for (const selector of [null, {}, quote(""), quote("a", null), quote("a", "", 2)]) {
    assert.throws(() => resolve("a", selector), TypeError);
  }
});

test("exhaustive small strings agree with a slice-based reference including all best-score ties", () => {
  const words = Array.from({ length: 127 }, (_, i) => (i + 1).toString(2).slice(1));
  for (const text of words) {
    for (const exact of words.slice(1, 31)) {
      const expected = [];
      for (let start = 0; start <= text.length - exact.length; start++) {
        const end = start + exact.length;
        if (text.slice(start, end) !== exact) continue;
        const left = text.slice(0, start);
        const right = text.slice(end);
        const before = ["0", "10"].filter(s => left.endsWith(s)).length;
        const after = ["1", "10"].filter(s => right.startsWith(s)).length;
        expected.push({ start, end, before, after });
      }
      const best = Math.max(...expected.map(r => r.before + r.after));
      const winners = expected.filter(r => r.before + r.after === best);
      const actual = resolve(text, quote(exact, "10", "10"));
      assert.equal(actual.occurrences, expected.length);
      assert.deepEqual(actual.candidates, winners);
      assert.equal(actual.status, ["missing", "attached"][winners.length] ?? "ambiguous");
    }
  }
});
