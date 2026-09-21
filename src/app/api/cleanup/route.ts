import { NextRequest, NextResponse } from "next/server";
import { hasBlobStorage, listBlobs, deleteFiles } from "@/lib/blob";
import { groupBySession, expiredSessions } from "@/lib/cleanup";

export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_TTL_HOURS = 24;

/**
 * GET /api/cleanup — deletes every blob of sessions idle for longer than
 * SESSION_TTL_HOURS (default 24). Vercel Cron calls it once a day
 * (vercel.json) with `Authorization: Bearer $CRON_SECRET`; in production
 * nothing else may trigger it. `?dry=1` reports what would go without
 * deleting, for checking the TTL against a live store.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (process.env.NODE_ENV === "production" && (!secret || req.headers.get("authorization") !== `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasBlobStorage) return NextResponse.json({ ok: true, skipped: "no Blob storage configured; local sessions live in memory" });

  const ttlHours = Number(process.env.SESSION_TTL_HOURS) || DEFAULT_TTL_HOURS;
  const dryRun = req.nextUrl.searchParams.get("dry") === "1";

  const sessions = groupBySession(await listBlobs("sessions/"));
  const expired = expiredSessions(sessions, ttlHours);
  if (!dryRun) for (const s of expired) await deleteFiles(s.urls);

  return NextResponse.json({
    ok: true,
    dryRun,
    ttlHours,
    sessionsScanned: sessions.length,
    sessionsDeleted: expired.length,
    blobsDeleted: expired.reduce((n, s) => n + s.urls.length, 0),
    bytesFreed: expired.reduce((n, s) => n + s.bytes, 0),
  });
}
