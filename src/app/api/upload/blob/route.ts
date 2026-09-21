import { NextRequest, NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { MAX_FILE_SIZE_MB, SUPPORTED_FORMATS } from "@/lib/types";

export const runtime = "nodejs";

/**
 * POST /api/upload/blob — issues short-lived client tokens so the browser
 * can upload a file STRAIGHT to Vercel Blob.
 *
 * Why: a serverless function only accepts ~4.5 MB of request body, so a
 * 7 MB workbook posted to /api/upload is rejected with 413 before any code
 * runs. With a client upload the bytes never pass through a function; the
 * server later reads the stored blob to parse it. The token is scoped to
 * one pathname under the caller's session, to the supported extensions and
 * to the size limit, and expires in a minute.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as HandleUploadBody;
  try {
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const payload = clientPayload ? (JSON.parse(clientPayload) as { sessionId?: string }) : {};
        const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
        if (!sessionId || !pathname.startsWith(`sessions/${sessionId}/`)) throw new Error("Upload path does not belong to the session.");
        const ext = "." + pathname.split(".").pop()?.toLowerCase();
        if (!SUPPORTED_FORMATS.includes(ext)) throw new Error("Unsupported format. Use CSV or XLSX.");
        return {
          allowedContentTypes: ["text/csv", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/octet-stream"],
          maximumSizeInBytes: MAX_FILE_SIZE_MB * 1024 * 1024,
          addRandomSuffix: true,
          validUntil: Date.now() + 60_000,
          tokenPayload: JSON.stringify({ sessionId }),
        };
      },
      // Nothing to do on completion: the browser posts the stored URLs to
      // /api/upload, which parses and registers them in the session.
      onUploadCompleted: async () => {},
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not authorise the upload." }, { status: 400 });
  }
}
