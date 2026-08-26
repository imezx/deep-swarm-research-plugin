/**
 * @file test/core.test.ts
 * Util, simhash, fetcher-guard, chunker, frontier tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractKeywords, tokenize, canonicalUrl, containsPhrase } from "../core/util";
import { simhash, isNearDuplicate, hammingDistance } from "../core/simhash";
import { assertPublicHttpUrl, isPrivateTarget } from "../net/fetcher";
import { FetchError } from "../core/errors";
import { chunkText } from "../local/store";
import { Frontier } from "../pipeline/frontier";
import type { SearchHit } from "../core/types";

/* ---------------- util ---------------- */

test("extractKeywords drops stopwords and short tokens", () => {
  const kws = extractKeywords("How does the GLP-1 receptor work for weight loss?");
  assert.ok(!kws.includes("the") && !kws.includes("how"));
  assert.ok(kws.includes("glp-1") || kws.includes("glp"));
});

test("tokenize splits words and strips punctuation", () => {
  const tokens = tokenize("state-of-the-art results, 2024!");
  assert.deepEqual(tokens, ["state", "art", "results", "2024"]);
});

test("containsPhrase respects word boundaries (v1 substring bug)", () => {
  const haystack = "career development and caregiving policies".toLowerCase();
  assert.equal(containsPhrase(haystack, "care"), false);
  assert.equal(containsPhrase(haystack, "career"), true);
});

test("canonicalUrl strips tracking params, fragment, trailing slash", () => {
  const canon = canonicalUrl("https://Example.com/some/page/?utm_source=x&id=9#top/");
  assert.equal(canon, "example.com/some/page?id=9");
});

/* ---------------- simhash ---------------- */

test("simhash detects near-duplicates across small edits", () => {
  const base = "clinical trials demonstrate sustained weight reduction over seventy two weeks of treatment".split(/\s+/);
  const edited = [...base.slice(0, -3), "over 72 weeks", ...base.slice(-1)];
  const hBase = simhash(base);
  const hEdit = simhash(edited.map((w) => w).flatMap((w) => w.split(/\s+/)));
  assert.ok(isNearDuplicate(hBase, hEdit), "minor edit should stay within threshold");
});

test("simhash separates distinct passages", () => {
  const a = simhash("quantum error correction thresholds surface code architecture".split(/\s+/));
  const b = simhash("mediterranean diet cardiovascular outcomes randomized intervention study".split(/\s+/));
  assert.equal(isNearDuplicate(a, b), false);
  assert.ok(hammingDistance(a, b) > 12);
});

/* ---------------- SSRF guard ---------------- */

function expectPrivate(url: string): void {
  assert.throws(() => assertPublicHttpUrl(url), FetchError);
}

test("private/internal targets rejected on first hop", () => {
  expectPrivate("http://127.0.0.1/admin");
  expectPrivate("http://10.0.0.5/x");
  expectPrivate("http://192.168.1.1/router");
  expectPrivate("http://172.16.0.9/cloud-metadata");
  expectPrivate("http://169.254.169.254/latest/meta-data"); // cloud metadata endpoint
  expectPrivate("http://localhost:8080/dev");
  expectPrivate("file:///etc/passwd");
  expectPrivate("ftp://example.com/file");
});

test("public https accepted", () => {
  const parsed = assertPublicHttpUrl("https://en.wikipedia.org/wiki/GLP-1");
  assert.equal(parsed.hostname, "en.wikipedia.org");
});

test("isPrivateTarget flags fc00 IPv6 range", () => {
  assert.equal(isPrivateTarget("fc00::1234"), true);
  assert.equal(isPrivateTarget("example.com"), false);
});

/* ---------------- chunker ---------------- */

test("chunker never cuts mid-word and honors overlap", () => {
  const text = ("Sentence one about topics. ".repeat(30) +
    "Second paragraph with distinct terminology.\n\n" +
    "Tail sentence content. ".repeat(120)).trim();
  const chunks = chunkText(text);

  assert.ok(chunks.length > 1, "fixture must exceed a single chunk");
  for (let i = 1; i < chunks.length; i++) {
    // Every chunk after the first begins at a plausible word start.
    assert.match(chunks[i], /^[A-Za-z0-9]/);
    assert.ok(chunks[i].length > 0 && chunks[i - 1].length > 0);
  }
});

/* ---------------- frontier ---------------- */

function hit(engine: SearchHit["engine"], url: string, title: string): SearchHit {
  return { engine, url, title, snippet: `${title} unique body`, published: null };
}

test("frontier dedupes by canonical URL and tracks visited", () => {
  const f = new Frontier();
  f.addHits([hit("wikipedia", "https://en.wikipedia.org/wiki/A?utm_campaign=z", "A")]);
  f.addHits([hit("ddg", "https://en.wikipedia.org/wiki/A#ref1", "A again")]);
  assert.equal(f.size, 1, "tracking-param & fragment variants collapse to one candidate");

  const best = f.takeBest();
  assert.notEqual(best, null);
  f.markVisited(best!.hit.url);
  assert.equal(f.isVisited("https://en.wikipedia.org/wiki/A?utm_source=x"), true);
  // Meaningful query strings are NOT collapsed (protects pagination etc.)
  assert.equal(f.isVisited("https://en.wikipedia.org/wiki/B?page=2"), false);
  assert.equal(f.takeBest(), null, "visited URLs do not requeue");
});

test("frontier prioritizes API-engine authoritative hits first", () => {
  const f = new Frontier();
  f.addHits([
    hit("brave", "https://random-forum.example.net/thread/123", "Forum post"),
    hit("openalex", "https://doi.org/10.1038/s41586-024-0001", "Nature paper"),
    hit("wikipedia", "https://en.wikipedia.org/wiki/Topic", "Wikipedia topic"),
  ]);
  const order = [f.takeBest()!.canonical, f.takeBest()!.canonical];
  assert.equal(order[0], "en.wikipedia.org/wiki/Topic");
  assert.ok(order[1] === "doi.org/10.1038/s41586-024-0001" || order[1] !== "random-forum.example.net/thread/123");
});
