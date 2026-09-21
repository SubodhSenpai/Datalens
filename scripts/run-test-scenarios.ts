import * as fs from "fs";
import * as path from "path";
import * as XLSX from "xlsx";

const BASE_URL = "http://localhost:3000";
const TEST_DATA_ROOT = path.resolve(__dirname, "..", "test-data");
const REPORT_PATH = path.join(TEST_DATA_ROOT, "test-scenarios.xlsx");

interface SessionGroup {
  name: string;
  dir: "csv" | "xlsx";
  files: string[];
}

const SESSION_GROUPS: SessionGroup[] = [
  { name: "core-business", dir: "csv", files: ["sales_transactions.csv", "customers.csv", "products.csv", "employees.csv", "marketing_campaigns.csv", "hr_attrition.csv"] },
  { name: "macro-cross-domain", dir: "csv", files: ["industries_output.csv", "environment_emissions.csv", "weather_data.csv"] },
  { name: "macro-cross-domain-xlsx", dir: "xlsx", files: ["energy_consumption.xlsx", "agriculture_yields.xlsx"] },
  { name: "big-files-perf", dir: "xlsx", files: ["real_estate_listings.xlsx", "hospital_patients.xlsx", "finance_stock_prices.xlsx"] },
  { name: "big-files-perf-2", dir: "csv", files: ["website_analytics.csv"] },
  { name: "big-files-perf-3", dir: "xlsx", files: ["banking_transactions.xlsx"] },
  { name: "misc-domains", dir: "xlsx", files: ["education_scores.xlsx", "supply_chain_shipments.xlsx", "social_media_engagement.xlsx", "restaurant_orders.xlsx"] },
];

type Tier = "Basic" | "Intermediate" | "Advanced" | "Adversarial" | "Basic (very big file)" | "Adversarial (very big file)";

interface Scenario {
  id: number;
  tier: Tier;
  group: string; // matches SessionGroup.name, or "core-business+macro-cross-domain" style combos not supported — one group per scenario
  files: string[]; // filenames (must all be in the same group)
  question: string;
  note: string; // what this scenario is specifically testing
}

const SCENARIOS: Scenario[] = [
  // ── core-business ──
  { id: 1, tier: "Basic", group: "core-business", files: ["sales_transactions.csv"], question: "What is the total sales amount across all transactions?", note: "scalar aggregate on an 80k-row file" },
  { id: 2, tier: "Basic", group: "core-business", files: ["products.csv"], question: "What is the average unit price of products?", note: "basic scalar average" },
  { id: 3, tier: "Basic", group: "core-business", files: ["employees.csv"], question: "How many employees work in the Engineering department?", note: "filter + count" },
  { id: 4, tier: "Intermediate", group: "core-business", files: ["employees.csv"], question: "What is the average salary by department?", note: "groupBy + avg, bar chart expected" },
  { id: 5, tier: "Intermediate", group: "core-business", files: ["sales_transactions.csv"], question: "Show the top 10 products by total sales amount", note: "top-N ranking, bar chart expected" },
  { id: 6, tier: "Intermediate", group: "core-business", files: ["customers.csv"], question: "What is the distribution of customer ages?", note: "histogram expected" },
  { id: 7, tier: "Intermediate", group: "core-business", files: ["sales_transactions.csv"], question: "What is the monthly sales trend for 2024?", note: "date bucketing + line chart" },
  { id: 8, tier: "Intermediate", group: "core-business", files: ["marketing_campaigns.csv"], question: "Show total campaign budget by channel", note: "groupBy + sum, bar chart" },
  { id: 9, tier: "Intermediate", group: "core-business", files: ["sales_transactions.csv"], question: "What is the breakdown of orders by sales channel?", note: "4 categories — pie chart expected" },
  { id: 10, tier: "Advanced", group: "core-business", files: ["marketing_campaigns.csv"], question: "Is there a correlation between click-through rate and conversions in marketing campaigns?", note: "real Pearson correlation + scatter" },
  { id: 11, tier: "Advanced", group: "core-business", files: ["hr_attrition.csv"], question: "Is there a relationship between years at company and job satisfaction?", note: "correlation + scatter on ordinal-ish data" },
  { id: 12, tier: "Advanced", group: "core-business", files: ["customers.csv", "sales_transactions.csv"], question: "Combine customer data with their orders and show total lifetime value by loyalty tier", note: "cross-file join on customer_id (exact name match)" },
  { id: 13, tier: "Advanced", group: "core-business", files: ["hr_attrition.csv"], question: "Compare average monthly income by job role", note: "14 job roles (>12) — dot plot expected over bar" },
  { id: 14, tier: "Advanced", group: "core-business", files: ["marketing_campaigns.csv"], question: "Show total campaign budget broken down by channel and region", note: "2 groupBy dimensions — heatmap expected" },
  { id: 15, tier: "Adversarial", group: "core-business", files: ["hr_attrition.csv", "sales_transactions.csv"], question: "What is the correlation between employee satisfaction and company revenue?", note: "NO valid join key exists between these two files — tests whether the system honestly declines instead of hallucinating a join" },
  { id: 16, tier: "Adversarial", group: "core-business", files: ["sales_transactions.csv"], question: "How are we doing?", note: "deliberately vague — tests graceful handling of an under-specified question" },
  { id: 17, tier: "Adversarial", group: "core-business", files: ["sales_transactions.csv"], question: "Predict next month's sales.", note: "forecasting is out of scope — tests honest refusal vs. fabricated numbers" },

  // ── macro-cross-domain (exact-name vs mismatched-name joins) ──
  { id: 18, tier: "Advanced", group: "macro-cross-domain-xlsx", files: ["agriculture_yields.xlsx", "energy_consumption.xlsx"], question: "Show agriculture production alongside energy consumption for each country", note: "cross-file join on country+year, EXACT name match on both sides" },
  { id: 19, tier: "Advanced", group: "macro-cross-domain", files: ["industries_output.csv", "environment_emissions.csv"], question: "Is there a correlation between industrial output and CO2 emissions by country?", note: "industries uses 'country', environment uses 'nation' — requires value-overlap relationship detection" },
  { id: 20, tier: "Advanced", group: "macro-cross-domain", files: ["weather_data.csv", "environment_emissions.csv"], question: "How does average temperature relate to CO2 emissions by country?", note: "another mismatched-name cross-file join (weather 'country' vs environment 'nation')" },
  { id: 21, tier: "Intermediate", group: "macro-cross-domain", files: ["environment_emissions.csv"], question: "What is the trend in CO2 emissions over the years?", note: "'year' is a plain integer column, not a date type — tests trend handling without a real date column" },
  { id: 22, tier: "Basic", group: "macro-cross-domain", files: ["environment_emissions.csv"], question: "What is the average CO2 emissions by nation?", note: "basic groupBy + avg" },

  // ── big-files-perf ──
  { id: 23, tier: "Advanced", group: "big-files-perf", files: ["real_estate_listings.xlsx"], question: "What is the relationship between square footage and list price?", note: "correlation on a 6k-row xlsx file" },
  { id: 24, tier: "Intermediate", group: "big-files-perf", files: ["hospital_patients.xlsx"], question: "Show average treatment cost by department", note: "groupBy + avg" },
  { id: 25, tier: "Advanced", group: "big-files-perf", files: ["finance_stock_prices.xlsx"], question: "Show the monthly closing price trend for AAPL", note: "filter (ticker=AAPL) + trend, a harder combo" },
  { id: 26, tier: "Basic (very big file)", group: "big-files-perf-2", files: ["website_analytics.csv"], question: "What is the total pageviews by traffic source?", note: "performance test: 50,000-row CSV" },
  { id: 27, tier: "Adversarial (very big file)", group: "big-files-perf-3", files: ["banking_transactions.xlsx"], question: "Show banking transactions where amount is greater than 10000 and channel is not Branch", note: "performance + 2-filter (incl. negation) test on a 40,000-row, ~16MB xlsx file" },

  // ── misc-domains ──
  { id: 28, tier: "Advanced", group: "misc-domains", files: ["social_media_engagement.xlsx"], question: "Compare social media platforms across likes, shares, and comments", note: "6 platforms x 3 metrics — radar chart expected" },
  { id: 29, tier: "Intermediate", group: "misc-domains", files: ["education_scores.xlsx"], question: "What is the average test score by subject?", note: "5 categories — bar/pie" },
  { id: 30, tier: "Intermediate", group: "misc-domains", files: ["supply_chain_shipments.xlsx"], question: "What is the breakdown of shipments by carrier?", note: "6 carriers — proportion, pie expected" },
  { id: 31, tier: "Basic", group: "misc-domains", files: ["restaurant_orders.xlsx"], question: "How many restaurant orders were paid by digital wallet?", note: "filter + count" },
  { id: 32, tier: "Advanced", group: "misc-domains", files: ["restaurant_orders.xlsx"], question: "What is the correlation between delivery time and rating for restaurant orders?", note: "correlation + scatter" },
];

interface ScenarioResult extends Scenario {
  status: string;
  httpStatus: number;
  responseMs: number;
  chartType: string;
  chartExpected: string;
  chartMatched: string;
  correlation: string;
  rowCount: number;
  warnings: string;
  explanation: string;
  sampleAnswer: string;
  error: string;
}

async function uploadGroup(group: SessionGroup): Promise<{ sessionId: string; idByName: Map<string, string> }> {
  const sessionId = `test_${group.name}_${Date.now()}`;
  const idByName = new Map<string, string>();

  for (const fileName of group.files) {
    const filePath = path.join(TEST_DATA_ROOT, group.dir, fileName);
    const buffer = fs.readFileSync(filePath);
    const blob = new Blob([buffer]);
    const form = new FormData();
    form.set("sessionId", sessionId);
    form.append("files", blob, fileName);

    const res = await fetch(`${BASE_URL}/api/upload`, { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok || !data.datasets?.length) {
      throw new Error(`Upload failed for ${fileName}: ${JSON.stringify(data)}`);
    }
    idByName.set(fileName, data.datasets[0].id);
    console.log(`  uploaded ${fileName} -> ${data.datasets[0].id} (${data.datasets[0].rowCount} rows)`);
  }

  return { sessionId, idByName };
}

async function runScenario(sessionId: string, idByName: Map<string, string>, scenario: Scenario): Promise<ScenarioResult> {
  const datasetIds = scenario.files.map((f) => idByName.get(f)).filter((id): id is string => !!id);
  const base: Omit<ScenarioResult, keyof Scenario> = {
    status: "", httpStatus: 0, responseMs: 0, chartType: "", chartExpected: "", chartMatched: "",
    correlation: "", rowCount: 0, warnings: "", explanation: "", sampleAnswer: "", error: "",
  };

  const started = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/api/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, question: scenario.question, datasetIds }),
    });
    const responseMs = Date.now() - started;
    const data = await res.json();
    const result = data.result;

    if (!result || result.status === "error") {
      return { ...scenario, ...base, status: "error", httpStatus: res.status, responseMs, error: result?.errorMessage ?? "Unknown error" };
    }

    const tableData: Record<string, unknown>[] = result.tableData ?? [];
    const sample = tableData.slice(0, 3).map((r) => JSON.stringify(r)).join(" | ");

    return {
      ...scenario,
      ...base,
      status: "success",
      httpStatus: res.status,
      responseMs,
      chartType: result.chartType ?? "none",
      chartExpected: result.chartEval?.expectedChartType ?? "(no guidance rule applied)",
      chartMatched: result.chartEval?.matched === null || result.chartEval?.matched === undefined ? "n/a" : String(result.chartEval.matched),
      correlation: result.correlation ? `r=${result.correlation.coefficient} (${result.correlation.interpretation}, n=${result.correlation.sampleSize})` : "",
      rowCount: tableData.length,
      warnings: "", // folded into explanation by the API already
      explanation: result.explanation ?? "",
      sampleAnswer: sample,
    };
  } catch (err) {
    return { ...scenario, ...base, status: "exception", httpStatus: 0, responseMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  const results: ScenarioResult[] = [];
  const groupCache = new Map<string, { sessionId: string; idByName: Map<string, string> }>();

  for (const group of SESSION_GROUPS) {
    console.log(`\n=== Uploading group "${group.name}" ===`);
    groupCache.set(group.name, await uploadGroup(group));
  }

  for (const scenario of SCENARIOS) {
    const ctx = groupCache.get(scenario.group);
    if (!ctx) throw new Error(`Unknown group "${scenario.group}" for scenario ${scenario.id}`);
    console.log(`\n[${scenario.id}/${SCENARIOS.length}] (${scenario.tier}) ${scenario.question}`);
    const result = await runScenario(ctx.sessionId, ctx.idByName, scenario);
    console.log(`  -> ${result.status} in ${result.responseMs}ms, chart=${result.chartType} (expected=${result.chartExpected}, matched=${result.chartMatched})`);
    results.push(result);
  }

  writeReport(results);
}

function writeReport(results: ScenarioResult[]) {
  const wb = XLSX.utils.book_new();

  // ── Sheet: Eval Summary ──
  const evaluated = results.filter((r) => r.chartMatched === "true" || r.chartMatched === "false");
  const matched = evaluated.filter((r) => r.chartMatched === "true");
  const succeeded = results.filter((r) => r.status === "success");
  const errored = results.filter((r) => r.status !== "success");
  const avgMs = Math.round(results.reduce((a, r) => a + r.responseMs, 0) / results.length);
  const byTier = new Map<string, { total: number; success: number }>();
  for (const r of results) {
    const t = byTier.get(r.tier) ?? { total: 0, success: 0 };
    t.total++;
    if (r.status === "success") t.success++;
    byTier.set(r.tier, t);
  }

  const summaryRows: (string | number)[][] = [
    ["FDE Assignment — System Test Report"],
    ["Generated", new Date().toISOString()],
    ["Datasets used", "20 (10 CSV + 10 XLSX), synthetic but realistic — see Datasets sheet"],
    [],
    ["OVERALL"],
    ["Total scenarios run", results.length],
    ["Succeeded", succeeded.length],
    ["Errored / exception", errored.length],
    ["Average response time (ms)", avgMs],
    [],
    ["BY DIFFICULTY TIER"],
    ["Tier", "Total", "Succeeded"],
    ...Array.from(byTier.entries()).map(([tier, v]) => [tier, v.total, v.success]),
    [],
    ["CHART TOOL-CALLING EVAL (vs. researched chart-selection guidance)"],
    ["Scenarios with an applicable guidance rule", evaluated.length],
    ["Matched guidance", matched.length],
    ["Match rate", evaluated.length ? `${Math.round((matched.length / evaluated.length) * 100)}%` : "n/a"],
    [],
    ["ADVERSARIAL SCENARIOS (deliberately hard/impossible — reviewed manually, see notes column)"],
    ...results.filter((r) => r.tier.startsWith("Adversarial")).map((r) => [`#${r.id}`, r.question, r.status, r.explanation.slice(0, 200)]),
  ];
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  summarySheet["!cols"] = [{ wch: 30 }, { wch: 60 }, { wch: 15 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, summarySheet, "Eval Summary");

  // ── Sheet: Test Scenarios ──
  const scenarioRows = results.map((r) => ({
    ID: r.id,
    Tier: r.tier,
    Files: r.files.join(" + "),
    Question: r.question,
    "What this tests": r.note,
    Status: r.status,
    "Response (ms)": r.responseMs,
    "Chart used": r.chartType,
    "Chart expected (guidance)": r.chartExpected,
    "Chart matched?": r.chartMatched,
    Correlation: r.correlation,
    "Result rows": r.rowCount,
    "Sample answer rows": r.sampleAnswer,
    Explanation: r.explanation,
    Error: r.error,
  }));
  const scenarioSheet = XLSX.utils.json_to_sheet(scenarioRows);
  scenarioSheet["!cols"] = [
    { wch: 5 }, { wch: 14 }, { wch: 25 }, { wch: 45 }, { wch: 45 }, { wch: 10 }, { wch: 12 },
    { wch: 12 }, { wch: 20 }, { wch: 12 }, { wch: 30 }, { wch: 10 }, { wch: 60 }, { wch: 60 }, { wch: 30 },
  ];
  XLSX.utils.book_append_sheet(wb, scenarioSheet, "Test Scenarios");

  // ── Sheet: Datasets reference ──
  const datasetRows: (string | number)[][] = [["File", "Format", "Rows", "Size (MB)", "Columns"]];
  for (const group of SESSION_GROUPS) {
    for (const fileName of group.files) {
      const filePath = path.join(TEST_DATA_ROOT, group.dir, fileName);
      const sizeMB = (fs.statSync(filePath).size / 1024 / 1024).toFixed(2);
      let rowCount = "?";
      let columns = "";
      if (group.dir === "csv") {
        const text = fs.readFileSync(filePath, "utf-8");
        const lines = text.split("\n").filter(Boolean);
        rowCount = String(lines.length - 1);
        columns = lines[0];
      } else {
        const wbIn = XLSX.readFile(filePath);
        const ws = wbIn.Sheets[wbIn.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][];
        rowCount = String(json.length - 1);
        columns = (json[0] as string[]).join(", ");
      }
      datasetRows.push([fileName, group.dir.toUpperCase(), rowCount, sizeMB, columns]);
    }
  }
  const datasetsSheet = XLSX.utils.aoa_to_sheet(datasetRows);
  datasetsSheet["!cols"] = [{ wch: 30 }, { wch: 8 }, { wch: 10 }, { wch: 12 }, { wch: 90 }];
  XLSX.utils.book_append_sheet(wb, datasetsSheet, "Datasets");

  XLSX.writeFile(wb, REPORT_PATH);
  console.log(`\nReport written to ${REPORT_PATH}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
