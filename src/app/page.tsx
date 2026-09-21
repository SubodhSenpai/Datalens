"use client";

import { useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Upload, Database, BarChart3, FileSpreadsheet,
  ArrowRight, CheckCircle2, Sparkles,
} from "lucide-react";

const FEATURES = [
  { icon: <Upload size={22} />, title: "Drop files", bg: "bg-mint" },
  { icon: <Sparkles size={22} />, title: "Ask plainly", bg: "bg-mustard" },
  { icon: <BarChart3 size={22} />, title: "See charts", bg: "bg-sage" },
  { icon: <Database size={22} />, title: "Cross-file", bg: "bg-sky" },
];

export default function HomePage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);

  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); setIsDragging(true); }, []);
  const handleDragLeave = useCallback(() => setIsDragging(false), []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files).filter(
      f => f.name.endsWith(".csv") || f.name.endsWith(".xlsx") || f.name.endsWith(".xls")
    );
    if (files.length > 0) setSelectedFiles(files.slice(0, 10));
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) setSelectedFiles(files.slice(0, 10));
  }, []);

  return (
    <main className="relative z-10 min-h-screen">

      {/* ── NAV ── */}
      <nav className="sticky top-0 z-50 bg-bg-base/90 backdrop-blur-sm border-b-2 border-ink">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-mustard border-2 border-ink flex items-center justify-center">
              <Sparkles size={15} />
            </div>
            <span className="text-xl font-display font-bold tracking-tight">DataLens</span>
          </Link>
          <button id="nav-launch-btn" className="btn-primary text-sm" onClick={() => router.push("/dashboard")}>
            Launch <ArrowRight size={14} />
          </button>
        </div>
      </nav>

      {/* ── HERO ── */}
      <section className="px-6 pt-16 pb-20">
        <div className="max-w-3xl mx-auto text-center flex flex-col items-center gap-8 animate-[fadeIn_0.5s_ease_forwards]">

          <h1 className="font-display text-5xl md:text-6xl font-extrabold leading-[1.05] -rotate-1">
            Ask your files
            <br />
            <span className="inline-block bg-mustard px-4 py-1 rounded-2xl border-2 border-ink rotate-1 mt-2">anything.</span>
          </h1>

          {/* ── UPLOAD ZONE ── */}
          <div
            id="upload-zone"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`w-full max-w-lg border-2 border-dashed border-ink rounded-[28px] p-10 cursor-pointer transition-all duration-150
              ${isDragging ? "bg-sage translate-x-[-2px] translate-y-[-2px] shadow-hard" : selectedFiles.length > 0 ? "bg-sage/60 border-solid shadow-hard-sm" : "bg-mint shadow-hard-sm hover:translate-x-[-2px] hover:translate-y-[-2px] hover:shadow-hard"}`}
          >
            <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" multiple className="hidden" onChange={handleFileSelect} id="file-input" />

            {selectedFiles.length === 0 ? (
              <div className="flex flex-col items-center gap-3">
                <div className="w-14 h-14 rounded-full bg-bg-card border-2 border-ink flex items-center justify-center animate-[float_3s_ease-in-out_infinite]">
                  <FileSpreadsheet size={26} />
                </div>
                <strong className="font-display text-2xl">Drop files here</strong>
                <span className="badge badge-emerald">CSV / XLSX</span>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {selectedFiles.map((file, i) => (
                  <div key={i} className="flex items-center gap-2.5 px-3.5 py-2.5 bg-bg-card border-2 border-ink rounded-xl text-sm animate-[fadeIn_0.2s_ease_forwards]">
                    <CheckCircle2 size={15} className="text-sage-dark shrink-0" />
                    <span className="flex-1 truncate font-semibold">{file.name}</span>
                    <span className="text-xs text-text-secondary shrink-0">{(file.size / 1024 / 1024).toFixed(1)} MB</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <button id="continue-btn" className="btn-primary text-base px-8 py-3.5" onClick={() => router.push("/dashboard")}>
            {selectedFiles.length > 0 ? `Analyze ${selectedFiles.length} file${selectedFiles.length > 1 ? "s" : ""}` : "Start"}
            <ArrowRight size={18} />
          </button>
        </div>
      </section>

      {/* ── FEATURES — flat color blocks, icon + one word ── */}
      <section className="px-6 pb-24">
        <div className="max-w-3xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-4">
          {FEATURES.map((f, i) => (
            <div
              key={i}
              className={`${f.bg} glass-card p-5 flex flex-col items-center gap-2 text-center animate-[fadeIn_0.4s_ease_forwards]`}
              style={{ animationDelay: `${i * 60}ms` }}
            >
              {f.icon}
              <span className="font-display font-bold text-sm">{f.title}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer className="border-t-2 border-ink py-6 px-6">
        <div className="max-w-5xl mx-auto flex items-center justify-between text-xs text-text-secondary font-semibold">
          <span>DataLens</span>
        </div>
      </footer>
    </main>
  );
}
