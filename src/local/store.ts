/**
 * @file local/store.ts
 * Enhanced RAG document store with multi-library support.
 *
 * Major features:
 * - MULTIPLE LIBRARIES: Named libraries (like GPT4All's multi-library model)
 *   with metadata, tags, and priority tiers. Each library maps to a folder
 *   and can be tagged for automatic worker routing.
 * - PROGRESSIVE SOURCE TIERS: Libraries are ranked by priority
 *   (proprietary > internal > reference > general) so local knowledge
 *   is preferred before falling back to web.
 * - BM25 SCORING: Proper BM25 ranking (replaces basic TF-IDF) with
 *   field boosting on file names and section headings.
 * - SMART CHUNKING: Section-aware splitting that respects headings,
 *   paragraphs, and code blocks. Configurable overlap.
 * - CONTEXTUAL RETRIEVAL: Parent and sibling chunk retrieval for
 *   richer context windows around matched chunks.
 * - PERSISTENCE: Save/load index to disk JSON so re-indexing
 *   is only needed when files change.
 * - FILE METADATA: Tracks file type, modification date, size,
 *   and custom user tags per file.
 * - HYBRID SEARCH: Combines BM25 keyword matching with n-gram
 *   fuzzy matching for better recall on partial/misspelled terms.
 *
 * Designed to run entirely on-device with zero external dependencies —
 * no vector database, no embedding model needed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

let PDFParseRef: any = null;
try {
  const pdfMod = require("pdf-parse");
  PDFParseRef = pdfMod.PDFParse ?? pdfMod.default ?? pdfMod;
} catch {
  /* pdf-parse not available */
}

/** Priority tiers for progressive source retrieval. */
export type LibraryPriority =
  | "proprietary"
  | "internal"
  | "reference"
  | "general";

/** Tags that map libraries to worker roles automatically. */
export type LibraryTag =
  | "legal"
  | "academic"
  | "technical"
  | "financial"
  | "medical"
  | "policy"
  | "reports"
  | "code"
  | "general";

export interface DocumentChunk {
  readonly id: string;
  readonly libraryId: string;
  readonly filePath: string;
  readonly fileName: string;
  readonly fileRelPath: string;
  readonly chunkIndex: number;
  readonly totalChunks: number;
  readonly text: string;
  readonly wordCount: number;
  readonly terms: ReadonlyMap<string, number>;
  readonly heading: string;
  readonly sectionDepth: number;
  readonly fileType: string;
  readonly ngramSet: ReadonlySet<string>;
}

export interface FileMetadata {
  readonly filePath: string;
  readonly fileName: string;
  readonly fileRelPath: string;
  readonly fileType: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
  readonly chunkCount: number;
  readonly wordCount: number;
  readonly tags: ReadonlyArray<string>;
  readonly contentHash: string;
}

export interface LocalLibrary {
  readonly id: string;
  readonly name: string;
  readonly folderPath: string;
  readonly description: string;
  readonly priority: LibraryPriority;
  readonly tags: ReadonlyArray<LibraryTag>;
  readonly fileCount: number;
  readonly chunkCount: number;
  readonly totalWords: number;
  readonly indexedAt: string;
  readonly files: ReadonlyArray<FileMetadata>;
}

export interface LocalSearchHit {
  readonly chunkId: string;
  readonly libraryId: string;
  readonly libraryName: string;
  readonly libraryPriority: LibraryPriority;
  readonly filePath: string;
  readonly fileName: string;
  readonly fileRelPath: string;
  readonly text: string;
  readonly wordCount: number;
  readonly score: number;
  readonly bm25Score: number;
  readonly ngramScore: number;
  readonly chunkIndex: number;
  readonly totalChunks: number;
  readonly heading: string;
  readonly fileType: string;
  readonly contextBefore: string;
  readonly contextAfter: string;
}

/** Serialisable form for persistence. */
interface PersistedIndex {
  readonly version: number;
  readonly savedAt: string;
  readonly libraries: ReadonlyArray<PersistedLibrary>;
}

interface PersistedLibrary {
  readonly library: Omit<LocalLibrary, "files"> & { files: FileMetadata[] };
  readonly chunks: ReadonlyArray<PersistedChunk>;
}

interface PersistedChunk {
  readonly id: string;
  readonly libraryId: string;
  readonly filePath: string;
  readonly fileName: string;
  readonly fileRelPath: string;
  readonly chunkIndex: number;
  readonly totalChunks: number;
  readonly text: string;
  readonly wordCount: number;
  readonly terms: ReadonlyArray<[string, number]>;
  readonly heading: string;
  readonly sectionDepth: number;
  readonly fileType: string;
}

export type LocalCollection = LocalLibrary;

const MIN_CHUNK_WORDS = 15;
const MAX_CHUNKS_PER_FILE = 300;
const PERSIST_VERSION = 2;

/** BM25 parameters */
const BM25_K1 = 1.4;
const BM25_B = 0.75;

/** N-gram size for fuzzy matching */
const NGRAM_SIZE = 3;
const NGRAM_WEIGHT = 0.2;

/** Priority sort order (lower = more preferred) */
const PRIORITY_ORDER: Record<LibraryPriority, number> = {
  proprietary: 0,
  internal: 1,
  reference: 2,
  general: 3,
};

/** Worker role → library tag mapping for auto-routing. */
const ROLE_TAG_MAP: Readonly<Record<string, ReadonlyArray<LibraryTag>>> = {
  academic: ["academic", "technical"],
  regulatory: ["legal", "policy"],
  technical: ["technical", "code"],
  statistical: ["financial", "reports"],
  primary: ["reports", "general"],
  depth: ["technical", "academic"],
  breadth: ["general", "reports"],
  recency: ["general", "reports"],
  critical: ["academic", "policy"],
  comparative: ["reports", "general"],
};

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
  ".ipynb",
  ".toml",
  ".env",
  ".properties",
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
    .replace(/[^a-z0-9\s\-_]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function stemSimple(word: string): string {
  return word
    .replace(/ies$/, "y")
    .replace(/ves$/, "f")
    .replace(/(s|ed|ing|tion|ment|ness|able|ible)$/, "")
    .replace(/(.)\1+$/, "$1");
}

function tokenizeWithStems(text: string): string[] {
  const raw = tokenize(text);
  const withStems: string[] = [];
  for (const w of raw) {
    withStems.push(w);
    const stemmed = stemSimple(w);
    if (stemmed !== w && stemmed.length > 2) {
      withStems.push(stemmed);
    }
  }
  return withStems;
}

function computeTermFrequencies(tokens: string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const token of tokens) {
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }
  return freq;
}

function buildNgramSet(text: string): Set<string> {
  const ngrams = new Set<string>();
  const lower = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (let i = 0; i <= lower.length - NGRAM_SIZE; i++) {
    ngrams.add(lower.slice(i, i + NGRAM_SIZE));
  }
  return ngrams;
}

function ngramSimilarity(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const ng of a) {
    if (b.has(ng)) intersection++;
  }
  return intersection / Math.min(a.size, b.size);
}

interface ChunkMeta {
  text: string;
  heading: string;
  sectionDepth: number;
}

const HEADING_PATTERNS: ReadonlyArray<{ regex: RegExp; depth: number }> = [
  { regex: /^#{1}\s+(.+)$/m, depth: 1 },
  { regex: /^#{2}\s+(.+)$/m, depth: 2 },
  { regex: /^#{3,6}\s+(.+)$/m, depth: 3 },
  { regex: /^([A-Z][A-Z\s]{5,60})$/m, depth: 2 },
  { regex: /^(\d+\.[\d.]*\s+.{5,80})$/m, depth: 2 },
  { regex: /^(Chapter\s+\d+[.:]\s*.+)$/im, depth: 1 },
  { regex: /^(Section\s+\d+[.:]\s*.+)$/im, depth: 2 },
  {
    regex:
      /^(Abstract|Introduction|Conclusion|References|Methods|Results|Discussion)\b/im,
    depth: 1,
  },
];

function detectHeading(text: string): { heading: string; depth: number } {
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  for (const { regex, depth } of HEADING_PATTERNS) {
    const match = regex.exec(firstLine);
    if (match) {
      return { heading: (match[1] ?? firstLine).trim().slice(0, 120), depth };
    }
  }
  return { heading: "", depth: 0 };
}

function smartChunkText(text: string, chunkSize: number): ChunkMeta[] {
  const overlap = Math.round(chunkSize * 0.12);
  const chunks: ChunkMeta[] = [];

  const sectionBreaks = text.split(/\n(?=#{1,6}\s|\d+\.\s|[A-Z]{5,}\n)/);

  let buffer = "";
  let currentHeading = "";
  let currentDepth = 0;

  for (const section of sectionBreaks) {
    const { heading: newHeading, depth: newDepth } = detectHeading(section);

    if (newHeading) {
      if (buffer.trim().length > 100) {
        pushChunks(
          buffer,
          currentHeading,
          currentDepth,
          chunkSize,
          overlap,
          chunks,
        );
      }
      buffer = section;
      currentHeading = newHeading;
      currentDepth = newDepth;
    } else {
      buffer += "\n" + section;
    }

    if (buffer.length > chunkSize * 1.5) {
      pushChunks(
        buffer,
        currentHeading,
        currentDepth,
        chunkSize,
        overlap,
        chunks,
      );
      buffer = "";
    }
  }

  if (buffer.trim().length > 50) {
    pushChunks(
      buffer,
      currentHeading,
      currentDepth,
      chunkSize,
      overlap,
      chunks,
    );
  }

  if (chunks.length === 0 && text.trim().length > 50) {
    pushChunks(text, "", 0, chunkSize, overlap, chunks);
  }

  return chunks.slice(0, MAX_CHUNKS_PER_FILE);
}

function pushChunks(
  text: string,
  heading: string,
  depth: number,
  chunkSize: number,
  overlap: number,
  out: ChunkMeta[],
): void {
  if (text.length <= chunkSize * 1.3) {
    const trimmed = text.trim();
    if (trimmed.length > 50) {
      out.push({ text: trimmed, heading, sectionDepth: depth });
    }
    return;
  }

  let offset = 0;
  while (offset < text.length && out.length < MAX_CHUNKS_PER_FILE) {
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
    if (trimmed.length > 50) {
      const chunkHeading =
        offset === 0 ? heading : detectHeading(trimmed).heading || heading;
      out.push({ text: trimmed, heading: chunkHeading, sectionDepth: depth });
    }

    offset += Math.max(slice.length - overlap, 1);
  }
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
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/^--\s*\d+\s*of\s*\d+\s*--\s*$/gm, "")
    .replace(/(\w)-\n(\w)/g, "$1$2")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s*\d{1,4}\s*$/gm, "")
    .trim();
}

async function readFileAsText(filePath: string): Promise<string | null> {
  try {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === ".pdf") {
      if (!PDFParseRef) return null;
      try {
        const buffer = fs.readFileSync(filePath);
        const data = new Uint8Array(buffer);
        const parser = new PDFParseRef({ data } as any);
        const result = await parser.getText({
          lineEnforce: true,
          lineThreshold: 5,
        });
        await parser.destroy();
        return cleanPdfText(result.text || "");
      } catch {
        return null;
      }
    }

    if (ext === ".ipynb") {
      try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const notebook = JSON.parse(raw);
        return (notebook.cells ?? [])
          .map((c: any) => {
            const src = Array.isArray(c.source)
              ? c.source.join("")
              : (c.source ?? "");
            return `[${c.cell_type}]\n${src}`;
          })
          .join("\n\n");
      } catch {
        return null;
      }
    }

    const raw = fs.readFileSync(filePath, "utf-8");

    if (ext === ".html" || ext === ".htm" || ext === ".xhtml")
      return stripHtmlTags(raw);
    if (ext === ".json") {
      try {
        return JSON.stringify(JSON.parse(raw), null, 2);
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
      if (entry.name === "node_modules" || entry.name === "__pycache__")
        continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTENSIONS.has(ext) || (!ext && entry.name.length < 30)) {
          files.push(fullPath);
        }
      }
    }
  }

  walk(dirPath, 0);
  return files;
}

function fileContentHash(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    return crypto
      .createHash("sha256")
      .update(`${filePath}:${stat.size}:${stat.mtimeMs}`)
      .digest("hex")
      .slice(0, 16);
  } catch {
    return crypto.randomUUID().slice(0, 16);
  }
}

class BM25Index {
  private avgDl = 0;
  private docCount = 0;
  private readonly df = new Map<string, number>();

  rebuild(chunks: ReadonlyMap<string, DocumentChunk>): void {
    this.df.clear();
    this.docCount = chunks.size;
    let totalWords = 0;

    for (const chunk of chunks.values()) {
      totalWords += chunk.wordCount;
      for (const term of chunk.terms.keys()) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }
    }

    this.avgDl = this.docCount > 0 ? totalWords / this.docCount : 1;
  }

  score(queryTerms: Map<string, number>, chunk: DocumentChunk): number {
    let score = 0;
    const dl = chunk.wordCount;

    for (const [term, qf] of queryTerms) {
      const tf = chunk.terms.get(term) ?? 0;
      if (tf === 0) continue;

      const n = this.df.get(term) ?? 0;
      const idf = Math.log(1 + (this.docCount - n + 0.5) / (n + 0.5));
      const tfNorm =
        (tf * (BM25_K1 + 1)) /
        (tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / this.avgDl)));

      score += idf * tfNorm * qf;
    }

    if (chunk.heading) {
      const headingLower = chunk.heading.toLowerCase();
      for (const term of queryTerms.keys()) {
        if (headingLower.includes(term)) {
          score *= 1.3;
          break;
        }
      }
    }

    const fileNameLower = chunk.fileName.toLowerCase();
    for (const term of queryTerms.keys()) {
      if (fileNameLower.includes(term)) {
        score *= 1.15;
        break;
      }
    }

    return score;
  }
}

export class LocalDocumentStore {
  private readonly libraries = new Map<string, LocalLibrary>();
  private readonly chunks = new Map<string, DocumentChunk>();
  private readonly libraryChunks = new Map<string, Set<string>>();
  private readonly bm25 = new BM25Index();

  getCollections(): ReadonlyArray<LocalLibrary> {
    return this.getLibraries();
  }

  getCollection(id: string): LocalLibrary | undefined {
    return this.getLibrary(id);
  }

  hasCollections(): boolean {
    return this.libraries.size > 0;
  }

  async indexCollection(
    name: string,
    folderPath: string,
    chunkSize: number,
    onProgress?: (message: string) => void,
  ): Promise<LocalLibrary> {
    return this.indexLibrary(
      name,
      folderPath,
      "",
      "general",
      ["general"],
      chunkSize,
      onProgress,
    );
  }

  removeCollection(id: string): boolean {
    return this.removeLibrary(id);
  }

  getLibraries(): ReadonlyArray<LocalLibrary> {
    return Array.from(this.libraries.values()).sort(
      (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority],
    );
  }

  getLibrary(id: string): LocalLibrary | undefined {
    return this.libraries.get(id);
  }

  getLibraryByName(name: string): LocalLibrary | undefined {
    const lower = name.toLowerCase();
    for (const lib of this.libraries.values()) {
      if (lib.name.toLowerCase() === lower) return lib;
    }
    return undefined;
  }

  hasLibraries(): boolean {
    return this.libraries.size > 0;
  }

  findLibrariesByTag(tag: LibraryTag): ReadonlyArray<LocalLibrary> {
    return this.getLibraries().filter((lib) => lib.tags.includes(tag));
  }

  findLibrariesForRole(role: string): ReadonlyArray<string> {
    const roleTags = ROLE_TAG_MAP[role] ?? ["general"];
    const matching: LocalLibrary[] = [];

    for (const lib of this.libraries.values()) {
      if (lib.tags.some((t) => roleTags.includes(t))) {
        matching.push(lib);
      }
    }

    matching.sort(
      (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority],
    );

    if (matching.length === 0) return Array.from(this.libraries.keys());
    return matching.map((lib) => lib.id);
  }

  async indexLibrary(
    name: string,
    folderPath: string,
    description: string = "",
    priority: LibraryPriority = "general",
    tags: LibraryTag[] = ["general"],
    chunkSize: number = 4000,
    onProgress?: (message: string) => void,
  ): Promise<LocalLibrary> {
    const resolvedPath = path.resolve(folderPath);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Folder not found: ${resolvedPath}`);
    }
    if (!fs.statSync(resolvedPath).isDirectory()) {
      throw new Error(`Path is not a directory: ${resolvedPath}`);
    }

    const existingId = Array.from(this.libraries.values()).find(
      (c) => c.folderPath === resolvedPath,
    )?.id;
    if (existingId) this.removeLibrary(existingId);

    const libraryId = crypto.randomUUID();
    const chunkIds = new Set<string>();
    const fileMetadatas: FileMetadata[] = [];

    onProgress?.(`Scanning ${resolvedPath} for documents…`);
    const files = scanDirectory(resolvedPath);
    onProgress?.(`Found ${files.length} supported files`);

    let totalWords = 0;
    let indexedFiles = 0;

    for (const filePath of files) {
      const text = await readFileAsText(filePath);
      if (!text || text.trim().length < 50) continue;

      const textChunks = smartChunkText(text, chunkSize);
      const fileName = path.basename(filePath);
      const fileRelPath = path.relative(resolvedPath, filePath);
      const ext = path.extname(filePath).toLowerCase();
      const contentHash = fileContentHash(filePath);

      let fileStat: fs.Stats;
      try {
        fileStat = fs.statSync(filePath);
      } catch {
        continue;
      }

      let fileWordCount = 0;

      for (let ci = 0; ci < textChunks.length; ci++) {
        const chunkMeta = textChunks[ci];
        const tokens = tokenizeWithStems(chunkMeta.text);
        if (tokens.length < MIN_CHUNK_WORDS) continue;

        const chunkId = `${libraryId}:${indexedFiles}:${ci}`;
        const terms = computeTermFrequencies(tokens);
        const ngramSet = buildNgramSet(chunkMeta.text.slice(0, 500));

        const chunk: DocumentChunk = {
          id: chunkId,
          libraryId,
          filePath,
          fileName,
          fileRelPath,
          chunkIndex: ci,
          totalChunks: textChunks.length,
          text: chunkMeta.text,
          wordCount: tokens.length,
          terms,
          heading: chunkMeta.heading,
          sectionDepth: chunkMeta.sectionDepth,
          fileType: ext || "unknown",
          ngramSet,
        };

        this.chunks.set(chunkId, chunk);
        chunkIds.add(chunkId);
        totalWords += tokens.length;
        fileWordCount += tokens.length;
      }

      fileMetadatas.push({
        filePath,
        fileName,
        fileRelPath,
        fileType: ext || "unknown",
        sizeBytes: fileStat.size,
        modifiedAt: fileStat.mtime.toISOString(),
        chunkCount: textChunks.length,
        wordCount: fileWordCount,
        tags: inferFileTags(ext, fileName),
        contentHash,
      });

      indexedFiles++;
      if (indexedFiles % 50 === 0) {
        onProgress?.(`Indexed ${indexedFiles}/${files.length} files…`);
      }
    }

    this.bm25.rebuild(this.chunks);

    const library: LocalLibrary = {
      id: libraryId,
      name,
      folderPath: resolvedPath,
      description,
      priority,
      tags,
      fileCount: indexedFiles,
      chunkCount: chunkIds.size,
      totalWords,
      indexedAt: new Date().toISOString(),
      files: fileMetadatas,
    };

    this.libraries.set(libraryId, library);
    this.libraryChunks.set(libraryId, chunkIds);

    onProgress?.(
      `Library "${name}" ready: ${indexedFiles} files, ${chunkIds.size} chunks, ` +
        `~${totalWords.toLocaleString()} words [${priority}]`,
    );

    return library;
  }

  removeLibrary(id: string): boolean {
    const chunkIds = this.libraryChunks.get(id);
    if (!chunkIds) return false;

    for (const chunkId of chunkIds) this.chunks.delete(chunkId);
    this.libraryChunks.delete(id);
    this.libraries.delete(id);
    this.bm25.rebuild(this.chunks);

    return true;
  }

  /** Update library metadata without re-indexing. */
  updateLibraryMeta(
    id: string,
    updates: {
      name?: string;
      description?: string;
      priority?: LibraryPriority;
      tags?: LibraryTag[];
    },
  ): LocalLibrary | null {
    const lib = this.libraries.get(id);
    if (!lib) return null;

    const updated: LocalLibrary = {
      ...lib,
      name: updates.name ?? lib.name,
      description: updates.description ?? lib.description,
      priority: updates.priority ?? lib.priority,
      tags: updates.tags ?? lib.tags,
    };

    this.libraries.set(id, updated);
    return updated;
  }

  listAll(
    maxResults: number = 100,
    collectionIds?: ReadonlyArray<string>,
  ): ReadonlyArray<LocalSearchHit> {
    const targetLibs = collectionIds ? new Set(collectionIds) : undefined;
    const results: LocalSearchHit[] = [];

    for (const chunk of this.chunks.values()) {
      if (results.length >= maxResults) break;
      if (targetLibs && !targetLibs.has(chunk.libraryId)) continue;
      const lib = this.libraries.get(chunk.libraryId);
      results.push(this.makeHit(chunk, 0, 0, 0, lib));
    }

    return results;
  }

  search(
    query: string,
    maxResults: number = 10,
    collectionIds?: ReadonlyArray<string>,
  ): ReadonlyArray<LocalSearchHit> {
    return this.searchLibraries(query, maxResults, collectionIds);
  }

  searchLibraries(
    query: string,
    maxResults: number = 10,
    libraryIds?: ReadonlyArray<string>,
    priorityBoost: boolean = true,
  ): ReadonlyArray<LocalSearchHit> {
    const queryTokens = tokenizeWithStems(query);
    if (queryTokens.length === 0) return [];

    const queryTerms = computeTermFrequencies(queryTokens);
    const queryNgrams = buildNgramSet(query);
    const targetLibs = libraryIds ? new Set(libraryIds) : undefined;

    const scored: Array<{
      chunk: DocumentChunk;
      bm25: number;
      ngram: number;
      total: number;
    }> = [];

    for (const chunk of this.chunks.values()) {
      if (targetLibs && !targetLibs.has(chunk.libraryId)) continue;

      const bm25 = this.bm25.score(queryTerms, chunk);
      if (bm25 <= 0) {
        const ngram = ngramSimilarity(queryNgrams, chunk.ngramSet);
        if (ngram < 0.15) continue;
        scored.push({ chunk, bm25: 0, ngram, total: ngram * NGRAM_WEIGHT });
        continue;
      }

      const ngram = ngramSimilarity(queryNgrams, chunk.ngramSet);
      let total = bm25 + ngram * NGRAM_WEIGHT;

      if (priorityBoost) {
        const lib = this.libraries.get(chunk.libraryId);
        if (lib) {
          total *= 1 + (3 - PRIORITY_ORDER[lib.priority]) * 0.08;
        }
      }

      scored.push({ chunk, bm25, ngram, total });
    }

    scored.sort((a, b) => b.total - a.total);

    const seen = new Set<string>();
    const results: LocalSearchHit[] = [];

    for (const { chunk, bm25, ngram, total } of scored) {
      if (results.length >= maxResults) break;

      const dedupeKey = `${chunk.filePath}:${chunk.chunkIndex}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const lib = this.libraries.get(chunk.libraryId);
      results.push(this.makeHit(chunk, total, bm25, ngram, lib));
    }

    return results;
  }

  searchByRole(
    query: string,
    role: string,
    maxResults: number = 8,
    roleCollectionMap?: ReadonlyMap<string, ReadonlyArray<string>>,
  ): ReadonlyArray<LocalSearchHit> {
    const targetIds =
      roleCollectionMap?.get(role) ?? this.findLibrariesForRole(role);
    return this.searchLibraries(query, maxResults, targetIds, true);
  }

  /**
   * Progressive search: searches libraries in priority order,
   * stopping early if enough high-quality results are found.
   */
  searchProgressive(
    query: string,
    maxResults: number = 10,
    minResultsPerTier: number = 3,
  ): ReadonlyArray<LocalSearchHit> {
    const allResults: LocalSearchHit[] = [];
    const tiers: LibraryPriority[] = [
      "proprietary",
      "internal",
      "reference",
      "general",
    ];

    for (const tier of tiers) {
      const tierLibs = Array.from(this.libraries.values())
        .filter((lib) => lib.priority === tier)
        .map((lib) => lib.id);

      if (tierLibs.length === 0) continue;

      const remaining = maxResults - allResults.length;
      if (remaining <= 0) break;

      const tierResults = this.searchLibraries(
        query,
        Math.max(remaining, minResultsPerTier),
        tierLibs,
        false,
      );

      allResults.push(...tierResults);
      if (allResults.length >= maxResults) break;
    }

    allResults.sort((a, b) => b.score - a.score);
    return allResults.slice(0, maxResults);
  }

  getChunkWithContext(
    chunkId: string,
    windowSize: number = 1,
  ): { chunk: DocumentChunk; context: ReadonlyArray<DocumentChunk> } | null {
    const chunk = this.chunks.get(chunkId);
    if (!chunk) return null;

    const context: DocumentChunk[] = [];
    const libChunks = this.libraryChunks.get(chunk.libraryId);
    if (!libChunks) return { chunk, context };

    for (const sibId of libChunks) {
      const sib = this.chunks.get(sibId);
      if (!sib || sib.filePath !== chunk.filePath || sib.id === chunk.id)
        continue;
      if (Math.abs(sib.chunkIndex - chunk.chunkIndex) <= windowSize) {
        context.push(sib);
      }
    }

    context.sort((a, b) => a.chunkIndex - b.chunkIndex);
    return { chunk, context };
  }

  saveIndex(filePath: string): void {
    const persistedLibraries: PersistedLibrary[] = [];

    for (const [libId, lib] of this.libraries) {
      const libChunkIds = this.libraryChunks.get(libId);
      if (!libChunkIds) continue;

      const persistedChunks: PersistedChunk[] = [];
      for (const chunkId of libChunkIds) {
        const chunk = this.chunks.get(chunkId);
        if (!chunk) continue;
        persistedChunks.push({
          id: chunk.id,
          libraryId: chunk.libraryId,
          filePath: chunk.filePath,
          fileName: chunk.fileName,
          fileRelPath: chunk.fileRelPath,
          chunkIndex: chunk.chunkIndex,
          totalChunks: chunk.totalChunks,
          text: chunk.text,
          wordCount: chunk.wordCount,
          terms: Array.from(chunk.terms.entries()),
          heading: chunk.heading,
          sectionDepth: chunk.sectionDepth,
          fileType: chunk.fileType,
        });
      }

      persistedLibraries.push({
        library: { ...lib, files: [...lib.files] },
        chunks: persistedChunks,
      });
    }

    const index: PersistedIndex = {
      version: PERSIST_VERSION,
      savedAt: new Date().toISOString(),
      libraries: persistedLibraries,
    };

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(index), "utf-8");
  }

  loadIndex(filePath: string): { loaded: number; skipped: number } {
    if (!fs.existsSync(filePath)) return { loaded: 0, skipped: 0 };

    const raw = fs.readFileSync(filePath, "utf-8");
    const index: PersistedIndex = JSON.parse(raw);

    if (index.version !== PERSIST_VERSION) {
      return { loaded: 0, skipped: index.libraries?.length ?? 0 };
    }

    let loaded = 0;
    let skipped = 0;

    for (const persisted of index.libraries) {
      const lib = persisted.library;
      if (!fs.existsSync(lib.folderPath)) {
        skipped++;
        continue;
      }

      const chunkIds = new Set<string>();

      for (const pc of persisted.chunks) {
        const terms = new Map<string, number>(pc.terms);
        const ngramSet = buildNgramSet(pc.text.slice(0, 500));

        const chunk: DocumentChunk = { ...pc, terms, ngramSet };
        this.chunks.set(pc.id, chunk);
        chunkIds.add(pc.id);
      }

      this.libraries.set(lib.id, lib);
      this.libraryChunks.set(lib.id, chunkIds);
      loaded++;
    }

    if (loaded > 0) this.bm25.rebuild(this.chunks);
    return { loaded, skipped };
  }

  checkForChanges(libraryId: string): {
    modified: string[];
    deleted: string[];
    added: string[];
  } {
    const lib = this.libraries.get(libraryId);
    if (!lib) return { modified: [], deleted: [], added: [] };

    const modified: string[] = [];
    const deleted: string[] = [];
    const indexedFiles = new Set(lib.files.map((f) => f.filePath));

    for (const file of lib.files) {
      if (!fs.existsSync(file.filePath)) {
        deleted.push(file.fileRelPath);
        continue;
      }
      const currentHash = fileContentHash(file.filePath);
      if (currentHash !== file.contentHash) modified.push(file.fileRelPath);
    }

    const currentFiles = scanDirectory(lib.folderPath);
    const added = currentFiles
      .filter((f) => !indexedFiles.has(f))
      .map((f) => path.relative(lib.folderPath, f));

    return { modified, deleted, added };
  }

  getStats(): {
    libraries: number;
    totalChunks: number;
    totalWords: number;
    uniqueTerms: number;
    byPriority: Record<string, number>;
    collections: number;
  } {
    let totalWords = 0;
    const byPriority: Record<string, number> = {};

    for (const lib of this.libraries.values()) {
      totalWords += lib.totalWords;
      byPriority[lib.priority] = (byPriority[lib.priority] ?? 0) + 1;
    }

    const uniqueTerms = new Set<string>();
    for (const chunk of this.chunks.values()) {
      for (const term of chunk.terms.keys()) uniqueTerms.add(term);
    }

    return {
      libraries: this.libraries.size,
      collections: this.libraries.size,
      totalChunks: this.chunks.size,
      totalWords,
      uniqueTerms: uniqueTerms.size,
      byPriority,
    };
  }

  private makeHit(
    chunk: DocumentChunk,
    total: number,
    bm25: number,
    ngram: number,
    lib: LocalLibrary | undefined,
  ): LocalSearchHit {
    let contextBefore = "";
    let contextAfter = "";

    const ctxResult = this.getChunkWithContext(chunk.id, 1);
    if (ctxResult) {
      const before = ctxResult.context.find(
        (c) => c.chunkIndex === chunk.chunkIndex - 1,
      );
      const after = ctxResult.context.find(
        (c) => c.chunkIndex === chunk.chunkIndex + 1,
      );
      if (before) contextBefore = before.text.slice(-200);
      if (after) contextAfter = after.text.slice(0, 200);
    }

    return {
      chunkId: chunk.id,
      libraryId: chunk.libraryId,
      libraryName: lib?.name ?? "unknown",
      libraryPriority: lib?.priority ?? "general",
      filePath: chunk.filePath,
      fileName: chunk.fileName,
      fileRelPath: chunk.fileRelPath,
      text: chunk.text,
      wordCount: chunk.wordCount,
      score: total,
      bm25Score: bm25,
      ngramScore: ngram,
      chunkIndex: chunk.chunkIndex,
      totalChunks: chunk.totalChunks,
      heading: chunk.heading,
      fileType: chunk.fileType,
      contextBefore,
      contextAfter,
    };
  }
}

function inferFileTags(ext: string, fileName: string): string[] {
  const tags: string[] = [];
  const lower = fileName.toLowerCase();

  if ([".py", ".js", ".ts", ".java", ".c", ".cpp", ".rs", ".go"].includes(ext))
    tags.push("code");
  if ([".tex", ".bib"].includes(ext)) tags.push("academic");
  if ([".sql", ".csv", ".tsv"].includes(ext)) tags.push("data");
  if ([".md", ".txt", ".rst"].includes(ext)) tags.push("document");
  if ([".yaml", ".yml", ".json", ".xml", ".toml"].includes(ext))
    tags.push("config");
  if (
    lower.includes("legal") ||
    lower.includes("contract") ||
    lower.includes("policy")
  )
    tags.push("legal");
  if (lower.includes("report") || lower.includes("analysis"))
    tags.push("report");

  return tags.length > 0 ? tags : ["general"];
}

let globalStore: LocalDocumentStore | null = null;

export function getGlobalStore(): LocalDocumentStore {
  if (!globalStore) {
    globalStore = new LocalDocumentStore();
  }
  return globalStore;
}
