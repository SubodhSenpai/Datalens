// ─── Dataset & File Types ─────────────────────────────────────────────────────

export interface ColumnSchema {
  name: string;
  type: "string" | "number" | "boolean" | "date" | "unknown";
  nullable: boolean;
  sample: string[];

  // ── Profile (optional: absent on datasets parsed before profiling existed,
  // so every consumer must treat these as hints, never as guarantees) ──────
  /** Distinct non-blank values, compared as join keys (see keys.ts). */
  distinctCount?: number;
  /** Rows whose value is blank or a "no value" placeholder. */
  nullCount?: number;
  /**
   * Every non-blank value occurs exactly once — i.e. this column is a
   * candidate key. This is what lets the system tell a real "one" side of a
   * relationship from a column that merely shares a name.
   */
  isUnique?: boolean;
  /**
   * Every distinct value, when there are few enough to list (a status or
   * category column). Lets a planner filter on values it has actually seen
   * — "Lost" as well as "Returned" — instead of guessing from three samples.
   */
  distinctValues?: string[];
  /** Smallest and largest value (numbers as numbers, dates as ISO strings) — for describing a column's range. */
  min?: number | string;
  max?: number | string;
  /** For a date column written as dd/mm/yyyy or mm/dd/yyyy: which reading the whole column uses (decided from values that disambiguate it). */
  dayOrder?: "dmy" | "mdy";
  /**
   * A missing-value code found in a numeric column (-999, -9999, 9999 …):
   * a repeated all-nines value far outside the rest of the values. Cells
   * holding it are loaded as blank, so it never enters an average.
   */
  sentinel?: number;
  /** How many cells carried the sentinel. */
  sentinelCount?: number;
  /** The text formatting stripped to read this numeric column (currency sign, thousand separators, percent). */
  numberFormat?: "currency" | "percent" | "thousands" | "parentheses" | "unit-words";
  /** Cells that could not be read as a number in a numeric column (loaded as blank). */
  unparsableCount?: number;
}

/**
 * A detected link between two uploaded files, as shown to the user. A
 * client-side projection of the server's RelationshipRecord.
 */
export interface DatasetLink {
  datasetIdA: string;
  datasetIdB: string;
  columnA: string;
  columnB: string;
  cardinality?: "1:1" | "1:N" | "N:1" | "N:M";
}

export interface DatasetFile {
  id: string;
  name: string;
  size: number;
  format: "csv" | "xlsx";
  uploadedAt: Date;
  rowCount: number;
  columnCount: number;
  columns: ColumnSchema[];
  blobUrl?: string; // Vercel Blob URL after upload
  status: "uploading" | "processing" | "ready" | "error";
  errorMessage?: string;
  /** Worksheet, for a workbook with several table sheets. */
  sheetName?: string;
  /** What the parser did to the file that the user should know about (e.g. a summary row excluded). */
  notes?: string[];
}

export interface Session {
  id: string;
  createdAt: Date;
  datasets: DatasetFile[];
  totalSize: number; // bytes
  /** Links detected between the session's files (recomputed on every upload). */
  links?: DatasetLink[];
}

// ─── Query & Results Types ────────────────────────────────────────────────────

export type ChartType =
  | "bar"
  | "stacked-bar"
  | "dot"
  | "line"
  | "area"
  | "pie"
  | "scatter"
  | "histogram"
  | "radar"
  | "treemap"
  | "heatmap"
  | "none";

export interface QueryResult {
  id: string;
  question: string;
  timestamp: Date;
  status: "pending" | "running" | "success" | "error";
  errorMessage?: string;

  // Structured data
  tableData?: Record<string, unknown>[];
  columns?: string[];

  // Chart
  chartType?: ChartType;
  chartData?: ChartDataPoint[];
  chartConfig?: ChartConfig;

  // LLM explanation
  explanation?: string;
  followUpSuggestions?: string[];

  // Chart tool-calling evaluation, judged against researched chart-selection
  // guidance — see src/lib/chart-eval.
  chartEval?: ChartEvalResult;

  // Statistical correlation, when the question asked for one.
  correlation?: CorrelationResult;

  // Deterministic corrections applied to the LLM's plan before execution
  // (bad join key, missing groupBy, chart pointing at a nonexistent column).
  planRepairs?: string[];

  // Transparency: exactly which files/columns/operations produced this
  // answer, so the user can judge it instead of trusting it blindly.
  source?: QuerySource;

  // The full server-side pipeline, step by step (question → prompt → LLM →
  // repairs → joins → execution → explanation), for inspecting what actually
  // happened rather than only what came out.
  trace?: PipelineStep[];

  /** Which path produced this result (absent on older results = deterministic). */
  mode?: QueryMode;
  /** RAG mode only: the model's own confidence in its answer. */
  confidence?: "high" | "medium" | "low";

  /** Pandas equivalent of the executed plan — the same operations, as runnable code. */
  pandasCode?: string;
}

export interface PipelineStep {
  /** Stable key for the stage: "input" | "prompt" | "llm" | "validate" | "join" | "guard" | "execute" | "explain". */
  id: string;
  label: string;
  status: "ok" | "warn" | "skipped";
  /** One-line result of this stage. */
  summary: string;
  /** Longer free text (e.g. the exact prompt, or each repair on its own line). */
  detail?: string;
  /** Structured payload (e.g. the raw LLM plan JSON) rendered as formatted code. */
  payload?: unknown;
  /** Heading for the payload block, so "parsed plan" vs "final plan" is unambiguous. */
  payloadLabel?: string;
  ms?: number;
  rowsIn?: number;
  rowsOut?: number;
}

export interface QuerySource {
  files: string[]; // dataset names actually used (base + successful joins)
  joins: string[]; // human-readable "X.colA ⋈ Y.colB" for each join actually applied
  derived: string[]; // "as = expr" for any computed columns
  filters: string[]; // human-readable "column op value"
  groupBy: string[];
  aggregations: string[]; // "sum(amount) as total_amount"
  sort?: string;
  limit?: number;
  rowsConsidered: number; // rows in the working table before filters/groupBy
  rowsReturned: number;
}

export interface CorrelationResult {
  columnX: string;
  columnY: string;
  /** Pearson correlation coefficient, -1..1. */
  coefficient: number;
  sampleSize: number;
  interpretation: string;
}

export interface ChartEvalResult {
  actualChartType: ChartType;
  /** null when no guidance rule matched this question/data shape — not scored either way. */
  expectedChartType: ChartType | null;
  /** null mirrors expectedChartType: no applicable rule, so no verdict. */
  matched: boolean | null;
  ruleId?: string;
  rationale?: string;
  source?: string;
}

export interface ChartDataPoint {
  label: string;
  value: number;
  [key: string]: unknown;
}

export interface ChartConfig {
  xKey: string;
  yKeys: string[];
  title?: string;
  colors?: string[];
}

// ─── Query Plan (LLM Query Planner output) ────────────────────────────────────

// isNull / isNotNull make "which X have no Y" answerable: left-join Y, then
// keep the rows where Y's key is null (an anti-join). Blank cells and
// "no value" placeholders count as null.
// in / notIn take a list: "returned or lost" is one filter with two values,
// which neither eq (one value) nor two eq filters (AND — matches nothing)
// can express.
export type FilterOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "isNull" | "isNotNull" | "in" | "notIn";
export type AggregateFn = "sum" | "avg" | "median" | "count" | "countDistinct" | "min" | "max";

export interface QueryDerivedColumn {
  as: string;
  /** Arithmetic expression over existing numeric column names: + - * / ( ) and numeric literals only. */
  expr: string;
}

export interface QueryFilter {
  column: string;
  op: FilterOp;
  value: string | number | boolean | (string | number)[];
  /**
   * Compare against ANOTHER column of the same (joined) row instead of a
   * constant — "spend above its budget", "reading over its limit". When
   * set, `value` is ignored.
   */
  compareTo?: string;
}

export interface QueryAggregation {
  column: string;
  fn: AggregateFn;
  as?: string;
  /**
   * Row conditions applied to THIS aggregate only ("count of readings above
   * the limit" beside a plain count of readings; "average of value where
   * parameter is X" beside the same for Y). The plan's own filters still
   * apply to every aggregate.
   */
  where?: QueryFilter[];
}

export interface QuerySort {
  column: string;
  direction: "asc" | "desc";
}

export interface QueryJoin {
  datasetId: string;
  /** Column name, when both datasets use the SAME name for the join key. */
  on?: string;
  /** Base dataset's column name, when the two datasets name the key differently. */
  leftOn?: string;
  /** Joined dataset's column name, when the two datasets name the key differently. */
  rightOn?: string;
  type?: "inner" | "left";
}

export interface QueryDateBucket {
  column: string;
  granularity: "day" | "month" | "year";
  as?: string;
}

export interface QueryCorrelation {
  columnX: string;
  columnY: string;
}

export interface QueryPlan {
  datasetId: string; // base dataset
  joins?: QueryJoin[]; // other datasets to merge in before filtering/aggregating
  /** Row-level computed columns (e.g. billed = units_used * rate_per_unit * (1 + tax_pct/100)), evaluated before filters/groupBy/aggregations. */
  derive?: QueryDerivedColumn[];
  select?: string[];
  filters?: QueryFilter[];
  dateBucket?: QueryDateBucket;
  groupBy?: string[];
  aggregations?: QueryAggregation[];
  /**
   * Filters applied AFTER grouping, against the aggregate results (SQL
   * HAVING). Needed for "groups that satisfy a condition" questions —
   * "members active in both periods", "branches averaging over X" —
   * which a row-level filter fundamentally cannot express.
   */
  having?: QueryFilter[];
  /** Set when the question asks about correlation/relationship strength between two numeric columns. */
  correlate?: QueryCorrelation;
  sort?: QuerySort[];
  limit?: number;
  chartType?: ChartType;
  chartX?: string;
  chartY?: string[];
  reasoning?: string;
}

// ─── API Payload Types ────────────────────────────────────────────────────────

export interface UploadResponse {
  fileId: string;
  blobUrl: string;
  schema: ColumnSchema[];
  rowCount: number;
  columnCount: number;
}

export interface QueryRequest {
  sessionId: string;
  question: string;
  datasetIds: string[];
  /** User-supplied API key (OpenRouter or Gemini, recognised by shape). Never persisted server-side. */
  apiKey?: string;
  /**
   * How the question is answered. "deterministic" (default): the model
   * writes a plan, the engine executes it, every number is computed.
   * "rag": the rows and statistics most relevant to the question are
   * retrieved and the model answers from them directly — faster and more
   * flexible, but unverified.
   */
  mode?: QueryMode;
}

export type QueryMode = "deterministic" | "rag";

export interface QueryResponse {
  result: QueryResult;
}

// ─── UI State ─────────────────────────────────────────────────────────────────

export interface AppState {
  session: Session | null;
  queries: QueryResult[];
  selectedDatasetIds: string[];
  isQuerying: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// A real analysis easily spans more than ten files, and the upload route
// refuses a WHOLE batch that would cross this line — so a low cap quietly
// turns "upload these twelve files" into ten files plus a banner. The
// session size cap below is what actually protects memory.
export const MAX_FILES = 25;
export const MAX_FILE_SIZE_MB = 25;
export const MAX_SESSION_SIZE_MB = 100;
export const SUPPORTED_FORMATS = [".csv", ".xlsx", ".xls"];
