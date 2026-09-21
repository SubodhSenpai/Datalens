import { NextRequest, NextResponse } from "next/server";
import { DatasetFile, DatasetLink, MAX_FILES, MAX_FILE_SIZE_MB, MAX_SESSION_SIZE_MB, SUPPORTED_FORMATS } from "@/lib/types";
import { parseCSVBuffer, parseXLSXBuffer } from "@/lib/parse";
import { uploadFile, getBlobBuffer } from "@/lib/blob";
import { getOrCreateSession, getSessionTotalSize, addDatasets, DatasetRecord } from "@/lib/session-store";
import { detectRelationships } from "@/lib/relationships";

export const runtime = "nodejs";
// Parsing a 30k-row workbook and detecting relationships across a session
// takes longer than the 10 s default on some plans.
export const maxDuration = 60;

/** One incoming file, whether it arrived in the request or was put in Blob by the browser. */
interface Incoming { name: string; size: number; bytes: () => Promise<Buffer>; blobUrl?: string }

/**
 * POST /api/upload
 *
 * multipart/form-data: sessionId (string) + files (one or more File entries).
 * Stores raw bytes in Blob, parses server-side into DataFrame-equivalent rows,
 * infers schema, and updates the session's dataset + relationship metadata.
 * Covers Figure 2 (Blob storage) and Figure 3 (Data Processing Module).
 */
export async function POST(req: NextRequest) {
  // Two ways in. Multipart carries the bytes (local dev, small files). JSON
  // carries references to blobs the browser already uploaded directly —
  // the only way past the platform's request-body limit for large files.
  let sessionId: string;
  let files: Incoming[];
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    const body = (await req.json()) as { sessionId?: string; blobs?: { name: string; url: string; size: number }[] };
    sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    files = (body.blobs ?? []).map((b) => ({
      name: b.name, size: b.size, blobUrl: b.url,
      bytes: async () => { const buf = await getBlobBuffer(b.url); if (!buf) throw new Error("stored file not readable"); return buf; },
    }));
    // A reference must point inside this session's folder; anything else
    // could read another session's blob through this route.
    if (files.some((f) => !f.blobUrl || !f.blobUrl.includes(`/sessions/${sessionId}/`))) {
      return NextResponse.json({ error: "A stored file does not belong to this session." }, { status: 400 });
    }
  } else {
    const form = await req.formData();
    const sid = form.get("sessionId");
    sessionId = typeof sid === "string" ? sid : "";
    files = form.getAll("files").filter((f): f is File => f instanceof File).map((f) => ({ name: f.name, size: f.size, bytes: async () => Buffer.from(await f.arrayBuffer()) }));
  }
  if (!sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }
  if (files.length === 0) {
    return NextResponse.json({ error: "No files provided" }, { status: 400 });
  }

  const session = await getOrCreateSession(sessionId);

  // Count source FILES, not datasets — a multi-sheet workbook becomes one
  // dataset per sheet, so counting datasets would charge a 2-sheet .xlsx
  // twice against a limit the user reads as "10 files".
  const existingFileCount = new Set(Array.from(session.datasets.values()).map((d) => d.blobUrl)).size;
  if (existingFileCount + files.length > MAX_FILES) {
    return NextResponse.json(
      { error: `Session limit is ${MAX_FILES} files (has ${existingFileCount}, tried to add ${files.length}).` },
      { status: 400 }
    );
  }

  const incomingSize = files.reduce((acc, f) => acc + f.size, 0);
  if (getSessionTotalSize(session) + incomingSize > MAX_SESSION_SIZE_MB * 1024 * 1024) {
    return NextResponse.json({ error: `Session size limit is ${MAX_SESSION_SIZE_MB}MB.` }, { status: 400 });
  }

  const newRecords: DatasetRecord[] = [];
  const created: DatasetFile[] = [];
  const errors: { name: string; error: string }[] = [];

  for (const file of files) {
    const ext = "." + file.name.split(".").pop()?.toLowerCase();
    if (!SUPPORTED_FORMATS.includes(ext)) {
      errors.push({ name: file.name, error: "Unsupported format. Use CSV or XLSX." });
      continue;
    }
    if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      errors.push({ name: file.name, error: `File exceeds ${MAX_FILE_SIZE_MB}MB limit.` });
      continue;
    }

    try {
      const buffer = await file.bytes();
      const isXlsx = ext === ".xlsx" || ext === ".xls";
      const parsedSheets = isXlsx ? parseXLSXBuffer(buffer) : [{ sheetName: "", ...parseCSVBuffer(buffer) }];

      if (parsedSheets.length === 0) {
        errors.push({ name: file.name, error: "No readable table found in this file." });
        continue;
      }

      // Already stored by the browser? Reuse it; otherwise store the bytes now.
      const blobUrl = file.blobUrl ?? await uploadFile(
        `sessions/${sessionId}/${Date.now()}-${file.name}`,
        buffer,
        isXlsx ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv"
      );

      // A multi-sheet workbook becomes one dataset PER sheet — otherwise
      // every sheet but the first is silently invisible to the query engine.
      for (const parsed of parsedSheets) {
        const name = parsedSheets.length > 1 ? `${file.name} — ${parsed.sheetName}` : file.name;
        const id = "ds_" + Math.random().toString(36).substring(2);
        const record: DatasetRecord = {
          id,
          name,
          size: file.size,
          format: isXlsx ? "xlsx" : "csv",
          uploadedAt: new Date().toISOString(),
          rowCount: parsed.rowCount,
          columnCount: parsed.columns.length,
          columns: parsed.columns,
          blobUrl,
          rows: parsed.rows,
          sheetName: isXlsx ? parsed.sheetName : undefined,
          notes: parsed.notes,
        };
        newRecords.push(record);

        created.push({
          id,
          name: record.name,
          size: record.size,
          format: record.format,
          uploadedAt: new Date(record.uploadedAt),
          rowCount: record.rowCount,
          columnCount: record.columnCount,
          columns: record.columns,
          blobUrl: record.blobUrl,
          status: "ready",
          sheetName: record.sheetName,
          notes: record.notes,
        });
      }
    } catch {
      errors.push({ name: file.name, error: "Failed to parse file." });
    }
  }

  // The links are returned with the upload so the UI can tell the user how
  // the files fit together before any question is asked.
  let links: DatasetLink[] = [];
  if (newRecords.length > 0) {
    const session = await addDatasets(sessionId, newRecords, detectRelationships);
    links = session.relationships.map((r) => ({
      datasetIdA: r.datasetIdA, datasetIdB: r.datasetIdB, columnA: r.columnA, columnB: r.columnB, cardinality: r.cardinality,
    }));
  }

  return NextResponse.json({ datasets: created, errors, links }, { status: created.length > 0 ? 200 : 400 });
}
