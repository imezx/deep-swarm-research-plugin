/**
 * @file local/store.ts
 * Local document store with multi-collection support.
 *
 * Indexes user documents into searchable chunks using TF-IDF weighted
 * keyword matching. Designed to run entirely on-device with zero
 * external dependencies — no vector database, no embedding model needed.
 *
 * Collections map naturally to the swarm's worker roles: a user might
 * have a "legal" collection queried by the regulatory worker, a "papers"
 * collection for the academic worker, and a "reports" collection for
 * the breadth worker.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { PDFParse } from "pdf-parse";

export interface DocumentChunk {
  readonly id: string;
  readonly collectionId: string;
  readonly filePath: string;
  readonly fileName: string;
  readonly chunkIndex: number;
  readonly text: string;
  readonly wordCount: number;
  readonly terms: ReadonlyMap<string, number>;
}

export interface LocalCollection {
  readonly id: string;
  readonly name: string;
  readonly folderPath: string;
  readonly fileCount: number;
  readonly chunkCount: number;
  readonly totalWords: number;
  readonly indexedAt: string;
}

export interface LocalSearchHit {
  readonly chunkId: string;
  readonly collectionId: string;
  readonly collectionName: string;
  readonly filePath: string;
  readonly fileName: string;
  readonly text: string;
  readonly wordCount: number;
  readonly score: number;
  readonly chunkIndex: number;
}

const MIN_CHUNK_WORDS = 20;
const MAX_CHUNKS_PER_FILE = 200;

const SUPPORTED_EXTENSIONS = new Set([
  ".pdf",
  ".txt",
  ".md",
  ".markdown",
  ".rst",
  ".org",
  ".html",
  ".htm",
  ".xhtml",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".xml",
  ".log",
  ".yaml",
  ".yml",
  ".ini",
  ".cfg",
  ".conf",
  ".tex",
  ".bib",
  ".py",
  ".js",
  ".ts",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".rs",
  ".go",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".scala",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".sql",
  ".r",
  ".R",
  ".css",
  ".scss",
  ".less",
]);

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "in",
  "of",
  "and",
  "or",
  "for",
  "to",
  "how",
  "what",
  "why",
  "when",
  "does",
  "with",
  "from",
  "that",
  "this",
  "these",
  "those",
  "would",
  "should",
  "could",
  "which",
  "about",
  "their",
  "its",
  "are",
  "was",
  "were",
  "been",
  "being",
  "have",
  "has",
  "had",
  "having",
  "do",
  "did",
  "doing",
  "will",
  "shall",
  "may",
  "might",
  "can",
  "must",
  "not",
  "no",
  "nor",
  "but",
  "if",
  "then",
  "else",
  "so",
  "than",
  "too",
  "very",
  "just",
  "only",
  "also",
  "more",
  "most",
  "some",
  "any",
  "each",
  "every",
  "all",
  "both",
  "few",
  "many",
  "much",
  "such",
  "own",
  "same",
  "other",
  "into",
  "over",
  "after",
  "before",
  "between",
  "under",
  "above",
  "below",
  "up",
  "down",
  "out",
  "off",
  "on",
  "at",
  "by",
  "as",
  "be",
  "it",
  "he",
  "she",
  "we",
  "they",
  "me",
  "him",
  "her",
  "us",
  "them",
  "my",
  "your",
  "his",
  "our",
  "you",
  "i",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s\-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function computeTermFrequencies(tokens: string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const token of tokens) {
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }
  return freq;
}

function chunkText(text: string, chunkSize: number): string[] {
  const overlap = Math.round(chunkSize * 0.1);
  const chunks: string[] = [];
  let offset = 0;

  while (offset < text.length && chunks.length < MAX_CHUNKS_PER_FILE) {
    const end = Math.min(offset + chunkSize, text.length);
    let slice = text.slice(offset, end);

    if (end < text.length) {
      const lastBreak = Math.max(
        slice.lastIndexOf("\n\n"),
        slice.lastIndexOf(". "),
        slice.lastIndexOf(".\n"),
      );
      if (lastBreak > chunkSize * 0.3) {
        slice = slice.slice(0, lastBreak + 1);
      }
    }

    const trimmed = slice.trim();
    if (trimmed.length > 0) {
      chunks.push(trimmed);
    }

    offset += Math.max(slice.length - overlap, 1);
  }

  return chunks;
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanPdfText(raw: string): string {
  return (
    raw
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/^--\s*\d+\s*of\s*\d+\s*--\s*$/gm, "")
      .replace(/(\w)-\n(\w)/g, "$1$2")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\s*\d{1,4}\s*$/gm, "")
      .trim()
  );
}

async function readFileAsText(filePath: string): Promise<string | null> {
  try {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === ".pdf") {
      try {
        const buffer = fs.readFileSync(filePath);
        const data = new Uint8Array(buffer);
        const parser = new PDFParse({ data } as any);
        const result = await parser.getText({
          lineEnforce: true,
          lineThreshold: 5,
        });
        await parser.destroy();
        const raw = result.text || "";
        return cleanPdfText(raw);
      } catch {
        return null;
      }
    }

    const raw = fs.readFileSync(filePath, "utf-8");

    if (ext === ".html" || ext === ".htm" || ext === ".xhtml") {
      return stripHtmlTags(raw);
    }

    if (ext === ".json") {
      try {
        const parsed = JSON.parse(raw);
        return JSON.stringify(parsed, null, 2);
      } catch {
        return raw;
      }
    }

    return raw;
  } catch {
    return null;
  }
}

function scanDirectory(dirPath: string): string[] {
  const files: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > 10) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTENSIONS.has(ext)) {
          files.push(fullPath);
        }
      }
    }
  }

  walk(dirPath, 0);
  return files;
}

export class LocalDocumentStore {
  private readonly collections = new Map<string, LocalCollection>();
  private readonly chunks = new Map<string, DocumentChunk>();
  private readonly collectionChunks = new Map<string, Set<string>>();
  private readonly idf = new Map<string, number>();
  private totalDocuments = 0;
  private readonly documentFrequency = new Map<string, number>();

  getCollections(): ReadonlyArray<LocalCollection> {
    return Array.from(this.collections.values());
  }

  getCollection(id: string): LocalCollection | undefined {
    return this.collections.get(id);
  }

  hasCollections(): boolean {
    return this.collections.size > 0;
  }

  async indexCollection(
    name: string,
    folderPath: string,
    chunkSize: number,
    onProgress?: (message: string) => void,
  ): Promise<LocalCollection> {
    const resolvedPath = path.resolve(folderPath);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Folder not found: ${resolvedPath}`);
    }

    const stat = fs.statSync(resolvedPath);
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${resolvedPath}`);
    }

    const existingId = Array.from(this.collections.values()).find(
      (c) => c.folderPath === resolvedPath,
    )?.id;
    if (existingId) {
      this.removeCollection(existingId);
    }

    const collectionId = crypto.randomUUID();
    const chunkIds = new Set<string>();

    onProgress?.(`Scanning ${resolvedPath} for documents…`);
    const files = scanDirectory(resolvedPath);
    onProgress?.(`Found ${files.length} supported files`);

    let totalWords = 0;
    let indexedFiles = 0;

    for (const filePath of files) {
      const text = await readFileAsText(filePath);
      if (!text || text.trim().length < 50) continue;

      const textChunks = chunkText(text, chunkSize);
      const fileName = path.relative(resolvedPath, filePath);

      for (let ci = 0; ci < textChunks.length; ci++) {
        const chunkText = textChunks[ci];
        const tokens = tokenize(chunkText);
        if (tokens.length < MIN_CHUNK_WORDS) continue;

        const chunkId = `${collectionId}:${indexedFiles}:${ci}`;
        const terms = computeTermFrequencies(tokens);

        const chunk: DocumentChunk = {
          id: chunkId,
          collectionId,
          filePath,
          fileName,
          chunkIndex: ci,
          text: chunkText,
          wordCount: tokens.length,
          terms,
        };

        this.chunks.set(chunkId, chunk);
        chunkIds.add(chunkId);
        totalWords += tokens.length;
        this.totalDocuments++;

        for (const term of terms.keys()) {
          this.documentFrequency.set(
            term,
            (this.documentFrequency.get(term) ?? 0) + 1,
          );
        }
      }

      indexedFiles++;
      if (indexedFiles % 50 === 0) {
        onProgress?.(`Indexed ${indexedFiles}/${files.length} files…`);
      }
    }

    this.rebuildIdf();

    const collection: LocalCollection = {
      id: collectionId,
      name,
      folderPath: resolvedPath,
      fileCount: indexedFiles,
      chunkCount: chunkIds.size,
      totalWords,
      indexedAt: new Date().toISOString(),
    };

    this.collections.set(collectionId, collection);
    this.collectionChunks.set(collectionId, chunkIds);

    onProgress?.(
      `Collection "${name}" ready: ${indexedFiles} files, ${chunkIds.size} chunks, ~${totalWords.toLocaleString()} words`,
    );

    return collection;
  }

  removeCollection(id: string): boolean {
    const chunkIds = this.collectionChunks.get(id);
    if (!chunkIds) return false;

    for (const chunkId of chunkIds) {
      const chunk = this.chunks.get(chunkId);
      if (chunk) {
        for (const [term, count] of chunk.terms) {
          const current = this.documentFrequency.get(term) ?? 0;
          if (current <= count) {
            this.documentFrequency.delete(term);
          } else {
            this.documentFrequency.set(term, current - count);
          }
        }
        this.totalDocuments--;
      }
      this.chunks.delete(chunkId);
    }

    this.collectionChunks.delete(id);
    this.collections.delete(id);
    this.rebuildIdf();

    return true;
  }

  listAll(
    maxResults: number = 100,
    collectionIds?: ReadonlyArray<string>,
  ): ReadonlyArray<LocalSearchHit> {
    const targetCollections = collectionIds
      ? new Set(collectionIds)
      : undefined;
    const results: LocalSearchHit[] = [];

    for (const chunk of this.chunks.values()) {
      if (results.length >= maxResults) break;
      if (targetCollections && !targetCollections.has(chunk.collectionId))
        continue;

      const collection = this.collections.get(chunk.collectionId);
      results.push({
        chunkId: chunk.id,
        collectionId: chunk.collectionId,
        collectionName: collection?.name ?? "unknown",
        filePath: chunk.filePath,
        fileName: chunk.fileName,
        text: chunk.text,
        wordCount: chunk.wordCount,
        score: 0,
        chunkIndex: chunk.chunkIndex,
      });
    }

    return results;
  }

  search(
    query: string,
    maxResults: number = 10,
    collectionIds?: ReadonlyArray<string>,
  ): ReadonlyArray<LocalSearchHit> {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const queryTerms = computeTermFrequencies(queryTokens);
    const targetCollections = collectionIds
      ? new Set(collectionIds)
      : undefined;

    const scored: Array<{ chunk: DocumentChunk; score: number }> = [];

    for (const chunk of this.chunks.values()) {
      if (targetCollections && !targetCollections.has(chunk.collectionId)) {
        continue;
      }

      let score = 0;
      let matchedTerms = 0;

      for (const [term, queryFreq] of queryTerms) {
        const docFreq = chunk.terms.get(term);
        if (!docFreq) continue;

        matchedTerms++;

        const tf = docFreq / chunk.wordCount;
        const idf = this.idf.get(term) ?? 1;
        score += tf * idf * queryFreq;
      }

      if (matchedTerms === 0) continue;

      const coverage = matchedTerms / queryTerms.size;
      score *= 1 + coverage * 0.5;

      scored.push({ chunk, score });
    }

    scored.sort((a, b) => b.score - a.score);

    const seen = new Set<string>();
    const results: LocalSearchHit[] = [];

    for (const { chunk, score } of scored) {
      if (results.length >= maxResults) break;

      const dedupeKey = `${chunk.filePath}:${chunk.chunkIndex}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const collection = this.collections.get(chunk.collectionId);

      results.push({
        chunkId: chunk.id,
        collectionId: chunk.collectionId,
        collectionName: collection?.name ?? "unknown",
        filePath: chunk.filePath,
        fileName: chunk.fileName,
        text: chunk.text,
        wordCount: chunk.wordCount,
        score,
        chunkIndex: chunk.chunkIndex,
      });
    }

    return results;
  }

  searchByRole(
    query: string,
    role: string,
    maxResults: number = 8,
    roleCollectionMap?: ReadonlyMap<string, ReadonlyArray<string>>,
  ): ReadonlyArray<LocalSearchHit> {
    const targetIds = roleCollectionMap?.get(role);
    return this.search(query, maxResults, targetIds);
  }

  getStats(): {
    collections: number;
    totalChunks: number;
    totalWords: number;
    uniqueTerms: number;
  } {
    let totalWords = 0;
    for (const col of this.collections.values()) {
      totalWords += col.totalWords;
    }
    return {
      collections: this.collections.size,
      totalChunks: this.chunks.size,
      totalWords,
      uniqueTerms: this.idf.size,
    };
  }

  private rebuildIdf(): void {
    this.idf.clear();
    const n = Math.max(1, this.totalDocuments);

    for (const [term, docCount] of this.documentFrequency) {
      this.idf.set(term, Math.log(1 + n / (1 + docCount)));
    }
  }
}

let globalStore: LocalDocumentStore | null = null;

export function getGlobalStore(): LocalDocumentStore {
  if (!globalStore) {
    globalStore = new LocalDocumentStore();
  }
  return globalStore;
}
