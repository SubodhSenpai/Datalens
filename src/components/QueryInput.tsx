"use client";

import { useState, useRef, useMemo, KeyboardEvent } from "react";
import { Send, ChevronDown, Database, Sparkles } from "lucide-react";
import { DatasetFile } from "@/lib/types";

interface QueryInputProps {
  datasets: DatasetFile[];
  isQuerying: boolean;
  onQuery: (question: string, selectedIds: string[]) => void;
}

const EXAMPLE_QUESTIONS = [
  "Top 10 by value",
  "Summarize columns",
  "Average by category",
  "Trend over time",
];

export default function QueryInput({ datasets, isQuerying, onQuery }: QueryInputProps) {
  const [question, setQuestion]             = useState("");
  // Tracked as what the user has UNticked, not what's ticked. A ticked list
  // seeded on first render never learns about files uploaded afterwards, so
  // those sat silently out of scope: a question about a later upload was
  // answered from the earlier files only. Deriving the selection from the
  // live dataset list means a new file is in scope the moment it appears and
  // a removed one drops out on its own.
  const [deselectedIds, setDeselectedIds]   = useState<Set<string>>(() => new Set());
  const selectedIds = useMemo(
    () => datasets.filter(d => !deselectedIds.has(d.id)).map(d => d.id),
    [datasets, deselectedIds]
  );
  const [showDatasetPicker, setShowDatasetPicker] = useState(false);
  const [showExamples, setShowExamples]     = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = () => {
    const q = question.trim();
    if (!q || isQuerying || selectedIds.length === 0) return;
    onQuery(q, selectedIds);
    setQuestion("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setQuestion(e.target.value);
    const ta = e.target;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
  };

  const toggleDataset = (id: string) =>
    setDeselectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const canSubmit = question.trim().length > 0 && !isQuerying && selectedIds.length > 0;

  return (
    <div className="flex flex-col gap-2.5">
      {/* Top bar */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Dataset picker */}
        <div className="relative">
          <button
            id="dataset-picker-btn"
            onClick={() => setShowDatasetPicker(p => !p)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-bg-card border-2 border-ink rounded-full text-xs font-bold hover:bg-mint transition-all"
          >
            <Database size={12} />
            {selectedIds.length === datasets.length ? "All files" : `${selectedIds.length} file${selectedIds.length !== 1 ? "s" : ""}`}
            <ChevronDown size={11} className={`transition-transform duration-150 ${showDatasetPicker ? "rotate-180" : ""}`} />
          </button>

          {showDatasetPicker && (
            <div className="absolute top-[calc(100%+6px)] left-0 min-w-[220px] glass-card bg-bg-card overflow-hidden z-50 animate-[fadeInScale_0.12s_ease_forwards]">
              {datasets.map(ds => (
                <label key={ds.id} className="flex items-center gap-2.5 px-3.5 py-2.5 cursor-pointer hover:bg-mint transition-colors text-[13px] border-b-2 border-ink last:border-b-0">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(ds.id)}
                    onChange={() => toggleDataset(ds.id)}
                    className="accent-ink w-3.5 h-3.5 cursor-pointer shrink-0"
                    id={`ds-check-${ds.id}`}
                  />
                  <span className="flex-1 font-semibold truncate">{ds.name}</span>
                  <span className="text-[11px] text-text-secondary">{ds.columnCount} cols</span>
                </label>
              ))}
            </div>
          )}
        </div>

        <button
          id="examples-btn"
          className="btn-ghost text-xs px-2.5 py-1.5"
          onClick={() => setShowExamples(p => !p)}
        >
          <Sparkles size={11} /> Ideas
        </button>
      </div>

      {/* Example pills */}
      {showExamples && (
        <div className="flex flex-wrap gap-1.5 animate-[fadeIn_0.15s_ease_forwards]">
          {EXAMPLE_QUESTIONS.map((q, i) => (
            <button
              key={i}
              className="px-3 py-1.5 bg-bg-card border-2 border-ink rounded-full text-xs font-semibold hover:bg-mustard transition-all"
              onClick={() => { setQuestion(q); setShowExamples(false); textareaRef.current?.focus(); }}
            >
              {q}
            </button>
          ))}
        </div>
      )}

      {/* Input area */}
      <div className={`flex items-end gap-2.5 bg-bg-card border-2 border-ink rounded-[22px] px-4 py-3 transition-all duration-150
        ${canSubmit ? "shadow-hard-sm" : ""}`}
      >
        <textarea
          ref={textareaRef}
          id="query-textarea"
          className="flex-1 bg-transparent border-none outline-none text-sm resize-none font-sans leading-relaxed placeholder-text-muted min-h-6 max-h-40 overflow-y-auto disabled:opacity-60 disabled:cursor-not-allowed"
          placeholder="Ask your files anything…"
          value={question}
          onChange={handleTextareaChange}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={isQuerying}
        />
        <button
          id="query-send-btn"
          onClick={handleSubmit}
          disabled={!canSubmit}
          aria-label="Send query"
          className={`w-9 h-9 rounded-full border-2 border-ink flex items-center justify-center shrink-0 transition-all duration-150 disabled:cursor-not-allowed
            ${canSubmit ? "bg-mustard hover:translate-x-[-1px] hover:translate-y-[-1px] hover:shadow-hard-sm" : "bg-bg-surface opacity-50"}`}
        >
          {isQuerying ? <span className="spinner" style={{ width: 16, height: 16 }} /> : <Send size={15} />}
        </button>
      </div>

      {selectedIds.length === 0 && (
        <p className="text-xs font-semibold text-terracotta">Pick a file first.</p>
      )}
    </div>
  );
}
