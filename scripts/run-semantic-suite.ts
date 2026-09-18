import * as fs from "fs";
import * as path from "path";

// What happens when the question does NOT use the column names?
//
// Every question here is phrased the way a business user would actually ask
// it — "money", "staff", "product line", "priciest" — and none of them match
// a column literally. The last group is different on purpose: those ask for
// something the data genuinely does not contain, where the only correct
// behaviour is to say so rather than invent a number.

const BASE_URL = "http://localhost:3000";
const TEST_DATA = path.resolve(__dirname, "..", "..", "test-data");

interface SemanticCase {
  id: number;
  files: string[];
  question: string;
  /** The column(s) the question is really about, never named in the question. */
  intent: string;
  /** "answerable" = the data supports it; "absent" = the concept isn't in the data at all. */
  kind: "answerable" | "absent";
}

const CASES: SemanticCase[] = [
  // ── Synonyms / indirect phrasing, but the data DOES support the answer ──
  { id: 1, files: ["sales_transactions.csv"], question: "Which region brings in the most money?", intent: "money -> total_amount, region -> region", kind: "answerable" },
  { id: 2, files: ["employees.csv"], question: "How many people work in each division?", intent: "people -> row count, division -> department", kind: "answerable" },
  { id: 3, files: ["sales_transactions.csv"], question: "What is our best selling product line?", intent: "product line -> category, best selling -> SUM(total_amount) or quantity", kind: "answerable" },
  { id: 4, files: ["marketing_campaigns.csv"], question: "How much are we spending on each marketing medium?", intent: "spending -> budget_usd, marketing medium -> channel", kind: "answerable" },
  { id: 5, files: ["real_estate_listings.xlsx"], question: "Which city has the priciest homes?", intent: "priciest homes -> list_price, city -> city", kind: "answerable" },
  { id: 6, files: ["restaurant_orders.xlsx"], question: "What do diners typically spend per visit?", intent: "diners spend per visit -> AVG(order_value_usd)", kind: "answerable" },
  { id: 7, files: ["hr_attrition.csv"], question: "Are staff leaving more often when they work late?", intent: "leaving -> attrition, work late -> overtime", kind: "answerable" },
  { id: 8, files: ["hospital_patients.xlsx"], question: "How long do people usually stay in hospital?", intent: "how long stay -> AVG(length_of_stay_days)", kind: "answerable" },
  { id: 9, files: ["customers.csv"], question: "How old are our shoppers on average?", intent: "shoppers -> customers, how old -> AVG(age)", kind: "answerable" },
  { id: 10, files: ["website_analytics.csv"], question: "Where is our web traffic coming from?", intent: "where from -> traffic_source, traffic -> sessions/users", kind: "answerable" },

  // ── The concept genuinely is NOT in the data ────────────────────────────
  { id: 11, files: ["sales_transactions.csv"], question: "What is our profit margin by region?", intent: "profit/margin: NOT present (no cost column in this file)", kind: "absent" },
  { id: 12, files: ["employees.csv"], question: "How satisfied are employees with their managers?", intent: "satisfaction with managers: NOT present in employees.csv", kind: "absent" },
  { id: 13, files: ["customers.csv"], question: "Which customers are most likely to churn next month?", intent: "churn propensity: NOT present, and requires prediction", kind: "absent" },
];

async function uploadFiles(sessionId: string, files: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const fileName of files) {
    const dir = fileName.endsWith(".csv") ? "csv" : "xlsx";
    const buffer = fs.readFileSync(path.join(TEST_DATA, dir, fileName));
    const form = new FormData();
    form.set("sessionId", sessionId);
    form.append("files", new Blob([buffer]), fileName);
    const res = await fetch(`${BASE_URL}/api/upload`, { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok || !data.datasets?.length) throw new Error(`upload failed for ${fileName}`);
    ids.push(data.datasets[0].id);
  }
  return ids;
}

async function main() {
  console.log(`Semantic mapping suite — ${CASES.length} questions, none using literal column names\n`);

  for (const c of CASES) {
    const sessionId = `sem_${c.id}_${Date.now()}`;
    const datasetIds = await uploadFiles(sessionId, c.files);
    const res = await fetch(`${BASE_URL}/api/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, question: c.question, datasetIds }),
    });
    const data = await res.json();
    const r = data.result;

    console.log(`[${c.id}] (${c.kind}) ${c.question}`);
    console.log(`     really means: ${c.intent}`);
    if (!r || r.status !== "success") {
      console.log(`     ERROR: ${r?.errorMessage ?? "unknown"}\n`);
      continue;
    }
    console.log(`     columns returned: ${JSON.stringify(r.columns)}`);
    console.log(`     rows: ${(r.tableData ?? []).length} | chart: ${r.chartType}`);
    console.log(`     first row: ${JSON.stringify((r.tableData ?? [])[0] ?? null)}`);
    if ((r.planRepairs ?? []).length) console.log(`     repairs: ${JSON.stringify(r.planRepairs)}`);
    console.log(`     says: ${String(r.explanation ?? "").slice(0, 260)}\n`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
