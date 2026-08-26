/**
 * @file test/bm25.test.ts
 * Doc-frequency accounting must be symmetric on add/remove.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bm25Index } from "../local/bm25";

const tf = (entries: Record<string, number>) => new Map(Object.entries(entries));

test("doc frequency increments once per distinct term per doc", () => {
  const idx = new Bm25Index();
  idx.add({ id: "a", termFrequencies: tf({ drug: 5, trial: 1 }), length: 6 });
  idx.add({ id: "b", termFrequencies: tf({ drug: 1 }), length: 1 });
  assert.equal(idx.docFrequencyOf("drug"), 2); // NOT 6 — distinct counting
});

test("doc frequency decrements symmetrically on remove", () => {
  const idx = new Bm25Index();
  idx.add({ id: "a", termFrequencies: tf({ drug: 7, trial: 2 }), length: 9 });
  idx.add({ id: "b", termFrequencies: tf({ drug: 3, trial: 4 }), length: 7 });
  assert.equal(idx.docFrequencyOf("drug"), 2);
  assert.equal(idx.docFrequencyOf("trial"), 2);

  idx.remove("a");
  assert.equal(idx.docFrequencyOf("drug"), 1, "drug must drop exactly 1");
  assert.equal(idx.docFrequencyOf("trial"), 1, "trial must drop exactly 1");

  idx.remove("b");
  assert.equal(idx.docFrequencyOf("drug"), 0);
  assert.equal(idx.has("b"), false);
});

test("add/remove/re-add round trip restores identical doc frequency", () => {
  const idx = new Bm25Index();
  const doc = { id: "x", termFrequencies: tf({ alpha: 3, beta: 2 }), length: 5 };
  idx.add(doc);
  const before = idx.docFrequencyOf("alpha");
  idx.remove("x");
  idx.add(doc);
  assert.equal(idx.docFrequencyOf("alpha"), before);
  assert.equal(idx.size, 1);
});

test("re-adding same id replaces without double-counting", () => {
  const idx = new Bm25Index();
  idx.add({ id: "x", termFrequencies: tf({ alpha: 1 }), length: 1 });
  idx.add({ id: "x", termFrequencies: tf({ alpha: 2, gamma: 1 }), length: 3 });
  assert.equal(idx.size, 1);
  assert.equal(idx.docFrequencyOf("gamma"), 1);
  assert.ok(idx.search(["gamma"], 3).length === 1);
});

test("search ranks multi-term matches above single-term", () => {
  const idx = new Bm25Index();
  idx.add({ id: "both", termFrequencies: tf({ vaccine: 2, efficacy: 2 }), length: 4 });
  idx.add({ id: "one", termFrequencies: tf({ vaccine: 5 }), length: 5 });
  const results = idx.search(["vaccine", "efficacy"], 10);
  assert.equal(results[0].id, "both");
});
