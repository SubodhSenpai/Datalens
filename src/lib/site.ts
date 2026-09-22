// Everything search engines and answer engines read about the site comes
// from here, so the visible page, the JSON-LD and llms.txt never disagree.

export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://datalens-six-rouge.vercel.app").replace(/\/$/, "");
export const SITE_NAME = "DataLens";
export const SITE_TAGLINE = "Ask your CSV and Excel files anything";
export const SITE_DESCRIPTION =
  "Ask CSV and Excel files questions in plain English and get a computed table, chart and explanation — across files, on free open-source models.";
export const REPO_URL = "https://github.com/SubodhSenpai/Datalens";
export const ORG_NAME = "Konika Systems Private Limited";

export const KEYWORDS = [
  "ask questions about CSV file",
  "chat with Excel",
  "natural language data analysis",
  "CSV to chart AI",
  "Excel question answering",
  "text to SQL for spreadsheets",
  "cross-file data analysis",
  "open source data analyst AI",
  "spreadsheet AI assistant",
  "DataLens",
];

export interface Faq { q: string; a: string }

// Visible on /about and mirrored in its FAQPage JSON-LD. Answers lead with
// the fact, so a snippet or an answer engine can quote the first sentence.
export const FAQS: Faq[] = [
  {
    q: "What is DataLens?",
    a: "DataLens is a free, open-source web app that answers questions about CSV and Excel files in plain English. A language model writes a small query plan; a deterministic engine computes the table, chart and explanation and shows the full trace, so every number can be checked.",
  },
  {
    q: "Which files can I upload?",
    a: "CSV, XLSX and XLS — up to 25 files and 25 MB each per session. Messy exports are handled: formatted numbers such as ₹4,80,000 or 9.5 lakh, mixed date formats, blank placeholders, -999 codes and TOTAL rows are cleaned, and every fix is reported on the file card.",
  },
  {
    q: "Can it answer questions across several files?",
    a: "Yes. Keys shared between files are detected from uniqueness and value overlap, so no manual mapping is needed. Two fact tables are aggregated separately and then merged, which avoids double counting.",
  },
  {
    q: "Which AI models does it use?",
    a: "Free open-source models through OpenRouter (Qwen, Gemma, GLM, Nemotron) or Google Gemini, with automatic fallback between them. You can paste your own key; it stays in your browser. If no model is reachable, DataLens says so instead of guessing.",
  },
  {
    q: "Is my data stored or sent to the model?",
    a: "Files are kept in private storage for the session and deleted when you remove them or after 24 hours of inactivity. The model only receives column names, a few example values and a preview of the computed result — never the whole file.",
  },
  {
    q: "How accurate are the answers?",
    a: "Numbers are computed by code, not by the model, so they are exact for the plan that ran — and that plan, every correction and the joins used are shown with each answer, so a wrong reading can be traced rather than trusted.",
  },
  {
    q: "Is DataLens free and open source?",
    a: "Yes. It is MIT-licensed and runs on free model tiers. The source, validation data sets and test suites are on GitHub.",
  },
];

export const HOW_IT_WORKS = [
  { title: "Drop spreadsheets", text: "CSV or Excel. Columns are profiled, messy values cleaned, and joins between files found automatically." },
  { title: "Ask in plain English", text: "\"Revenue by region last quarter\" or \"which sensors exceeded their limit\". The model plans; it never computes." },
  { title: "See the answer", text: "A table, a chart and a short explanation, with the plan and every correction shown underneath." },
];
