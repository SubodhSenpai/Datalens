"use client";

import { useState, useRef, useEffect, useSyncExternalStore } from "react";
import { KeyRound, Check, X, ExternalLink } from "lucide-react";

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

// Lets each visitor bring their own OpenRouter key instead of relying on one
// committed to the deployment — the key lives ONLY in this browser
// (localStorage) and is sent with each query request; the server never
// stores it. Needed because a public deployment has no server-side key
// checked into the repo for everyone to share.
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
        <span className={`badge text-[11px] ${displayValue ? "badge-emerald" : "badge-amber"}`}>
          {displayValue ? masked : "Not set"}
        </span>
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="glass-card absolute left-4 right-4 top-full mt-2 z-30 p-4 bg-bg-card animate-[fadeIn_0.15s_ease_forwards]"
        >
          <p className="text-[12px] font-medium text-text-secondary leading-relaxed mb-3">
            Bring your own OpenRouter key for this browser. It&apos;s stored only in your{" "}
            <code className="font-mono">localStorage</code> and sent with each query — never saved on the server.
          </p>
          <input
            id="api-key-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-or-v1-..."
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
            className="w-full px-3 py-2 mb-3 text-[13px] font-mono bg-bg-surface border-2 border-ink rounded-xl outline-none focus:bg-mint/20"
          />
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
          <a
            href="https://openrouter.ai/keys"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 mt-3 text-[11px] font-semibold text-text-secondary hover:text-ink"
          >
            Get a free key at openrouter.ai <ExternalLink size={10} />
          </a>
        </div>
      )}
    </div>
  );
}
