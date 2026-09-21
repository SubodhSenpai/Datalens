"use client";

import { useState } from "react";
import {
  Clock, AlertCircle, Loader2, BarChart3, Table2,
  MessageSquare, ChevronDown, ChevronUp, RefreshCw, Sparkles,
  CheckCircle2, XCircle, FileSearch, FileText, GitMerge, Filter,
  Layers, Sigma, ArrowUpDown, Workflow,
} from "lucide-react";
import { QueryResult } from "@/lib/types";
import DataTable from "./DataTable";
import ChartView from "./ChartView";
import PipelineTrace from "./PipelineTrace";

interface ResultsPanelProps {
  result: QueryResult;
  isActive: boolean;
  onClick: () => void;
  onFollowUp: (question: string) => void;
}

type Tab = "table" | "chart" | "explanation" | "source" | "trace";

export default function ResultsPanel({ result, isActive, onClick, onFollowUp }: ResultsPanelProps) {
  const [activeTab, setActiveTab]     = useState<Tab>("table");
  const [isCollapsed, setIsCollapsed] = useState(false);

  const hasTable       = (result.tableData?.length ?? 0) > 0;
  const hasChart       = result.chartData && result.chartData.length > 0 && result.chartType !== "none";
  const hasExplanation = !!result.explanation;
  const hasSource      = !!result.source;
  const hasTrace       = (result.trace?.length ?? 0) > 0;

  const tabs: { key: Tab; label: string; icon: React.ReactNode; show: boolean }[] = [
    { key: "table",       label: "Table",   icon: <Table2 size={13} />,      show: hasTable },
    { key: "chart",       label: "Chart",   icon: <BarChart3 size={13} />,   show: !!hasChart },
    { key: "explanation", label: "Explain", icon: <MessageSquare size={13} />, show: hasExplanation },
    { key: "source",      label: "Source",  icon: <FileSearch size={13} />,  show: hasSource },
    { key: "trace",       label: "Steps",   icon: <Workflow size={13} />,    show: hasTrace },
  ];
  const visibleTabs = tabs.filter(t => t.show);

  const timestamp = new Date(result.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <div
      id={`result-${result.id}`}
      onClick={onClick}
      className={`glass-card cursor-pointer transition-all duration-150 ${isActive ? "bg-mint!" : "bg-bg-card"}`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-4 px-5 py-4 border-b-2 border-ink">
        <div className="flex items-start gap-2.5 flex-1 min-w-0">
          <div className="w-7 h-7 rounded-full bg-mustard border-2 border-ink flex items-center justify-center shrink-0 mt-0.5">
            <MessageSquare size={13} />
          </div>
          <p className="text-sm font-bold leading-snug flex-1">{result.question}</p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="flex items-center gap-1 text-[11px] text-text-secondary font-medium">
            <Clock size={10} /> {timestamp}
          </span>

          {result.status === "running" && (
            <span className="badge badge-amber text-[11px]">
              <Loader2 size={10} className="animate-spin" /> Running
            </span>
          )}
          {result.mode === "rag" && (
            <span
              className="badge badge-amber text-[11px]"
              title={`Answered by the model from retrieved rows and column statistics — not computed by the query engine.${result.confidence ? ` Model confidence: ${result.confidence}.` : ""}`}
            >
              RAG · unverified{result.confidence ? ` · ${result.confidence}` : ""}
            </span>
          )}
          {result.status === "success" && <span className="badge badge-emerald text-[11px]">Done</span>}
          {result.status === "error"   && <span className="badge badge-red text-[11px]">Error</span>}

          <button
            id={`collapse-${result.id}`}
            className="btn-ghost px-1.5 py-1"
            onClick={e => { e.stopPropagation(); setIsCollapsed(p => !p); }}
          >
            {isCollapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
          </button>
        </div>
      </div>

      {/* Body */}
      {!isCollapsed && (
        <div className="animate-[fadeIn_0.2s_ease_forwards]">

          {/* Running skeleton */}
          {result.status === "running" && (
            <div className="px-5 py-8 flex flex-col items-center gap-4">
              <span className="spinner" style={{ width: 24, height: 24 }} />
              <p className="text-sm text-text-secondary font-medium">Thinking…</p>
              <div className="w-full flex flex-col gap-2">
                {[85, 70, 90].map((w, i) => (
                  <div key={i} className="skeleton h-3" style={{ width: `${w}%`, animationDelay: `${i * 0.15}s` }} />
                ))}
              </div>
            </div>
          )}

          {/* Error */}
          {result.status === "error" && (
            <>
              <div className="flex items-start gap-3 px-5 py-5 bg-terracotta/20 border-t-2 border-ink">
                <AlertCircle size={18} className="shrink-0 mt-0.5" />
                <div>
                  <strong className="block text-sm mb-1">Something went wrong</strong>
                  <p className="text-[13px] text-text-secondary font-medium">{result.errorMessage}</p>
                </div>
              </div>
              {/* However far it got still tells you where it broke. */}
              {hasTrace && (
                <div className="px-5 py-4 border-t-2 border-ink">
                  <PipelineTrace steps={result.trace!} />
                </div>
              )}
            </>
          )}

          {/* Success */}
          {result.status === "success" && (
            <>
              {/* Tabs */}
              {visibleTabs.length > 1 && (
                <div className="flex gap-0.5 px-5 pt-3 border-b-2 border-ink">
                  {visibleTabs.map(tab => (
                    <button
                      key={tab.key}
                      id={`tab-${result.id}-${tab.key}`}
                      onClick={e => { e.stopPropagation(); setActiveTab(tab.key); }}
                      className={`flex items-center gap-1.5 px-3.5 py-2 text-[13px] font-bold border-b-[3px] -mb-0.5 transition-all
                        ${activeTab === tab.key
                          ? "border-ink"
                          : "text-text-secondary border-transparent hover:text-ink"}`}
                    >
                      {tab.icon} {tab.label}
                    </button>
                  ))}
                </div>
              )}

              {/* Tab content */}
              <div className="px-5 py-4">
                {activeTab === "table" && hasTable && (
                  <DataTable data={result.tableData!} columns={result.columns ?? Object.keys(result.tableData![0])} />
                )}
                {activeTab === "chart" && hasChart && (
                  <div className="flex flex-col gap-3">
                    <ChartView type={result.chartType!} data={result.chartData!} config={result.chartConfig} />
                    {result.chartEval && result.chartEval.matched !== null && (
                      <div
                        className={`flex items-start gap-2 px-3 py-2 rounded-xl border-2 border-ink text-[12px] font-medium ${
                          result.chartEval.matched ? "bg-sage/40" : "bg-mustard/40"
                        }`}
                      >
                        {result.chartEval.matched ? (
                          <CheckCircle2 size={13} className="shrink-0 mt-0.5 text-sage-dark" />
                        ) : (
                          <XCircle size={13} className="shrink-0 mt-0.5 text-mustard-dark" />
                        )}
                        <span>
                          {result.chartEval.matched
                            ? `"${result.chartEval.actualChartType}" matches guidance.`
                            : `Guidance suggests "${result.chartEval.expectedChartType}"; used "${result.chartEval.actualChartType}".`}
                        </span>
                      </div>
                    )}
                  </div>
                )}
                {activeTab === "explanation" && hasExplanation && (
                  <div className="flex gap-3 p-4 bg-sky/30 border-2 border-ink rounded-xl">
                    <Sparkles size={15} className="shrink-0 mt-0.5" />
                    <p className="text-sm font-medium leading-relaxed">{result.explanation}</p>
                  </div>
                )}
                {activeTab === "source" && hasSource && (
                  <div className="flex flex-col gap-2.5">
                    <SourceRow icon={<FileText size={13} />} label="Files" items={result.source!.files} />
                    {result.source!.joins.length > 0 && (
                      <SourceRow icon={<GitMerge size={13} />} label="Joins" items={result.source!.joins} />
                    )}
                    {result.source!.derived.length > 0 && (
                      <SourceRow icon={<Sigma size={13} />} label="Computed cols" items={result.source!.derived} />
                    )}
                    {result.source!.filters.length > 0 && (
                      <SourceRow icon={<Filter size={13} />} label="Filters" items={result.source!.filters} />
                    )}
                    {result.source!.groupBy.length > 0 && (
                      <SourceRow icon={<Layers size={13} />} label="Grouped by" items={result.source!.groupBy} />
                    )}
                    {result.source!.aggregations.length > 0 && (
                      <SourceRow icon={<Sigma size={13} />} label="Computed" items={result.source!.aggregations} />
                    )}
                    {result.source!.sort && (
                      <SourceRow icon={<ArrowUpDown size={13} />} label="Sorted by" items={[`${result.source!.sort}${result.source!.limit ? `, top ${result.source!.limit}` : ""}`]} />
                    )}
                    <div className="text-[11px] text-text-secondary font-semibold pt-1">
                      {result.source!.rowsConsidered.toLocaleString()} rows considered → {result.source!.rowsReturned.toLocaleString()} returned
                    </div>
                  </div>
                )}
                {activeTab === "trace" && hasTrace && (
                  <div className="flex flex-col gap-3">
                    <p className="text-[12px] font-medium text-text-secondary leading-relaxed">
                      Everything the server did for this question, in order. Click any step to see the exact
                      prompt, the model&apos;s raw reply, or the operations that ran.
                    </p>
                    <PipelineTrace steps={result.trace!} />
                  </div>
                )}
                {!hasTable && !hasChart && !hasExplanation && !hasSource && !hasTrace && (
                  <div className="text-center py-8 text-text-secondary text-sm font-medium">
                    No results. Try rephrasing.
                  </div>
                )}
              </div>

              {/* Follow-up suggestions */}
              {result.followUpSuggestions && result.followUpSuggestions.length > 0 && (
                <div className="border-t-2 border-ink px-5 py-3.5">
                  <p className="flex items-center gap-1.5 text-[11px] font-bold text-text-secondary uppercase tracking-widest mb-2.5">
                    <RefreshCw size={10} /> Next
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {result.followUpSuggestions.map((q, i) => (
                      <button
                        key={i}
                        id={`followup-${result.id}-${i}`}
                        onClick={e => { e.stopPropagation(); onFollowUp(q); }}
                        className="px-3 py-1.5 bg-bg-card border-2 border-ink rounded-full text-xs font-semibold hover:bg-mustard transition-all"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SourceRow({ icon, label, items }: { icon: React.ReactNode; label: string; items: string[] }) {
  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5 bg-bg-surface border-2 border-ink rounded-xl">
      <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-text-secondary shrink-0 w-24 pt-0.5">
        {icon} {label}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {items.map((it, i) => (
          <span key={i} className="px-2 py-0.5 bg-bg-card border border-ink/30 rounded-full text-[12px] font-mono font-semibold">
            {it}
          </span>
        ))}
      </div>
    </div>
  );
}
