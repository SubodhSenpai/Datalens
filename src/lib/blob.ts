import { put, del, get, BlobPreconditionFailedError } from "@vercel/blob";

// Falls back to an in-memory store when BLOB_READ_WRITE_TOKEN isn't configured
// (e.g. local dev without `vercel env pull`), so upload/query still work end
// to end without requiring Blob credentials up front. On Vercel with the
// token set, this transparently uses real Blob storage per Figure 2.

const hasBlobToken = !!process.env.BLOB_READ_WRITE_TOKEN;

const localBlobs = new Map<string, Buffer>();

// Cheap content-hash etag for the local fallback, so callers doing
// conditional reads/writes (ifNoneMatch / ifMatch) see the same semantics
// locally as they would against real Blob storage.
function localEtag(buffer: Buffer): string {
  let hash = 0;
  for (let i = 0; i < buffer.length; i++) hash = (hash * 31 + buffer[i]) | 0;
  return `local-${buffer.length}-${hash}`;
}

export class BlobConflictError extends Error {
  constructor() {
    super("Blob write conflict: the stored ETag no longer matches.");
    this.name = "BlobConflictError";
  }
}

export async function uploadFile(pathname: string, buffer: Buffer, contentType: string): Promise<string> {
  if (hasBlobToken) {
    // "private" — this stores user-uploaded data files; a public blob has a
    // guessable/shareable URL that would let anyone with it read the raw
    // file, bypassing the session entirely. All reads happen server-side
    // (this app never fetches a blob URL directly from the browser), so
    // private access costs nothing functionally.
    const blob = await put(pathname, buffer, { access: "private", contentType, addRandomSuffix: true });
    return blob.url;
  }
  const url = `local://${pathname}`;
  localBlobs.set(url, buffer);
  return url;
}

export async function deleteFile(url: string): Promise<void> {
  if (url.startsWith("local://")) {
    localBlobs.delete(url);
    return;
  }
  if (hasBlobToken) {
    await del(url);
  }
}

export function getLocalBlob(url: string): Buffer | undefined {
  return localBlobs.get(url);
}

// Fetches raw bytes for a dataset's blobUrl (returned by uploadFile above),
// used to re-parse rows after a cold start when they aren't cached in
// memory. Accepts a full URL (local:// or a real Blob URL).
export async function getBlobBuffer(urlOrPathname: string): Promise<Buffer | null> {
  if (urlOrPathname.startsWith("local://")) {
    return localBlobs.get(urlOrPathname) ?? null;
  }
  if (!hasBlobToken) return null;
  const result = await get(urlOrPathname, { access: "private" });
  if (!result || result.statusCode !== 200) return null;
  const arrayBuffer = await new Response(result.stream).arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export interface BlobJsonResult<T> {
  data: T;
  etag: string;
}

// Writes small JSON documents (e.g. session metadata) at a STABLE pathname
// (no random suffix), so repeated writes overwrite the same object instead
// of accumulating. When `etag` is given, the write is a compare-and-swap:
// it only succeeds if nothing else has written to this pathname since that
// etag was read, and throws BlobConflictError otherwise — callers should
// re-fetch, re-apply their mutation, and retry.
export async function saveBlobJson(pathname: string, data: unknown, opts?: { etag?: string }): Promise<string> {
  const buffer = Buffer.from(JSON.stringify(data));

  if (hasBlobToken) {
    try {
      const blob = await put(pathname, buffer, {
        access: "private",
        contentType: "application/json",
        addRandomSuffix: false,
        // allowOverwrite must be true any time we're writing to a STABLE
        // pathname a second time, whether or not this particular write is
        // conditional — the SDK now rejects allowOverwrite:false paired
        // with ifMatch as contradictory (ifMatch's job is deciding WHETHER
        // the overwrite proceeds, not whether overwriting is allowed at all).
        allowOverwrite: true,
        ifMatch: opts?.etag,
      });
      return blob.etag;
    } catch (err) {
      if (err instanceof BlobPreconditionFailedError) throw new BlobConflictError();
      throw err;
    }
  }

  const url = `local://${pathname}`;
  if (opts?.etag) {
    const existing = localBlobs.get(url);
    if (!existing || localEtag(existing) !== opts.etag) throw new BlobConflictError();
  }
  localBlobs.set(url, buffer);
  return localEtag(buffer);
}

// Reads a JSON document written by saveBlobJson. Pass `ifNoneMatch` with a
// previously-seen etag to get "not-modified" back (cheap) instead of
// re-fetching + re-parsing unchanged data.
export async function getBlobJson<T>(
  pathname: string,
  opts?: { ifNoneMatch?: string }
): Promise<BlobJsonResult<T> | "not-modified" | null> {
  if (hasBlobToken) {
    const result = await get(pathname, { access: "private", ifNoneMatch: opts?.ifNoneMatch });
    if (!result) return null;
    if (result.statusCode === 304) return "not-modified";
    const text = await new Response(result.stream).text();
    return { data: JSON.parse(text) as T, etag: result.blob.etag };
  }

  const url = `local://${pathname}`;
  const existing = localBlobs.get(url);
  if (!existing) return null;
  const etag = localEtag(existing);
  if (opts?.ifNoneMatch && opts.ifNoneMatch === etag) return "not-modified";
  return { data: JSON.parse(existing.toString("utf-8")) as T, etag };
}

export async function deleteBlobPath(pathname: string): Promise<void> {
  const url = `local://${pathname}`;
  if (localBlobs.has(url)) {
    localBlobs.delete(url);
    return;
  }
  if (hasBlobToken) {
    await del(pathname);
  }
}
