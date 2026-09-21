import { ImageResponse } from "next/og";
import { SITE_NAME, SITE_TAGLINE } from "@/lib/site";

export const alt = `${SITE_NAME} — ${SITE_TAGLINE}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Generated at build time; no design asset to keep in sync.
export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", background: "#F3EEE0", color: "#1B1A15", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <div style={{ width: 72, height: 72, borderRadius: 36, background: "#F2C744", border: "4px solid #1B1A15" }} />
          <div style={{ fontSize: 96, fontWeight: 800, letterSpacing: -2 }}>{SITE_NAME}</div>
        </div>
        <div style={{ marginTop: 28, fontSize: 40, fontWeight: 600, color: "#4A4739" }}>{SITE_TAGLINE}</div>
        <div style={{ marginTop: 40, display: "flex", gap: 16 }}>
          {["CSV / Excel", "Plain English", "Charts", "Cross-file"].map((t) => (
            <div key={t} style={{ padding: "12px 24px", borderRadius: 999, border: "3px solid #1B1A15", background: "#CFE9DC", fontSize: 28, fontWeight: 700 }}>{t}</div>
          ))}
        </div>
      </div>
    ),
    size
  );
}
