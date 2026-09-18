"use client";

import { FileStack, HardDrive } from "lucide-react";
import { Session } from "@/lib/types";
import { formatBytes, getTotalSize } from "@/lib/utils";
import { MAX_FILES, MAX_SESSION_SIZE_MB } from "@/lib/types";

interface SessionBadgeProps { session: Session; }

export default function SessionBadge({ session }: SessionBadgeProps) {
  const totalSize    = getTotalSize(session.datasets);
  const maxSizeBytes = MAX_SESSION_SIZE_MB * 1024 * 1024;
  const usagePct     = Math.min((totalSize / maxSizeBytes) * 100, 100);
  const fileCount    = session.datasets.length;
  const isWarn       = usagePct > 80;

  return (
    <div className="px-4 py-3 border-b-2 border-ink flex flex-col gap-2">
      {/* Stats */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1 text-[11px] text-text-secondary font-bold">
          <FileStack size={11} />
          <span>{fileCount} / {MAX_FILES} files</span>
        </div>
        <div className="flex items-center gap-1 text-[11px] text-text-secondary font-bold">
          <HardDrive size={11} />
          <span>{formatBytes(totalSize)}</span>
        </div>
      </div>

      {/* Usage bar */}
      <div className="h-[6px] bg-bg-card border border-ink rounded-full overflow-hidden">
        <div
          className={`h-full transition-all duration-500 ${isWarn ? "bg-terracotta" : "bg-sage"}`}
          style={{ width: `${usagePct}%` }}
        />
      </div>
    </div>
  );
}
