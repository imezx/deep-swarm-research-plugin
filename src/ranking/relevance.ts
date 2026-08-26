/**
 * @file ranking/relevance.ts
 * Tokenized, word-boundary relevance scoring against topic keywords.
 */
import type { SearchHit } from "../core/types";
import { tokenize } from "../core/util";

export interface RelevanceInput {
  readonly title: string;
  readonly snippet: string;
  readonly body: string;
}

const TITLE_WEIGHT = 2.0;
const SNIPPET_WEIGHT = 0.8;
const DENSITY_WINDOW_CHARS = 8_000;

/**
 * Relevance in [0,1]: coverage of topic keywords across title/snippet/body
 * plus a keyword-density bonus over the leading window of the body.
 */
export function computeRelevance(
  input: RelevanceInput,
  topicKeywords: ReadonlyArray<string>,
): number {
  if (topicKeywords.length === 0) return 0.5;

  const titleTokens = new Set(tokenize(input.title));
  const snippetTokens = new Set(tokenize(input.snippet));
  const bodyTokenList = tokenize(input.body);
  const bodySet = new Set(bodyTokenList);
  const densityWindow = ` ${bodyTokenList.slice(0, 400).join(" ")} `;
  const kwTokenSets = topicKeywords.map((kw) => tokenize(kw));

  let covered = 0;
  for (const kwTokens of kwTokenSets) {
    if (kwTokens.length === 0) continue;
    // A keyword counts as hit when ALL its tokens appear (multi-word phrases).
    const allInBody = kwTokens.every((t) => bodySet.has(t));
    const allInTitle = kwTokens.every((t) => titleTokens.has(t));
    const allInSnippet = kwTokens.every((t) => snippetTokens.has(t));
    if (allInBody || allInTitle || allInSnippet) covered++;
  }
  const coverage = covered / kwTokenSets.length;

  const densityHits = kwTokenSets.reduce((sum, kwTokens) => {
    for (const t of kwTokens) {
      if (densityWindow.includes(` ${t} `)) sum += 1;
    }
    return sum;
  }, 0);
  const densityBonus =
    Math.min(1, densityHits / Math.max(4, kwTokenSets.length)) * 0.15;

  const titleFraction = kwTokenSets.reduce((hitCount, kwTokens) => (
    kwTokens.every((t) => titleTokens.has(t)) ? hitCount + 1 : hitCount
  ), 0) / kwTokenSets.length;

  const raw = coverage + titleFraction * TITLE_WEIGHT * 0.3 +
    SNIPPET_WEIGHT * 0.1 + densityBonus;
  void input; // fields consumed via precomputed token sets above

  return Math.max(0, Math.min(1, raw / 1.35));
}
