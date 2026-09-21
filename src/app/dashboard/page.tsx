"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { Sparkles, Plus, ChevronRight } from "lucide-react";
import FileUpload from "@/components/FileUpload";
import DatasetList from "@/components/DatasetList";
import QueryInput from "@/components/QueryInput";
import ResultsPanel from "@/components/ResultsPanel";
import SessionBadge from "@/components/SessionBadge";
import ChartEvalPanel from "@/components/ChartEvalPanel";
import DataDictionaryPanel from "@/components/DataDictionaryPanel";
import ApiKeySettings, { loadStoredApiKey } from "@/components/ApiKeySettings";
import { DatasetFile, DatasetLink, QueryMode, QueryResult, Session } from "@/lib/types";
import { generateSessionId } from "@/lib/utils";

export default function DashboardPage() {
  const [session, setSession] = useState<Session | null>(() => ({
    id: generateSessionId(), createdAt: new Date(), datasets: [], totalSize: 0,
  }));
  const [queries, setQueries] = useState<QueryResult[]>([]);
  const [isQuerying, setIsQuerying] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [activeQueryId, setActiveQueryId] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState(() => loadStoredApiKey());

  const handleFilesUploaded = useCallback((newDatasets: DatasetFile[], links: DatasetLink[]) => {
    setSession(prev => {
      if (!prev) return prev;
      const combined = [...prev.datasets, ...newDatasets];
      // The server recomputes links over the whole session on each upload.
      return { ...prev, datasets: combined, links, totalSize: combined.reduce((a, d) => a + d.size, 0) };
    });
    setShowUpload(false);
  }, []);

  const handleRemoveDataset = useCallback((id: string) => {
    setSession(prev => {
      if (!prev) return prev;
      const datasets = prev.datasets.filter(d => d.id !== id);
      const links = (prev.links ?? []).filter(l => l.datasetIdA !== id && l.datasetIdB !== id);
      return { ...prev, datasets, links, totalSize: datasets.reduce((a, d) => a + d.size, 0) };
    });
    if (session) fetch(`/api/dataset/${id}?sessionId=${encodeURIComponent(session.id)}`, { method: "DELETE" });
  }, [session]);

  const handleQuery = useCallback(async (question: string, selectedIds: string[], mode: QueryMode = "deterministic") => {
    if (!session) return;
    const queryId = "q_" + Date.now().toString(36);
    const newQuery: QueryResult = { id: queryId, question, timestamp: new Date(), status: "running", mode };
    setQueries(prev => [newQuery, ...prev]);
    setActiveQueryId(queryId);
    setIsQuerying(true);
    try {
      const res = await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, question, datasetIds: selectedIds, apiKey: apiKey || undefined, mode }),
      });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data = await res.json();
      setQueries(prev => prev.map(q => q.id === queryId ? { ...q, ...data.result } : q));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setQueries(prev => prev.map(q => q.id === queryId ? { ...q, status: "error", errorMessage: msg } : q));
    } finally {
      setIsQuerying(false);
    }
  }, [session, apiKey]);

  const hasDatasets = (session?.datasets.length ?? 0) > 0;

  return (
    <div className="flex h-screen overflow-hidden relative z-10">

      {/* ── SIDEBAR ── */}
      <aside className="w-[280px] shrink-0 bg-bg-surface border-r-2 border-ink flex flex-col overflow-y-auto overflow-x-hidden">

        {/* Logo */}
        <div className="px-5 h-16 flex items-center border-b-2 border-ink shrink-0">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-mustard border-2 border-ink flex items-center justify-center">
              <Sparkles size={13} />
            </div>
            <span className="text-lg font-display font-bold tracking-tight">DataLens</span>
          </Link>
        </div>

        {/* Bring-your-own API key */}
        <ApiKeySettings value={apiKey} onChange={setApiKey} />

        {/* Session Badge */}
        {session && <SessionBadge session={session} />}

        {/* Datasets section */}
        <div className="p-4 border-b-2 border-ink">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] font-bold text-text-secondary uppercase tracking-widest">Files</span>
            <button id="add-dataset-btn" className="btn-ghost text-xs px-2 py-1" onClick={() => setShowUpload(true)}>
              <Plus size={13} /> Add
            </button>
          </div>
          {hasDatasets ? (
            <DatasetList datasets={session!.datasets} links={session!.links ?? []} onRemove={handleRemoveDataset} />
          ) : (
            <div className="px-4 py-5 text-center text-[13px] text-text-secondary bg-bg-card border-2 border-dashed border-ink rounded-xl leading-relaxed">
              Nothing yet.
            </div>
          )}
        </div>

        {/* Cross-file column dictionary */}
        {hasDatasets && <DataDictionaryPanel datasets={session!.datasets} />}

        {/* Chart tool-calling eval */}
        <ChartEvalPanel queries={queries} />

        {/* Query History */}
        {queries.length > 0 && (
          <div className="p-4">
            <span className="text-[11px] font-bold text-text-secondary uppercase tracking-widest block mb-3">History</span>
            <div className="flex flex-col gap-1.5">
              {queries.map(q => (
                <button
                  key={q.id}
                  onClick={() => setActiveQueryId(q.id)}
                  className={`flex items-center gap-1.5 px-2.5 py-2 rounded-xl text-left w-full transition-all border-2
                    ${activeQueryId === q.id
                      ? "bg-mint border-ink"
                      : "bg-transparent border-transparent hover:border-ink hover:bg-bg-card"
                    }`}
                >
                  <ChevronRight size={11} className="text-text-secondary shrink-0" />
                  <span className="flex-1 text-xs font-medium truncate">{q.question}</span>
                  <span className={`w-2 h-2 rounded-full shrink-0 border border-ink ${
                    q.status === "success" ? "bg-sage" :
                    q.status === "error"   ? "bg-terracotta" :
                    "bg-mustard animate-pulse"
                  }`} />
                </button>
              ))}
            </div>
          </div>
        )}
      </aside>

      {/* ── MAIN ── */}
      <main className="flex-1 flex flex-col overflow-hidden relative">

        {/* Upload Modal */}
        {showUpload && (
          <div
            className="fixed inset-0 bg-ink/40 z-50 flex items-center justify-center animate-[fadeIn_0.15s_ease_forwards]"
            onClick={() => setShowUpload(false)}
          >
            <div
              className="glass-card bg-bg-card p-8 w-full max-w-lg mx-6 animate-[fadeInScale_0.2s_ease_forwards]"
              onClick={e => e.stopPropagation()}
            >
              <h2 className="text-2xl font-display font-bold mb-6">Add files</h2>
              <FileUpload
                sessionId={session?.id ?? ""}
                existingCount={session?.datasets.length ?? 0}
                existingSize={session?.totalSize ?? 0}
                onUploaded={handleFilesUploaded}
                onCancel={() => setShowUpload(false)}
              />
            </div>
          </div>
        )}

        {!hasDatasets && !showUpload ? (
          /* Empty state */
          <div className="flex-1 flex items-center justify-center px-6 overflow-y-auto">
            <div className="text-center max-w-lg flex flex-col items-center gap-5 animate-[fadeIn_0.4s_ease_forwards]">
              <div className="w-20 h-20 rounded-full bg-mustard border-2 border-ink flex items-center justify-center animate-[wiggle_3s_ease-in-out_infinite]">
                <Sparkles size={36} />
              </div>
              <h1 className="text-3xl font-display font-bold tracking-tight">Start with a file</h1>
              <FileUpload
                sessionId={session?.id ?? ""}
                existingCount={0}
                existingSize={0}
                onUploaded={handleFilesUploaded}
                onCancel={() => {}}
                inline
              />
            </div>
          </div>
        ) : (
          /* Analysis view */
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="px-6 py-4 border-b-2 border-ink bg-bg-surface shrink-0">
              <QueryInput datasets={session?.datasets ?? []} isQuerying={isQuerying} onQuery={handleQuery} />
            </div>
            <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-5">
              {queries.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-text-secondary text-sm font-medium">
                  Ask something above.
                </div>
              ) : (
                queries.map(q => (
                  <ResultsPanel
                    key={q.id}
                    result={q}
                    isActive={activeQueryId === q.id}
                    onClick={() => setActiveQueryId(q.id)}
                    onFollowUp={question => handleQuery(question, session?.datasets.map(d => d.id) ?? [])}
                  />
                ))
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
