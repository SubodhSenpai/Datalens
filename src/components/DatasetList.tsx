"use client";

import { useState } from "react";
import { FileSpreadsheet, ChevronDown, ChevronRight, X, Hash, Type, Calendar, ToggleLeft, HelpCircle, AlertTriangle, Info } from "lucide-react";
import { DatasetFile, DatasetLink, ColumnSchema } from "@/lib/types";
import { formatBytes } from "@/lib/utils";
import { summarizeDataset } from "@/lib/dataset-summary";

interface DatasetListProps {
  datasets: DatasetFile[];
  /** Links detected between files, so each card can say what it joins to. */
  links?: DatasetLink[];
  onRemove: (id: string) => void;
}

const TYPE_ICONS: Record<ColumnSchema["type"], React.ReactNode> = {
  number:  <Hash size={11} />,
  string:  <Type size={11} />,
  date:    <Calendar size={11} />,
  boolean: <ToggleLeft size={11} />,
  unknown: <HelpCircle size={11} />,
};

const TYPE_BADGE: Record<ColumnSchema["type"], string> = {
  number:  "text-sky",
  string:  "text-sage-dark",
  date:    "text-mustard-dark",
  boolean: "text-terracotta",
  unknown: "text-text-muted",
};

export default function DatasetList({ datasets, links = [], onRemove }: DatasetListProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-2">
      {datasets.map(ds => {
        const isExpanded = expandedId === ds.id;
        const summary = summarizeDataset(ds, datasets, links);
        return (
          <div key={ds.id} className="glass-card rounded-xl! overflow-hidden">
            {/* Header */}
            <div className="flex items-center gap-1.5 px-2.5 py-2">
              <button
                id={`dataset-toggle-${ds.id}`}
                className="flex-1 flex items-center gap-1.5 bg-transparent border-none cursor-pointer text-left min-w-0"
                onClick={() => setExpandedId(prev => prev === ds.id ? null : ds.id)}
              >
                {isExpanded
                  ? <ChevronDown size={13} className="text-text-secondary shrink-0" />
                  : <ChevronRight size={13} className="text-text-secondary shrink-0" />
                }
                <FileSpreadsheet size={13} className="text-sage-dark shrink-0" />
                <span className="text-xs font-bold truncate flex-1" title={ds.name}>{ds.name}</span>
              </button>
              <button
                id={`dataset-remove-${ds.id}`}
                onClick={() => onRemove(ds.id)}
                className="hover:bg-terracotta/30 p-0.5 rounded-full transition-all shrink-0"
                aria-label={`Remove ${ds.name}`}
              >
                <X size={13} />
              </button>
            </div>

            {/* Meta */}
            <div className="flex items-center flex-wrap gap-1.5 px-2.5 pb-2.5">
              <span className={`badge ${ds.format === "xlsx" ? "badge-emerald" : "badge-cyan"} text-[10px] px-1.5 py-0.5`}>
                {ds.format.toUpperCase()}
              </span>
              {ds.rowCount > 0 && <span className="text-[11px] text-text-secondary font-medium">{ds.rowCount.toLocaleString()} rows</span>}
              <span className="text-[11px] text-text-secondary font-medium">{ds.columnCount} cols</span>
              <span className="text-[11px] text-text-secondary font-medium">{formatBytes(ds.size)}</span>
            </div>

            {/* What this file holds — one line collapsed, so the user knows
                what answers will be drawn from without opening the card. */}
            {summary.headline && (
              <div className="px-2.5 pb-2 -mt-1 text-[10.5px] text-text-muted leading-snug" title={summary.facts.join(" | ")}>
                {summary.headline}
              </div>
            )}
            {summary.notes.length > 0 && !isExpanded && (
              <div className="px-2.5 pb-2 -mt-1 flex items-center gap-1 text-[10.5px] text-mustard-dark font-semibold">
                <AlertTriangle size={11} className="shrink-0" /> {summary.notes.length} adjustment{summary.notes.length > 1 ? "s" : ""} made on load
              </div>
            )}

            {/* Schema */}
            {isExpanded && (
              <div className="border-t-2 border-ink px-2.5 py-2.5 animate-[fadeIn_0.15s_ease_forwards] bg-bg-surface">
                <div className="mb-2.5 flex flex-col gap-1">
                  <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-text-secondary"><Info size={11} /> About this data</span>
                  {summary.facts.map((f, i) => (
                    <p key={i} className="text-[11px] leading-snug text-text-secondary break-words">{f}</p>
                  ))}
                  {summary.notes.map((n, i) => (
                    <p key={`n${i}`} className="text-[11px] leading-snug text-mustard-dark font-medium flex gap-1"><AlertTriangle size={11} className="shrink-0 mt-0.5" /><span>{n}</span></p>
                  ))}
                </div>
                <span className="block mb-1 text-[10px] font-bold uppercase tracking-widest text-text-secondary">Columns</span>
                <div className="flex flex-col gap-0.5">
                  {ds.columns.map(col => (
                    <div key={col.name} className="flex items-center gap-2 py-0.5">
                      <span className={`${TYPE_BADGE[col.type]} shrink-0 flex items-center`}>{TYPE_ICONS[col.type]}</span>
                      <span className="text-[11px] font-semibold flex-1 truncate">{col.name}</span>
                      {col.sample[0] && (
                        <span className="text-[10px] text-text-muted truncate max-w-[70px]" title={col.sample.join(", ")}>
                          {col.sample[0]}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
