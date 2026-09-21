import type { StoredBlob } from "./blob";

// Sessions have no owner and no logout: a closed or refreshed tab leaves its
// files in Blob for good. Everything a session writes lives under
// sessions/<id>/, and every upload or removal rewrites metadata.json there,
// so the newest uploadedAt in the folder is the session's last activity.
// (Questions don't write, so a tab that only asks for longer than the TTL
// loses its files too — the same 2 h rule the session store already applies.)

export interface SessionUsage { id: string; urls: string[]; bytes: number; lastWrite: number }

export function groupBySession(blobs: StoredBlob[]): SessionUsage[] {
  const byId = new Map<string, SessionUsage>();
  for (const b of blobs) {
    const [root, id] = b.pathname.split("/");
    if (root !== "sessions" || !id) continue;
    const s = byId.get(id) ?? { id, urls: [], bytes: 0, lastWrite: 0 };
    s.urls.push(b.url);
    s.bytes += b.size;
    s.lastWrite = Math.max(s.lastWrite, b.uploadedAt.getTime());
    byId.set(id, s);
  }
  return [...byId.values()];
}

export function expiredSessions(sessions: SessionUsage[], ttlHours: number, now = Date.now()): SessionUsage[] {
  const cutoff = now - ttlHours * 3_600_000;
  return sessions.filter((s) => s.lastWrite < cutoff);
}
