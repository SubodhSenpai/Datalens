import { ColumnSchema } from "./types";
import { getBlobBuffer, getBlobJson, saveBlobJson, deleteBlobPath, BlobConflictError } from "./blob";
import { parseCSVBuffer, parseXLSXBuffer } from "./parse";

// Session metadata (dataset schemas + relationships) is persisted as small
// JSON in Blob storage (Figure 6) so it survives across serverless instances
// and cold starts, not just within one warm process. Each instance keeps a
// small per-session cache, but every read does a conditional fetch
// (ifNoneMatch) against Blob first — a stale local copy is never trusted on
// its own, only confirmed-still-current via a cheap 304. Row data is NOT
// part of this JSON (would blow past reasonable payload sizes); it's loaded
// on demand from each dataset's blobUrl and cached in memory per instance,
// which is safe because a dataset's blob content never changes after upload.

export interface DatasetRecord {
  id: string;
  name: string;
  size: number;
  format: "csv" | "xlsx";
  uploadedAt: string;
  rowCount: number;
  columnCount: number;
  columns: ColumnSchema[];
  blobUrl: string;
  rows?: Record<string, unknown>[];
  /** Which sheet of the workbook this dataset is, when an XLSX blob holds several. */
  sheetName?: string;
}

export interface RelationshipRecord {
  datasetIdA: string;
  datasetIdB: string;
  /** Column name in dataset A (may differ from columnB — see basis). */
  columnA: string;
  /** Column name in dataset B. */
  columnB: string;
  /** "name": columns share an exact name; "value-overlap": names differ but their values substantially overlap. */
  basis: "name" | "value-overlap";
  /** 1.0 for name matches; for value-overlap, the fraction of the smaller column's distinct values found in the other. */
  confidence: number;

  // ── Inferred key structure (optional: absent on sessions stored before
  // this existed, so consumers must tolerate undefined) ────────────────────
  /**
   * Which side repeats. "1:N" means columnA holds each key once and columnB
   * repeats it; "N:M" means neither does, so joining these two multiplies
   * rows and inflates every sum taken across the result.
   */
  cardinality?: "1:1" | "1:N" | "N:1" | "N:M";
  /** The dataset holding the unique (parent) side, when exactly one does. */
  parentDatasetId?: string;
  /** Fraction of columnA's distinct keys also present in columnB. */
  overlapAtoB?: number;
  /** Fraction of columnB's distinct keys also present in columnA. */
  overlapBtoA?: number;
}

export interface SessionRecord {
  id: string;
  createdAt: number;
  lastAccessedAt: number;
  datasets: Map<string, DatasetRecord>;
  relationships: RelationshipRecord[];
}

// The subset of SessionRecord actually persisted to Blob — dataset rows are
// deliberately excluded (see file header).
interface DatasetMetaRecord {
  id: string;
  name: string;
  size: number;
  format: "csv" | "xlsx";
  uploadedAt: string;
  rowCount: number;
  columnCount: number;
  columns: ColumnSchema[];
  blobUrl: string;
}

interface SerializedSession {
  id: string;
  createdAt: number;
  lastAccessedAt: number;
  datasets: DatasetMetaRecord[];
  relationships: RelationshipRecord[];
}

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours auto-cleanup

function metadataPath(sessionId: string): string {
  return `sessions/${sessionId}/metadata.json`;
}

// Per-instance cache: the row Maps live only here (never serialized), and
// the SessionRecord itself is cache-then-verify, never cache-and-trust — see
// getSession below.
interface CacheEntry {
  session: SessionRecord;
  etag: string;
}
// On globalThis for the same reason as the local blob store (see blob.ts):
// a dev hot-reload must not drop sessions that are still in use.
const g = globalThis as unknown as { __datalensSessionCache?: Map<string, CacheEntry> };
const cache: Map<string, CacheEntry> = g.__datalensSessionCache ?? (g.__datalensSessionCache = new Map());

function serialize(session: SessionRecord): SerializedSession {
  return {
    id: session.id,
    createdAt: session.createdAt,
    lastAccessedAt: session.lastAccessedAt,
    datasets: Array.from(session.datasets.values()).map((d) => ({
      id: d.id,
      name: d.name,
      size: d.size,
      format: d.format,
      uploadedAt: d.uploadedAt,
      rowCount: d.rowCount,
      columnCount: d.columnCount,
      columns: d.columns,
      blobUrl: d.blobUrl,
    })),
    relationships: session.relationships,
  };
}

function hydrate(serialized: SerializedSession, previousRows?: Map<string, Record<string, unknown>[]>): SessionRecord {
  const datasets = new Map<string, DatasetRecord>();
  for (const d of serialized.datasets) {
    datasets.set(d.id, { ...d, rows: previousRows?.get(d.id) });
  }
  return {
    id: serialized.id,
    createdAt: serialized.createdAt,
    lastAccessedAt: serialized.lastAccessedAt,
    datasets,
    relationships: serialized.relationships,
  };
}

function rowsByDatasetId(session: SessionRecord): Map<string, Record<string, unknown>[]> {
  const map = new Map<string, Record<string, unknown>[]>();
  for (const [id, d] of session.datasets) if (d.rows) map.set(id, d.rows);
  return map;
}

/**
 * Reads the session, always reconciling with Blob (a locally cached copy is
 * only ever used after a 304 "not-modified" — never trusted on its own).
 * Rows already loaded into memory for this instance are preserved across
 * the refresh.
 */
export async function getSession(sessionId: string): Promise<SessionRecord | undefined> {
  const cached = cache.get(sessionId);
  const remote = await getBlobJson<SerializedSession>(metadataPath(sessionId), {
    ifNoneMatch: cached?.etag,
  });

  if (remote === null) {
    cache.delete(sessionId);
    return undefined;
  }

  if (remote === "not-modified") {
    // Cached copy confirmed current — but still enforce TTL client-side.
    if (cached && Date.now() - cached.session.lastAccessedAt > SESSION_TTL_MS) {
      cache.delete(sessionId);
      return undefined;
    }
    if (cached) cached.session.lastAccessedAt = Date.now();
    return cached?.session;
  }

  if (Date.now() - remote.data.lastAccessedAt > SESSION_TTL_MS) {
    cache.delete(sessionId);
    return undefined;
  }

  const session = hydrate(remote.data, cached ? rowsByDatasetId(cached.session) : undefined);
  cache.set(sessionId, { session, etag: remote.etag });
  return session;
}

export async function getOrCreateSession(sessionId: string): Promise<SessionRecord> {
  const existing = await getSession(sessionId);
  if (existing) return existing;

  const session: SessionRecord = {
    id: sessionId,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    datasets: new Map(),
    relationships: [],
  };
  await persist(session, undefined);
  return session;
}

/**
 * Persists a mutated SessionRecord with compare-and-swap: if another
 * instance wrote to this session since `baseEtag` was read, the write is
 * rejected and retried against the latest version rather than silently
 * clobbering the other writer's change.
 */
async function persist(session: SessionRecord, baseEtag: string | undefined): Promise<void> {
  session.lastAccessedAt = Date.now();
  const etag = await saveBlobJson(metadataPath(session.id), serialize(session), { etag: baseEtag });
  cache.set(session.id, { session, etag });
}

/**
 * Applies `mutate` to the session and saves it, retrying against the latest
 * remote version on a write conflict instead of losing either writer's
 * change. `mutate` must be a pure function of the session it's given (it may
 * be called more than once if a retry is needed).
 */
async function mutateAndSave(
  sessionId: string,
  mutate: (session: SessionRecord) => void | Promise<void>,
  maxRetries = 3
): Promise<SessionRecord> {
  let session = await getOrCreateSession(sessionId);
  let etag = cache.get(sessionId)?.etag;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await mutate(session);
    try {
      await persist(session, etag);
      return session;
    } catch (err) {
      if (!(err instanceof BlobConflictError) || attempt === maxRetries) throw err;
      // Someone else wrote in the meantime — re-fetch the latest version,
      // preserving our in-memory rows, and re-apply the mutation on top.
      const remote = await getBlobJson<SerializedSession>(metadataPath(sessionId));
      if (remote === null || remote === "not-modified") throw err;
      session = hydrate(remote.data, rowsByDatasetId(session));
      etag = remote.etag;
    }
  }
  throw new Error("unreachable");
}

// Adds datasets and recomputes relationships in a single atomic write.
// `computeRelationships` runs against this attempt's final dataset set each
// time, so a CAS retry (another instance wrote in between) still ends up
// with relationships reflecting the correct current dataset list.
export async function addDatasets(
  sessionId: string,
  newDatasets: DatasetRecord[],
  computeRelationships: (allDatasets: DatasetRecord[]) => RelationshipRecord[] | Promise<RelationshipRecord[]>
): Promise<SessionRecord> {
  return mutateAndSave(sessionId, async (session) => {
    for (const d of newDatasets) session.datasets.set(d.id, d);
    const allDatasets = Array.from(session.datasets.values());
    // Relationship detection (incl. value-overlap matching) needs full row
    // data for every dataset in the session, not just the ones just
    // uploaded — pre-existing datasets hydrated from Blob metadata may not
    // have rows loaded into this instance yet.
    // A dataset whose bytes can no longer be loaded is left out of
    // relationship detection rather than failing this upload — the file
    // being uploaded NOW is fine, and the missing one will report itself
    // the moment a query actually needs it.
    const loadable: DatasetRecord[] = [];
    for (const d of allDatasets) {
      try {
        await ensureDatasetRows(d);
        loadable.push(d);
      } catch (err) {
        console.error(`addDatasets: skipping "${d.name}" for relationship detection — ${err instanceof Error ? err.message : err}`);
      }
    }
    session.relationships = await computeRelationships(loadable);
  });
}

export async function removeDataset(sessionId: string, datasetId: string): Promise<boolean> {
  let removed = false;
  await mutateAndSave(sessionId, (session) => {
    removed = session.datasets.delete(datasetId);
    session.relationships = session.relationships.filter(
      (r) => r.datasetIdA !== datasetId && r.datasetIdB !== datasetId
    );
  });
  return removed;
}

export async function deleteSession(sessionId: string): Promise<void> {
  cache.delete(sessionId);
  await deleteBlobPath(metadataPath(sessionId));
}

export function getSessionTotalSize(session: SessionRecord): number {
  let total = 0;
  for (const d of session.datasets.values()) total += d.size;
  return total;
}

/**
 * Returns a dataset's parsed rows, loading and caching them from Blob on
 * first access in this instance (e.g. after a cold start). Safe to cache
 * indefinitely — a dataset's blob content never changes after upload.
 */
export async function ensureDatasetRows(dataset: DatasetRecord): Promise<Record<string, unknown>[]> {
  if (dataset.rows) return dataset.rows;

  const buffer = await getBlobBuffer(dataset.blobUrl);
  if (!buffer) throw new Error(`Could not load dataset "${dataset.name}" from storage.`);

  if (dataset.format === "xlsx") {
    const sheets = parseXLSXBuffer(buffer);
    const sheet = sheets.find((s) => s.sheetName === dataset.sheetName) ?? sheets[0];
    if (!sheet) throw new Error(`Could not find sheet "${dataset.sheetName}" in "${dataset.name}".`);
    dataset.rows = sheet.rows;
  } else {
    dataset.rows = parseCSVBuffer(buffer).rows;
  }
  return dataset.rows;
}
