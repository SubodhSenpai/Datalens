import { NextRequest, NextResponse } from "next/server";
import { DatasetFile, MAX_FILES, MAX_FILE_SIZE_MB, MAX_SESSION_SIZE_MB, SUPPORTED_FORMATS } from "@/lib/types";
import { parseCSVBuffer, parseXLSXBuffer } from "@/lib/parse";
import { uploadFile } from "@/lib/blob";
import { getOrCreateSession, getSessionTotalSize, addDatasets, DatasetRecord } from "@/lib/session-store";
import { detectRelationships } from "@/lib/relationships";

export const runtime = "nodejs";

/**
 * POST /api/upload
 *
 * multipart/form-data: sessionId (string) + files (one or more File entries).
 * Stores raw bytes in Blob, parses server-side into DataFrame-equivalent rows,
 * infers schema, and updates the session's dataset + relationship metadata.
 * Covers Figure 2 (Blob storage) and Figure 3 (Data Processing Module).
 */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const sessionId = form.get("sessionId");
  if (typeof sessionId !== "string" || !sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: "No files provided" }, { status: 400 });
  }

  const session = await getOrCreateSession(sessionId);

  if (session.datasets.size + files.length > MAX_FILES) {
    return NextResponse.json(
      { error: `Session limit is ${MAX_FILES} files (has ${session.datasets.size}, tried to add ${files.length}).` },
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
      const buffer = Buffer.from(await file.arrayBuffer());
      const isXlsx = ext === ".xlsx" || ext === ".xls";
      const parsedSheets = isXlsx ? parseXLSXBuffer(buffer) : [{ sheetName: "", ...parseCSVBuffer(buffer) }];

      if (parsedSheets.length === 0) {
        errors.push({ name: file.name, error: "No readable table found in this file." });
        continue;
      }

      const blobUrl = await uploadFile(
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
        });
      }
    } catch {
      errors.push({ name: file.name, error: "Failed to parse file." });
    }
  }

  if (newRecords.length > 0) {
    await addDatasets(sessionId, newRecords, detectRelationships);
  }

  return NextResponse.json({ datasets: created, errors }, { status: created.length > 0 ? 200 : 400 });
}
