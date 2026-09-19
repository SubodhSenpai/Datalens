"use client";

import { useState } from "react";
import {
  MessageSquare, FileCode2, Sparkles, ShieldCheck, GitMerge, ScanSearch,
  Cpu, FileTerminal, AlertTriangle, ChevronDown, ChevronRight, Copy, Check,
} from "lucide-react";
import { PipelineStep } from "@/lib/types";

interface PipelineTraceProps {
  steps: PipelineStep[];
}

const STEP_ICONS: Record<string, React.ReactNode> = {
  input:      <MessageSquare size={13} />,
  prompt:     <FileCode2 size={13} />,
  llm:        <Sparkles size={13} />,
  validate:   <ShieldCheck size={13} />,
  join:       <GitMerge size={13} />,
  revalidate: <ScanSearch size={13} />,
  guard:      <ShieldCheck size={13} />,
  execute:    <Cpu size={13} />,
  pandas:     <FileTerminal size={13} />,
  explain:    <Sparkles size={13} />,
  error:      <AlertTriangle size={13} />,
};

const STATUS_STYLES: Record<PipelineStep["status"], string> = {
  ok:      "bg-sage",
  warn:    "bg-mustard",
  skipped: "bg-bg-surface",
};

const DETAIL_LABELS: Record<string, string> = {
  input:      "Datasets in scope",
  prompt:     "Exact prompt sent",
  llm:        "Raw model response",
  validate:   "Schema checks",
  join:       "Join steps",
  revalidate: "Value-level checks",
  guard:      "Concept checks",
  execute:    "Operations that ran",
  pandas:     "Pandas code",
  explain:    "Summarization call",
  error:      "Stack trace",
};

// A free-tier model can take 60s+; "66596ms" is technically precise and
// practically unreadable.
function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  return `${mins}m ${Math.round((ms % 60000) / 1000)}s`;
}

// Shows the whole server-side sequence for one question — what was asked,
// the exact prompt sent, what the model returned verbatim, every
// deterministic correction applied to it, the joins, the executed plan, its
// pandas equivalent, and the summarization call. The point is that a wrong
// answer should be traceable to the stage that produced it, rather than
// having to trust the final number.
export default function PipelineTrace({ steps }: PipelineTraceProps) {
  const [openIds, setOpenIds] = useState<string[]>([]);

  const toggle = (id: string) =>
    setOpenIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <div className="flex flex-col gap-2">
      {steps.map((step, i) => {
        const isOpen = openIds.includes(step.id);
        const hasBody = Boolean(step.detail || step.payload);

        return (
          <div key={`${step.id}-${i}`} className="border-2 border-ink rounded-xl overflow-hidden bg-bg-card">
            <button
              id={`trace-step-${step.id}`}
              onClick={() => hasBody && toggle(step.id)}
              className={`w-full flex items-start gap-2.5 px-3 py-2.5 text-left ${hasBody ? "cursor-pointer" : "cursor-default"} ${STATUS_STYLES[step.status]}`}
            >
              <span className="w-5 h-5 rounded-full bg-bg-card border-2 border-ink flex items-center justify-center shrink-0 text-[10px] font-bold mt-0.5">
                {i + 1}
              </span>
              <span className="shrink-0 mt-1">{STEP_ICONS[step.id] ?? <Cpu size={13} />}</span>
              <span className="flex-1 min-w-0">
                <span className="block text-[13px] font-bold leading-tight">{step.label}</span>
                <span className="block text-[12px] font-medium text-text-secondary mt-0.5 break-words">{step.summary}</span>
                {(step.rowsIn !== undefined || step.ms !== undefined) && (
                  <span className="flex flex-wrap items-center gap-2 mt-1 text-[10px] font-bold uppercase tracking-wider text-text-secondary">
                    {step.rowsIn !== undefined && step.rowsOut !== undefined && (
                      <span>{step.rowsIn.toLocaleString()} → {step.rowsOut.toLocaleString()} rows</span>
                    )}
                    {step.ms !== undefined && <span>{formatMs(step.ms)}</span>}
                  </span>
                )}
              </span>
              {hasBody && (
                <span className="shrink-0 mt-1">
                  {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </span>
              )}
            </button>

            {isOpen && hasBody && (
              <div className="border-t-2 border-ink p-3 flex flex-col gap-2.5 animate-[fadeIn_0.15s_ease_forwards]">
                {step.detail && <CodeBlock text={step.detail} label={DETAIL_LABELS[step.id]} />}
                {step.payload !== undefined && step.payload !== null && (
                  <CodeBlock
                    text={JSON.stringify(step.payload, null, 2)}
                    label={step.payloadLabel ?? "JSON"}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CodeBlock({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — the text is still selectable by hand */ }
  };

  return (
    <div className="border-2 border-ink rounded-xl overflow-hidden bg-bg-surface">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b-2 border-ink bg-bg-card">
        <span className="text-[9px] font-bold uppercase tracking-widest text-text-secondary truncate">
          {label ?? "Detail"}
        </span>
        <button
          onClick={copy}
          className="shrink-0 px-1.5 py-0.5 border-2 border-ink rounded-lg hover:bg-mustard transition-colors"
          aria-label="Copy to clipboard"
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
        </button>
      </div>
      <pre className="overflow-auto max-h-[320px] p-3 text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-words">
        {text}
      </pre>
    </div>
  );
}
