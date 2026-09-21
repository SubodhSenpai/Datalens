// Everything search engines and answer engines read about the site comes
// from here, so the visible page, the JSON-LD and llms.txt never disagree.

export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://datalens-six-rouge.vercel.app").replace(/\/$/, "");
export const SITE_NAME = "DataLens";
export const SITE_TAGLINE = "Ask your CSV and Excel files anything";
export const SITE_DESCRIPTION =
  "Upload CSV or Excel files, ask a question in plain English and get a computed table, a chart and an explanation — across several files, with free open-source models. Every answer shows the plan it ran.";
export const REPO_URL = "https://github.com/SubodhSenpai/Datalens";

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
