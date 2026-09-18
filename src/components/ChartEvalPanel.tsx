"use client";

import { useState } from "react";
import { CheckCircle2, XCircle, ChevronDown, ChevronUp, ClipboardCheck } from "lucide-react";
import { QueryResult } from "@/lib/types";

interface ChartEvalPanelProps {
  queries: QueryResult[];
}

// Surfaces how often the LLM's chart tool-calling agrees with researched
// chart-selection guidance (src/lib/chart-eval/reference.ts) — not a claim
// that the LLM was "right" in some absolute sense, just whether its pick
// matches established guidance for this question/data shape. Only queries
// where a guidance rule actually applied are scored; everything else is
// left out of the tally rather than silently counted either way.
export default function ChartEvalPanel({ queries }: ChartEvalPanelProps) {
  const [expanded, setExpanded] = useState(false);

  const evaluated = queries.filter((q) => q.chartEval && q.chartEval.matched !== null);
  if (evaluated.length === 0) return null;

  const matched = evaluated.filter((q) => q.chartEval!.matched).length;
  const pct = Math.round((matched / evaluated.length) * 100);
  const isGood = pct >= 70;

  return (
    <div className="p-4 border-b-2 border-ink">
      <button
        id="chart-eval-toggle"
        onClick={() => setExpanded((p) => !p)}
        className="w-full flex items-center justify-between gap-2 text-left"
      >
        <span className="flex items-center gap-1.5 text-[11px] font-bold text-text-secondary uppercase tracking-widest">
          <ClipboardCheck size={12} /> Eval
        </span>
        <div className="flex items-center gap-1.5">
          <span className={`badge text-[11px] ${isGood ? "badge-emerald" : "badge-amber"}`}>
            {matched}/{evaluated.length}
          </span>
          {expanded ? <ChevronUp size={13} className="text-text-secondary" /> : <ChevronDown size={13} className="text-text-secondary" />}
        </div>
      </button>

      {expanded && (
        <div className="flex flex-col gap-1.5 mt-3 animate-[fadeIn_0.15s_ease_forwards]">
          {evaluated.slice(0, 20).map((q) => {
            const ev = q.chartEval!;
            return (
              <div
                key={q.id}
                className={`flex flex-col gap-1 px-2.5 py-2 rounded-xl border-2 border-ink text-[11px] ${
                  ev.matched ? "bg-sage/40" : "bg-mustard/40"
                }`}
                title={ev.rationale}
              >
                <div className="flex items-center gap-1.5">
                  {ev.matched ? (
                    <CheckCircle2 size={11} className="text-sage-dark shrink-0" />
                  ) : (
                    <XCircle size={11} className="text-mustard-dark shrink-0" />
                  )}
                  <span className="flex-1 font-semibold truncate">{q.question}</span>
                </div>
                <div className="flex items-center gap-1.5 pl-[17px] text-text-secondary font-medium">
                  <span>want: <span className="font-bold text-ink">{ev.expectedChartType}</span></span>
                  <span>·</span>
                  <span>got: <span className="font-bold text-ink">{ev.actualChartType}</span></span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
