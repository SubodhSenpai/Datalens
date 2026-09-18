"use client";

import { useState, useMemo } from "react";
import { BookOpen, ChevronDown, ChevronUp, Hash, Type, Calendar, ToggleLeft, HelpCircle } from "lucide-react";
import { DatasetFile, ColumnSchema } from "@/lib/types";
import { buildDataDictionary } from "@/lib/data-dictionary";

interface DataDictionaryPanelProps {
  datasets: DatasetFile[];
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

// Every column across every uploaded file, in one place — so you can see
// what the planner sees (the full vocabulary it has to answer with) instead
// of checking file-by-file, and spot at a glance which columns repeat
// across files (a likely join key) vs are unique to one.
export default function DataDictionaryPanel({ datasets }: DataDictionaryPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const entries = useMemo(() => buildDataDictionary(datasets), [datasets]);

  if (entries.length === 0) return null;

  return (
    <div className="p-4 border-b-2 border-ink">
      <button
        id="data-dictionary-toggle"
        onClick={() => setExpanded((p) => !p)}
        className="w-full flex items-center justify-between gap-2 text-left"
      >
        <span className="flex items-center gap-1.5 text-[11px] font-bold text-text-secondary uppercase tracking-widest">
          <BookOpen size={12} /> Data dictionary
        </span>
        <div className="flex items-center gap-1.5">
          <span className="badge badge-cyan text-[11px]">{entries.length} cols</span>
          {expanded ? <ChevronUp size={13} className="text-text-secondary" /> : <ChevronDown size={13} className="text-text-secondary" />}
        </div>
      </button>

      {expanded && (
        <div className="flex flex-col gap-0.5 mt-3 animate-[fadeIn_0.15s_ease_forwards] max-h-[280px] overflow-y-auto">
          {entries.map((e) => (
            <div key={`${e.column}::${e.type}`} className="flex items-start gap-2 py-1 px-1.5 rounded-lg hover:bg-bg-card transition-colors">
              <span className={`${TYPE_BADGE[e.type]} shrink-0 flex items-center mt-0.5`}>{TYPE_ICONS[e.type]}</span>
              <div className="flex-1 min-w-0">
                <span className="text-[11px] font-semibold block truncate">{e.column}</span>
                <span className="text-[10px] text-text-muted truncate block">
                  {e.files.length > 1 ? `in ${e.files.length} files: ` : ""}
                  {e.files.map((f) => f.datasetName).join(", ")}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
