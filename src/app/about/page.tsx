import type { Metadata } from "next";
import Link from "next/link";
import { Sparkles, ArrowRight, Code2 } from "lucide-react";
import GithubIcon from "@/components/GithubIcon";
import { SITE_URL, SITE_NAME, SITE_DESCRIPTION, REPO_URL, ORG_NAME, FAQS, HOW_IT_WORKS } from "@/lib/site";

// The landing page is deliberately text-light. This page carries the text
// that search and answer engines read: a definition, the steps, what is
// handled and a visible FAQ mirrored in JSON-LD.

export const metadata: Metadata = {
  title: "About — ask CSV and Excel files anything",
  description: SITE_DESCRIPTION,
  alternates: { canonical: "/about" },
  openGraph: { title: `About ${SITE_NAME}`, description: SITE_DESCRIPTION, url: `${SITE_URL}/about` },
};

const HANDLES = [
  ["Formatted numbers", "₹4,80,02,573.75 · 9.5 lakh · (500) · 12% — read as numbers, with the format reported"],
  ["Mixed dates", "01-Aug-2021, 2021/08/01, 08/01/2021 — day/month order detected per column"],
  ["Blanks and codes", "N/A, –, none, -999 — treated as missing, counted and reported"],
  ["Summary rows", "TOTAL and subtotal rows excluded so they are not double counted"],
  ["Several files", "Keys detected from uniqueness and value overlap; joins built by the compiler, never by the model"],
  ["Sensor and long-format data", "parameter / value / unit tables and quality flags recognised as such"],
];


export default function AboutPage() {
  const faqJsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "FAQPage",
        "@id": `${SITE_URL}/about#faq`,
        mainEntity: FAQS.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: SITE_NAME, item: SITE_URL },
          { "@type": "ListItem", position: 2, name: "About", item: `${SITE_URL}/about` },
        ],
      },
    ],
  };

  return (
    <main className="relative z-10 min-h-screen">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd).replace(/</g, "\\u003c") }} />

      {/* ── NAV — same as the landing page ── */}
      <nav className="sticky top-0 z-50 bg-bg-base/90 backdrop-blur-sm border-b-2 border-ink">
        <div className="px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-mustard border-2 border-ink flex items-center justify-center">
              <Sparkles size={15} />
            </div>
            <span className="text-xl font-display font-bold tracking-tight">{SITE_NAME}</span>
          </Link>
          <div className="flex items-center gap-3">
            <a href={REPO_URL} aria-label="Source on GitHub" title="Source on GitHub" rel="noopener" className="w-9 h-9 rounded-full bg-bg-card border-2 border-ink flex items-center justify-center shadow-hard-sm hover:translate-x-[-1px] hover:translate-y-[-1px] hover:shadow-hard transition-all">
              <GithubIcon size={17} />
            </a>
            <Link href="/dashboard" className="btn-primary text-sm">
              Try free <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </nav>

      <article className="px-6 pt-14 pb-20">
        <div className="max-w-3xl mx-auto flex flex-col gap-14">

          {/* ── Definition — the sentence an answer engine quotes ── */}
          <header className="flex flex-col gap-5">
            <h1 className="font-display text-4xl md:text-5xl font-extrabold leading-[1.08] -rotate-1">
              Ask CSV &amp; Excel files questions in{" "}
              <span className="inline-block bg-mustard px-3 rounded-2xl border-2 border-ink rotate-1">plain English</span>
            </h1>
            <p className="text-lg text-text-secondary font-medium leading-relaxed">
              {SITE_NAME} is a free, open-source web app that turns a question about your spreadsheets into a computed table, a chart and a short explanation.
              A language model writes a small query plan; a deterministic engine does the arithmetic and shows the plan, every correction and the joins it used — so any number can be traced.
            </p>
          </header>

          {/* ── How it works ── */}
          <section aria-labelledby="how">
            <h2 id="how" className="font-display text-2xl font-extrabold mb-5">How it works</h2>
            <ol className="grid md:grid-cols-3 gap-4">
              {HOW_IT_WORKS.map((s, i) => (
                <li key={s.title} className="glass-card p-5">
                  <div className="w-7 h-7 rounded-full bg-mustard border-2 border-ink flex items-center justify-center font-display font-bold text-sm mb-3">{i + 1}</div>
                  <h3 className="font-display font-bold mb-1">{s.title}</h3>
                  <p className="text-sm text-text-secondary leading-relaxed">{s.text}</p>
                </li>
              ))}
            </ol>
            <p className="mt-5 text-sm text-text-secondary leading-relaxed">
              Behind the three steps: parse and clean → profile columns → infer keys between files → build a menu of measures and dimensions → the model selects from the menu → a compiler builds joins → a validator repairs the plan → ten structural checks re-ask the model with feedback (at most three attempts) → the engine computes → a default chart is chosen from the result shape.
            </p>
          </section>

          {/* ── What it handles ── */}
          <section aria-labelledby="handles">
            <h2 id="handles" className="font-display text-2xl font-extrabold mb-5">What messy exports it handles</h2>
            <dl className="grid md:grid-cols-2 gap-4">
              {HANDLES.map(([term, desc]) => (
                <div key={term} className="glass-card p-5">
                  <dt className="font-display font-bold mb-1">{term}</dt>
                  <dd className="text-sm text-text-secondary leading-relaxed">{desc}</dd>
                </div>
              ))}
            </dl>
          </section>


          {/* ── FAQ — visible twin of the FAQPage JSON-LD above ── */}
          <section aria-labelledby="faq">
            <h2 id="faq" className="font-display text-2xl font-extrabold mb-5">Questions</h2>
            <div className="flex flex-col gap-3">
              {FAQS.map((f) => (
                <details key={f.q} className="glass-card px-5 py-4 group">
                  <summary className="cursor-pointer list-none flex items-center justify-between gap-4">
                    <h3 className="font-display font-bold text-base">{f.q}</h3>
                    <ArrowRight size={16} className="shrink-0 transition-transform group-open:rotate-90" />
                  </summary>
                  <p className="mt-3 text-sm text-text-secondary leading-relaxed">{f.a}</p>
                </details>
              ))}
            </div>
          </section>

          {/* ── Open source ── */}
          <section aria-labelledby="oss" className="glass-card bg-sage/40 p-6 flex flex-col md:flex-row md:items-center gap-4 justify-between">
            <div>
              <h2 id="oss" className="font-display text-xl font-extrabold mb-1">Open source, MIT licensed</h2>
              <p className="text-sm text-text-secondary leading-relaxed">Next.js, TypeScript and Recharts. Validation data sets, answer keys and eight offline test suites ship with the code. Co-powered by {ORG_NAME}.</p>
            </div>
            <a href={REPO_URL} className="btn-primary text-sm shrink-0" rel="noopener">
              <Code2 size={14} /> Source on GitHub
            </a>
          </section>
        </div>
      </article>

      {/* ── FOOTER — same as the landing page ── */}
      <footer className="border-t-2 border-ink py-6 px-6">
        <div className="flex items-center justify-between text-xs text-text-secondary font-semibold">
          <span className="flex items-center gap-3"><Link href="/">{SITE_NAME}</Link><Link href="/about" className="underline underline-offset-2">About</Link></span>
          <span>Co-powered by {ORG_NAME}</span>
        </div>
      </footer>
    </main>
  );
}
