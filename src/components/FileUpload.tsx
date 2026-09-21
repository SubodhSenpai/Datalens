"use client";

import { useState, useCallback, useRef } from "react";
import { Upload, FileSpreadsheet, X, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { DatasetFile, DatasetLink } from "@/lib/types";
import { validateFile, formatBytes } from "@/lib/utils";
import { MAX_FILES, MAX_SESSION_SIZE_MB } from "@/lib/types";

interface FileUploadProps {
  sessionId: string;
  existingCount: number;
  existingSize: number;
  onUploaded: (datasets: DatasetFile[], links: DatasetLink[]) => void;
  onCancel: () => void;
  inline?: boolean;
}

interface PendingFile {
  file: File;
  id: string;
  status: "pending" | "ready" | "error";
  error?: string;
}

export default function FileUpload({ sessionId, existingCount, existingSize, onUploaded, onCancel, inline = false }: FileUploadProps) {
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const maxAdditional = MAX_FILES - existingCount;

  const processFiles = useCallback((files: File[]) => {
    const toAdd = files.slice(0, maxAdditional);
    const pending: PendingFile[] = toAdd.map((f) => {
      const validation = validateFile(f);
      return {
        file: f,
        id: "pf_" + Math.random().toString(36).substring(2),
        status: validation.valid ? "ready" : "error",
        error: validation.error,
      };
    });
    setPendingFiles((prev) => [...prev, ...pending]);
  }, [maxAdditional]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false);
    const files = Array.from(e.dataTransfer.files).filter(f => f.name.match(/\.(csv|xlsx|xls)$/i));
    processFiles(files);
  }, [processFiles]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    processFiles(Array.from(e.target.files || [])); e.target.value = "";
  }, [processFiles]);

  const handleConfirm = async () => {
    const ready = pendingFiles.filter((p) => p.status === "ready");
    if (ready.length === 0) return;

    const readySize = ready.reduce((acc, p) => acc + p.file.size, 0);
    if (existingSize + readySize > MAX_SESSION_SIZE_MB * 1024 * 1024) {
      setSubmitError(`Session size limit is ${MAX_SESSION_SIZE_MB}MB.`);
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const form = new FormData();
      form.set("sessionId", sessionId);
      ready.forEach((p) => form.append("files", p.file));

      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = await res.json();

      if (!res.ok) {
        setSubmitError(data.error ?? `Upload failed (${res.status}).`);
        return;
      }

      const uploaded: DatasetFile[] = (data.datasets ?? []).map((d: DatasetFile) => ({
        ...d, uploadedAt: new Date(d.uploadedAt),
      }));

      if (data.errors?.length) {
        const errorMap = new Map<string, string>(data.errors.map((e: { name: string; error: string }) => [e.name, e.error]));
        setPendingFiles((prev) => prev.map((p) => errorMap.has(p.file.name) ? { ...p, status: "error", error: errorMap.get(p.file.name) } : p));
      } else {
        setPendingFiles([]);
      }

      if (uploaded.length > 0) onUploaded(uploaded, (data.links ?? []) as DatasetLink[]);
    } catch {
      setSubmitError("Upload failed. Check your connection and try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const readyCount = pendingFiles.filter(p => p.status === "ready").length;
  const hasError   = pendingFiles.some(p => p.status === "error");

  return (
    <div className="flex flex-col gap-3.5 w-full">
      {/* Drop zone */}
      <div
        id="file-drop-zone"
        onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`flex items-center gap-4 px-6 py-7 border-2 border-dashed border-ink rounded-[24px] cursor-pointer transition-all duration-150
          ${isDragging ? "bg-sage translate-x-[-2px] translate-y-[-2px] shadow-hard"
                       : "bg-mint shadow-hard-sm hover:translate-x-[-2px] hover:translate-y-[-2px] hover:shadow-hard"}`}
      >
        <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" multiple className="hidden" onChange={handleFileSelect} />
        <div className="w-11 h-11 rounded-full bg-bg-card border-2 border-ink flex items-center justify-center shrink-0">
          <Upload size={20} />
        </div>
        <div className="flex flex-col gap-0.5">
          <strong className="font-display text-lg font-bold">Drop files</strong>
          <span className="badge badge-emerald w-fit">CSV / XLSX</span>
        </div>
      </div>

      {/* File queue */}
      {pendingFiles.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {pendingFiles.map(pf => (
            <div
              key={pf.id}
              className={`flex items-center gap-2.5 px-3 py-2.5 rounded-full border-2 border-ink text-[13px] animate-[fadeIn_0.2s_ease_forwards]
                ${pf.status === "ready" ? "bg-mint" : pf.status === "error" ? "bg-terracotta/30" : "bg-bg-card"}`}
            >
              <FileSpreadsheet size={15} className="shrink-0" />
              <span className="flex-1 truncate font-semibold">{pf.file.name}</span>
              <span className="text-xs text-text-secondary shrink-0">{formatBytes(pf.file.size)}</span>
              <div className="w-4 flex items-center justify-center shrink-0">
                {isSubmitting && pf.status === "ready" && <Loader2 size={13} className="animate-spin" />}
                {!isSubmitting && pf.status === "ready" && <CheckCircle2 size={13} className="text-sage-dark" />}
                {pf.status === "error"      && <span title={pf.error}><AlertCircle size={13} className="text-terracotta" /></span>}
              </div>
              <button
                onClick={() => setPendingFiles(prev => prev.filter(p => p.id !== pf.id))}
                className="hover:bg-ink hover:text-bg-base p-0.5 rounded-full transition-all"
                aria-label="Remove"
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {hasError && (
        <div className="flex items-center gap-2 text-xs font-medium px-3 py-2 bg-terracotta/25 border-2 border-ink rounded-xl">
          <AlertCircle size={13} /> Some files failed.
        </div>
      )}

      {submitError && (
        <div className="flex items-center gap-2 text-xs font-medium px-3 py-2 bg-terracotta/25 border-2 border-ink rounded-xl">
          <AlertCircle size={13} /> {submitError}
        </div>
      )}

      {/* Actions */}
      {!inline && pendingFiles.length > 0 && (
        <div className="flex gap-2.5 justify-end">
          <button className="btn-secondary" onClick={onCancel}>Cancel</button>
          <button id="confirm-upload-btn" className="btn-primary" onClick={handleConfirm} disabled={readyCount === 0 || isSubmitting}>
            {isSubmitting ? <><span className="spinner" style={{ width: 16, height: 16 }} /> Uploading</> : `Add ${readyCount}`}
          </button>
        </div>
      )}

      {inline && readyCount > 0 && (
        <button id="inline-confirm-btn" className="btn-primary w-full justify-center" onClick={handleConfirm} disabled={isSubmitting}>
          {isSubmitting ? "Uploading…" : `Continue with ${readyCount}`}
        </button>
      )}
    </div>
  );
}
