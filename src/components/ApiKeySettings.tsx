"use client";

import { useState, useRef, useEffect, useSyncExternalStore } from "react";
import { KeyRound, Check, X, ExternalLink, Sparkles } from "lucide-react";
import { PROVIDERS, detectProvider } from "@/lib/providers";

const STORAGE_KEY = "datalens_openrouter_api_key";

// Whether the component has mounted never changes afterwards, so there is
// nothing to subscribe to. Defined at module scope so the reference is stable
// across renders.
const subscribeToNothing = () => () => {};

export function loadStoredApiKey(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

interface ApiKeySettingsProps {
  value: string;
  onChange: (key: string) => void;
}

// Lets each visitor bring their own key — OpenRouter or Google Gemini, told
// apart by the key's shape (see providers.ts) — instead of relying on one
// committed to the deployment. The key lives ONLY in this browser
// (localStorage) and is sent with each query request; the server never
// stores it.
export default function ApiKeySettings({ value, onChange }: ApiKeySettingsProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const popoverRef = useRef<HTMLDivElement>(null);

  // The saved key comes from localStorage, which the server can't see, so the
  // first client render has to match the server's empty one or React reports a
  // hydration mismatch. useSyncExternalStore gives the server and client
  // snapshots directly — the older "set a flag in an effect" version did the
  // same job but triggered a cascading re-render on every mount.
  const hasMounted = useSyncExternalStore(subscribeToNothing, () => true, () => false);

  const toggleOpen = () => {
    setOpen((p) => {
      if (!p) setDraft(value); // reset draft to the saved value each time it's opened
      return !p;
    });
  };

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const save = () => {
    const trimmed = draft.trim();
    try {
      if (trimmed) window.localStorage.setItem(STORAGE_KEY, trimmed);
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch { /* private browsing / storage blocked — still works for this tab */ }
    onChange(trimmed);
    setOpen(false);
  };

  const clear = () => {
    try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    setDraft("");
    onChange("");
    setOpen(false);
  };

  // During SSR and initial hydration, treat the key as empty so the server
  // and client render identically. Once React has mounted on the client,
  // show the real value — this avoids the hydration mismatch from
  // localStorage being unavailable during SSR.
  const displayValue = hasMounted ? value : "";
  const masked = displayValue ? `${displayValue.slice(0, 7)}…${displayValue.slice(-4)}` : "";
  const saved = displayValue ? detectProvider(displayValue) : null;
  const typed = draft.trim() ? detectProvider(draft) : null;

  return (
    <div className="relative px-4 py-3 border-b-2 border-ink">
      <button
        id="api-key-toggle"
        onClick={toggleOpen}
        className="w-full flex items-center justify-between gap-2 text-left"
      >
        <span className="flex items-center gap-1.5 text-[11px] font-bold text-text-secondary uppercase tracking-widest">
          <KeyRound size={12} /> API key
        </span>
        <span className={`badge text-[11px] ${displayValue ? "badge-emerald" : "badge-amber"}`} title={saved ? `${PROVIDERS[saved.id].label} key` : undefined}>
          {displayValue ? `${PROVIDERS[saved!.id].label} · ${masked}` : "Not set"}
        </span>
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="glass-card absolute left-4 right-4 top-full mt-2 z-30 p-4 bg-bg-card animate-[fadeIn_0.15s_ease_forwards]"
        >
          <p className="text-[12px] font-medium text-text-secondary leading-relaxed mb-3">
            Bring your own key for this browser — OpenRouter or Google Gemini; the provider is recognised from the key itself. It&apos;s stored only in your{" "}
            <code className="font-mono">localStorage</code> and sent with each query — never saved on the server.
          </p>
          <input
            id="api-key-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={`${PROVIDERS.openrouter.keyHint}  or  ${PROVIDERS.gemini.keyHint}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
            className="w-full px-3 py-2 mb-1 text-[13px] font-mono bg-bg-surface border-2 border-ink rounded-xl outline-none focus:bg-mint/20"
          />
          <p id="api-key-provider" className={`flex items-center gap-1 mb-3 text-[11px] font-semibold ${typed ? (typed.recognised ? "text-sage-dark" : "text-mustard-dark") : "text-text-muted"}`}>
            <Sparkles size={11} />
            {typed
              ? typed.recognised
                ? `${PROVIDERS[typed.id].label} key recognised — models: ${PROVIDERS[typed.id].models.slice(0, 2).join(", ")}, …`
                : "Key shape not recognised — it will be sent to OpenRouter"
              : "Paste a key to see which provider it belongs to"}
          </p>
          <div className="flex items-center gap-2">
            <button id="api-key-save" onClick={save} className="btn-primary flex-1 justify-center py-1.5 text-[13px]">
              <Check size={13} /> Save
            </button>
            {displayValue && (
              <button id="api-key-clear" onClick={clear} className="btn-ghost px-3 py-1.5 text-[13px]">
                <X size={13} /> Clear
              </button>
            )}
          </div>
          <div className="flex items-center gap-3 mt-3">
            {(["openrouter", "gemini"] as const).map((id) => (
              <a
                key={id}
                href={PROVIDERS[id].keysUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-[11px] font-semibold text-text-secondary hover:text-ink"
              >
                {PROVIDERS[id].label} key <ExternalLink size={10} />
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
