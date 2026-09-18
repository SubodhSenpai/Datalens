import { NextRequest, NextResponse } from "next/server";
import { getSession, removeDataset } from "@/lib/session-store";
import { deleteFile } from "@/lib/blob";

export const runtime = "nodejs";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });

  const session = await getSession(sessionId);
  const dataset = session?.datasets.get(id);
  if (!session || !dataset) return NextResponse.json({ error: "Dataset not found" }, { status: 404 });

  await deleteFile(dataset.blobUrl);
  await removeDataset(sessionId, id);

  return NextResponse.json({ ok: true });
}
