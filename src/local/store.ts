/**
 * @file local/store.ts
 * Disk-backed local document collections with BM25 search. Snapshots are
 * written atomically and reloaded on startup.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Bm25Index } from "./bm25";
import { tokenize } from "../core/util";

const CHUNK_SIZE_CHARS = 1_500;
const CHUNK_OVERLAP_CHARS = 200;
const MIN_CHUNK_WORDS = 20;
const MAX_CHUNKS_PER_FILE = 200;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([
  ".txt", ".md", ".markdown", ".rst", ".html", ".htm", ".xhtml",
  ".csv", ".tsv", ".json", ".xml", ".yaml", ".yml", ".toml", ".ini",
  ".log", ".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".c", ".h",
  ".cpp", ".hpp", ".cs", ".go", ".rs", ".rb", ".php", ".sh", ".sql",
]);

/* ---------------- chunking & text prep ---------------- */

export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let offset = 0;

  while (offset < text.length && chunks.length < MAX_CHUNKS_PER_FILE) {
    const remaining = text.length - offset;
    if (remaining <= CHUNK_SIZE_CHARS) {
      // Final partial slice — take whole, no overlap math needed.
      const tail = text.slice(offset).trim();
      if (tail.length > 0) chunks.push(tail);
      break;
    }

    let slice = text.slice(offset, offset + CHUNK_SIZE_CHARS);
    // Prefer paragraph breaks; accept sentence ends; NEVER cut mid-word.
    const breakAt = Math.max(
      slice.lastIndexOf("\n\n"),
      slice.lastIndexOf(". "),
      slice.lastIndexOf(".\n"),
    );
    if (breakAt > CHUNK_SIZE_CHARS * 0.3) {
      slice = slice.slice(0, breakAt + 1);
    }

    const trimmed = slice.trim();
    if (trimmed.length > 0) chunks.push(trimmed);

    // Advance by the trimmed length minus overlap; minimum stride of half a
    // chunk guarantees progress even on degenerate repetitive text.
    const advance = Math.max(
      trimmed.length - CHUNK_OVERLAP_CHARS,
      Math.floor(CHUNK_SIZE_CHARS / 2),
      1,
    );
    offset += advance;
  }

  return chunks;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function readFileText(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_BYTES) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    const ext = path.extname(filePath).toLowerCase();
    return ext === ".html" || ext === ".htm" || ext === ".xhtml"
      ? stripHtml(raw)
      : raw;
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
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath, depth + 1);
      else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(fullPath);
      }
    }
  }

  walk(dirPath, 0);
  return files.sort();
}

/* ---------------- persistence types ---------------- */

interface StoredChunk {
  id: string;
  fileName: string;
  filePath: string;
  text: string;
}

interface Snapshot {
  version: 2;
  collectionId: string;
  name: string;
  folderPath: string;
  indexedAt: string;
  chunks: StoredChunk[];
}

export interface LocalCollectionInfo {
  readonly id: string;
  readonly name: string;
  readonly folderPath: string;
  readonly fileCount: number;
  readonly chunkCount: number;
  readonly totalWords: number;
  readonly indexedAt: string;
}

export interface LocalSearchHit {
  readonly collectionId: string;
  readonly collectionName: string;
  readonly fileName: string;
  readonly filePath: string;
  readonly chunkIndex: number;
  readonly text: string;
  readonly wordCount: number;
  readonly score: number;
}

const STORAGE_DIR = path.join(
  process.env.USERPROFILE ?? process.env.HOME ?? ".",
  ".deep-swarm-research",
  "collections",
);

class Collection {
  readonly info: LocalCollectionInfo;
  private readonly chunkTexts = new Map<string, StoredChunk>();
  private readonly index = new Bm25Index();

  constructor(info: LocalCollectionInfo) {
    this.info = info;
  }

  addChunk(chunk: StoredChunk): void {
    this.chunkTexts.set(chunk.id, chunk);
    const tokens = tokenize(chunk.text);
    const terms = new Map<string, number>();
    for (const t of tokens) terms.set(t, (terms.get(t) ?? 0) + 1);
    this.index.add({ id: chunk.id, termFrequencies: terms, length: tokens.length });
  }

  removeChunk(id: string): void {
    this.chunkTexts.delete(id);
    this.index.remove(id);
  }

  get chunkCount(): number {
    return this.index.size;
  }

  search(queryTokens: ReadonlyArray<string>, limit: number): Array<{ chunk: StoredChunk; score: number }> {
    return this.index.search(queryTokens, limit).map(({ id, score }) => ({
      chunk: this.chunkTexts.get(id)!,
      score,
    })).filter((r) => r.chunk !== undefined);
  }
}

/* ---------------- store ---------------- */

export class DocumentStore {
  private readonly collections = new Map<string, Collection>();
  private loaded = false;

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      for (const file of fs.existsSync(STORAGE_DIR)
        ? fs.readdirSync(STORAGE_DIR).filter((f) => f.endsWith(".json"))
        : []) {
        this.loadSnapshot(path.join(STORAGE_DIR, file));
      }
    } catch {
      // Corrupt/absent storage — start empty rather than crash the plugin.
    }
  }

  private loadSnapshot(file: string): void {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Snapshot;
    if (raw.version !== 2 || !Array.isArray(raw.chunks)) return;
    const info: LocalCollectionInfo = {
      id: raw.collectionId,
      name: raw.name,
      folderPath: raw.folderPath,
      fileCount: new Set(raw.chunks.map((c) => c.filePath)).size,
      chunkCount: raw.chunks.length,
      totalWords: raw.chunks.reduce(
        (sum, c) => sum + tokenize(c.text).length, 0),
      indexedAt: raw.indexedAt,
    };
    const col = new Collection(info);
    for (const chunk of raw.chunks) col.addChunk(chunk);
    this.collections.set(raw.collectionId, col);
  }

  getCollections(): ReadonlyArray<LocalCollectionInfo> {
    this.ensureLoaded();
    return [...this.collections.values()].map((c) => c.info);
  }

  hasCollections(): boolean {
    this.ensureLoaded();
    return this.collections.size > 0;
  }

  /**
   * Indexes a folder. Replaces any existing collection pointed at the same
   * resolved folder. Persists atomically before returning.
   */
  indexCollection(
    name: string,
    folderPath: string,
    onProgress?: (message: string) => void,
  ): LocalCollectionInfo {
    this.ensureLoaded();
    const resolved = path.resolve(folderPath);
    if (!fs.existsSync(resolved)) throw new Error(`Folder not found: ${resolved}`);
    if (!fs.statSync(resolved).isDirectory()) throw new Error(`Not a directory: ${resolved}`);

    for (const existing of this.collections.values()) {
      if (existing.info.folderPath === resolved) this.removeCollection(existing.info.id);
    }

    const collectionId = crypto.randomUUID();
    onProgress?.(`Scanning ${resolved}…`);
    const files = scanDirectory(resolved);
    onProgress?.(`Found ${files.length} supported files`);

    const collection = new Collection({
      id: collectionId,
      name,
      folderPath: resolved,
      fileCount: 0,
      chunkCount: 0,
      totalWords: 0,
      indexedAt: new Date().toISOString(),
    });

    const pending: StoredChunk[] = [];
    let indexedFiles = 0;

    for (const filePath of files) {
      const text = readFileText(filePath);
      if (!text || text.trim().length < 50) continue;

      const relName = path.relative(resolved, filePath);
      const chunks = chunkText(text);
      for (let ci = 0; ci < chunks.length; ci++) {
        if (tokenize(chunks[ci]).length < MIN_CHUNK_WORDS) continue;
        const chunk: StoredChunk = {
          id: `${collectionId}:${filePath}:${ci}`,
          fileName: relName,
          filePath,
          text: chunks[ci],
        };
        pending.push(chunk);
        collection.addChunk(chunk);
      }
      indexedFiles += 1;
      if (indexedFiles % 50 === 0) onProgress?.(`Indexed ${indexedFiles}/${files.length} files…`);
    }

    const info: LocalCollectionInfo = {
      ...collection.info,
      fileCount: indexedFiles,
      chunkCount: collection.chunkCount,
    };
    this.collections.set(collectionId, collection);

    // Atomic snapshot BEFORE returning — crash-safe and immediately reloadable.
    this.persistSnapshot(
      { version: 2, collectionId, name, folderPath: resolved, indexedAt: collection.info.indexedAt, chunks: pending },
    );

    onProgress?.(`Collection "${name}" ready: ${info.fileCount} files, ${info.chunkCount} chunks`);
    return info;
  }

  /** Atomic write: temp file in same dir + rename. */
  private persistSnapshot(snapshot: Snapshot): void {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    const tempPath = path.join(STORAGE_DIR, `.${snapshot.collectionId}.tmp`);
    const finalPath = path.join(STORAGE_DIR, `${snapshot.collectionId}.json`);
    fs.writeFileSync(tempPath, JSON.stringify(snapshot));
    fs.renameSync(tempPath, finalPath);
  }

  removeCollection(id: string): boolean {
    this.ensureLoaded();
    const existed = this.collections.delete(id);
    const file = path.join(STORAGE_DIR, `${id}.json`);
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch { /* best-effort disk cleanup */ }
    return existed;
  }

  search(
    query: string,
    maxResults: number,
    collectionIds?: ReadonlyArray<string>,
  ): LocalSearchHit[] {
    this.ensureLoaded();
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const targets = collectionIds
      ? [...this.collections.entries()].filter(([id]) => collectionIds.includes(id))
      : [...this.collections.entries()];
    if (targets.length === 0) return [];

    const perCollection = Math.max(maxResults, 4);
    const pooled: Array<{ hit: LocalSearchHit }> = [];

    for (const [id, col] of targets) {
      for (const { chunk, score } of col.search(queryTokens, perCollection)) {
        pooled.push({
          hit: {
            collectionId: id,
            collectionName: col.info.name,
            fileName: chunk.fileName,
            filePath: chunk.filePath,
            chunkIndex: Number(chunk.id.split(":").pop() ?? 0),
            text: chunk.text,
            wordCount: tokenize(chunk.text).length,
            score,
          },
        });
      }
    }

    return pooled
      .sort((a, b) => b.hit.score - a.hit.score)
      .slice(0, maxResults)
      .map((p) => p.hit);
  }
}

let globalStore: DocumentStore | null = null;

export function getDocumentStore(): DocumentStore {
  globalStore ??= new DocumentStore();
  return globalStore;
}
