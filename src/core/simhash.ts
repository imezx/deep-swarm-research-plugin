/**
 * @file core/simhash.ts
 * 64-bit SimHash over word tokens, compared by Hamming distance.
 */

const HASH_BITS = 64;
const DUP_DISTANCE_THRESHOLD = 12;

function fnv1a64(text: string): bigint {
  // FNV-1a adapted to 64-bit via BigInt arithmetic.
  const prime = 0x100000001b3n;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash;
}

/** SimHash of arbitrary text. Tokens should be non-empty lowercase words. */
export function simhash(tokens: ReadonlyArray<string>): bigint {
  const bitWeights = new Array<number>(HASH_BITS).fill(0);
  // Weighted features: unigrams weight 1, bigrams weight 2 (order-sensitive).
  const features: Array<[string, number]> = [];
  for (let i = 0; i < tokens.length; i++) {
    features.push([tokens[i], 1]);
    if (i + 1 < tokens.length) features.push([`${tokens[i]}_${tokens[i + 1]}`, 2]);
  }

  for (const [feature, weight] of features) {
    const h = fnv1a64(feature);
    for (let b = 0; b < HASH_BITS; b++) {
      const bitMask = 1n << BigInt(b);
      if ((h & bitMask) !== 0n) bitWeights[b] += weight;
      else bitWeights[b] -= weight;
    }
  }

  let fingerprint = 0n;
  for (let b = 0; b < HASH_BITS; b++) {
    if (bitWeights[b] > 0) fingerprint |= 1n << BigInt(b);
  }
  return fingerprint;
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x !== 0n) {
    x &= x - 1n; // clear lowest set bit
    count++;
  }
  return count;
}

export function isNearDuplicate(a: bigint, b: bigint): boolean {
  return hammingDistance(a, b) <= DUP_DISTANCE_THRESHOLD;
}
