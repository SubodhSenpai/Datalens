import { ColumnSchema } from "./types";
import { RelationshipRecord } from "./session-store";

/**
 * Schema linking: work out, before the model is asked anything, which
 * columns the question refers to, which dataset each one lives in, and the
 * join path that connects them.
 *
 * The observed failure this exists for: asked "loans by member
 * city", a small model stayed inside the loans file and grouped by its own
 * "branch" column — a valid plan that answers a different question.
 * Nothing downstream could object, because the plan referenced nothing
 * that didn't exist. The information that "city" lives in another file and
 * reaches it through member_id was in the prompt, but as one of a dozen
 * relationships the model had to search itself.
 *
 * Everything here is computed from the question text, the column names and
 * the detected relationships. It knows no business vocabulary: "genre"
 * links to a column because the word is the column's name, not because
 * anyone listed it.
 */

export interface LinkableDataset {
  id: string;
  name: string;
  rowCount: number;
  columns: ColumnSchema[];
}

export interface LinkedColumn {
  /** The word(s) in the question that matched. */
  term: string;
  column: string;
  /** Every dataset holding a column of this name — one entry = unambiguous. */
  datasetIds: string[];
  /**
   * "strong": the question contains the column's own words (allowing only
   * singular/plural). "weak": the match needed verb-form stemming
   * ("open" ↔ opened_on) or an abbreviation. A weak link is offered to the
   * planner as a hint but never used to force a table or fail a plan — that
   * is how "still open" once dragged an unrelated events table into a
   * question about memberships.
   */
  strength: "strong" | "weak";
}

export interface JoinStep {
  datasetId: string;
  leftOn: string;
  rightOn: string;
  basis: string;
  cardinality?: string;
}

export interface SchemaLink {
  columns: LinkedColumn[];
  /** For each linked column (lower-cased), every dataset holding the same concept, relationships included. */
  conceptHolders: Map<string, string[]>;
  /**
   * Parents of linked foreign keys — where the human-readable name behind
   * an id lives (librarian_id → the staff table). Worth joining to
   * label the answer; not required, since the question didn't ask for a
   * column there.
   */
  lookupJoins: JoinStep[];
  /** Datasets mentioned by NAME in the question ("members", "loans"). */
  mentionedDatasetIds: string[];
  /** Datasets the plan must include: each holds a linked column found nowhere else. */
  requiredDatasetIds: string[];
  /** Suggested base: the required dataset holding the rows being aggregated. */
  suggestedBaseId?: string;
  /** Joins from the suggested base reaching every other required dataset. */
  joinPath: JoinStep[];
  /** Required datasets no relationship connects to the base. */
  unreachable: string[];
}

const STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "were", "what", "which", "who", "whom", "how", "many",
  "much", "show", "give", "list", "find", "get", "all", "any", "each", "every", "total",
  "sum", "average", "avg", "mean", "count", "number", "top", "bottom", "highest", "lowest",
  "most", "least", "per", "with", "without", "from", "that", "this", "these", "those",
  "have", "has", "had", "been", "being", "there", "their", "them", "then", "than", "but",
  "not", "did", "does", "our", "out", "across", "between", "over", "under", "into", "about",
  "compare", "versus", "did", "any", "never", "ever", "still", "yes", "no", "vs", "of", "by",
  "in", "on", "at", "to", "is", "it", "as", "an", "a", "or", "we", "do", "its",
]);

// Column-name tokens that carry no meaning of their own ("member_id" is
// about members, not about ids).
const GENERIC_COLUMN_TOKENS = new Set(["id", "ids", "key", "code", "no", "num", "number", "name", "date", "at", "on", "flag", "type", "pct", "percent", "value", "amount", "total", "count", "qty", "quantity", "per", "of"]);

/**
 * Crude stem so inflections meet: countries/country, branches/branch, and
 * borrowed/borrows/borrow all reduce to the same form. Not a real
 * stemmer — just enough for a question word to find the column or file it
 * names, and applied identically to both sides.
 */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length <= 3) return w;
  if (w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.endsWith("sses") || w.endsWith("shes") || w.endsWith("ches") || w.endsWith("xes")) w = w.slice(0, -2);
  else if (w.endsWith("ing") && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith("ed") && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith("es") && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) w = w.slice(0, -1);
  if (w.endsWith("e") && w.length > 4) w = w.slice(0, -1);
  return w;
}

/** Singular/plural only — the inflection a noun takes without changing meaning. */
export function singular(word: string): string {
  const w = word.toLowerCase();
  if (w.length <= 3) return w;
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.endsWith("sses") || w.endsWith("shes") || w.endsWith("ches") || w.endsWith("xes")) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
  return w;
}

function questionTokens(question: string): Set<string> {
  const out = new Set<string>();
  for (const raw of question.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || STOPWORDS.has(raw)) continue;
    out.add(raw);
    out.add(stem(raw));
  }
  return out;
}

/** Question words with only singular/plural folding — the "strong" vocabulary. */
function questionPlainTokens(question: string): Set<string> {
  const out = new Set<string>();
  for (const raw of question.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || STOPWORDS.has(raw)) continue;
    out.add(raw);
    out.add(singular(raw));
  }
  return out;
}

/** Column tokens with only singular/plural folding. */
function columnPlainTokens(column: string): string[] {
  return column
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !GENERIC_COLUMN_TOKENS.has(t))
    .map(singular);
}

/** "home_branch_id" → ["home", "branch"]; "isbn" → ["isbn"]. */
export function columnTokens(column: string): string[] {
  return column
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !GENERIC_COLUMN_TOKENS.has(t))
    .map(stem);
}

/** "library.xlsx — Loans" → "loan"; "members.csv" → "member". */
function datasetTokens(name: string): string[] {
  const tail = name.split(/\s+—\s+/).pop() ?? name;
  return tail
    .replace(/\.(csv|xlsx|xls)$/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOPWORDS.has(t))
    .map(stem);
}

/**
 * Which columns the question names. A column matches when the question
 * contains its whole canonical name, or every meaningful token of it
 * ("home branch" → home_branch_id). Single-token columns must match
 * on a token of at least four letters, so "P1" or "id" can't link by accident.
 */
export function linkColumns(question: string, datasets: LinkableDataset[]): LinkedColumn[] {
  const qTokens = questionTokens(question);
  const qPlain = questionPlainTokens(question);
  const qCompact = question.toLowerCase().replace(/[^a-z0-9]/g, "");
  const byColumn = new Map<string, { term: string; datasetIds: Set<string>; strength: "strong" | "weak" }>();

  // A column token matches a question word when they share a stem, or when
  // the token is an abbreviation of the word: at least four letters, the
  // same first two letters, and every letter of the token appearing in the
  // word in order. "dept" → "department", "cat" → "category",
  // "desc" → "description"; but "team" does not meet "treatment" (t-r vs
  // t-e) and "qty" is too short to abbreviate anything.
  const abbreviates = (short: string, long: string) => {
    if (short.length < 4 || long.length < short.length + 2) return false;
    if (short.slice(0, 2) !== long.slice(0, 2)) return false;
    let i = 0;
    for (const ch of long) if (ch === short[i]) i++;
    return i === short.length;
  };
  const tokenMatches = (t: string) => {
    if (qTokens.has(t)) return true;
    for (const q of qTokens) if (abbreviates(t, q) || abbreviates(q, t)) return true;
    return false;
  };

  for (const ds of datasets) {
    for (const col of ds.columns) {
      const canonical = col.name.toLowerCase().replace(/[^a-z0-9]/g, "");
      const tokens = columnTokens(col.name);
      const plain = columnPlainTokens(col.name);
      let term: string | undefined;
      let strength: "strong" | "weak" = "weak";

      // Whole column name present in the question ("page_count", "isbn") —
      // but a name that is itself a generic word ("name", "date") is not
      // evidence of anything.
      if (canonical.length >= 4 && !GENERIC_COLUMN_TOKENS.has(canonical) && qCompact.includes(canonical)) {
        term = col.name;
        strength = "strong";
      } else if (plain.length > 0 && plain.every((t) => qPlain.has(t)) && (plain.length > 1 || plain[0].length >= 4)) {
        term = plain.join(" ");
        strength = "strong";
      } else if (tokens.length > 0 && tokens.every(tokenMatches)) {
        if (tokens.length > 1 || tokens[0].length >= 4) term = tokens.join(" ");
      }
      if (!term) continue;

      const key = col.name.toLowerCase();
      const entry = byColumn.get(key) ?? { term, datasetIds: new Set<string>(), strength };
      if (strength === "strong") entry.strength = "strong";
      entry.datasetIds.add(ds.id);
      byColumn.set(key, entry);
    }
  }

  return Array.from(byColumn.entries()).map(([column, e]) => ({
    term: e.term,
    column: datasets.flatMap((d) => d.columns).find((c) => c.name.toLowerCase() === column)?.name ?? column,
    datasetIds: Array.from(e.datasetIds),
    strength: e.strength,
  }));
}

function mentionedDatasets(question: string, datasets: LinkableDataset[]): string[] {
  const qTokens = questionTokens(question);
  return datasets
    .filter((d) => { const t = datasetTokens(d.name); return t.length > 0 && t.every((x) => x.length >= 4 && qTokens.has(x)); })
    .map((d) => d.id);
}

interface Edge { to: string; leftOn: string; rightOn: string; basis: string; cardinality?: string; score: number }

/** "1:N" seen from the other side is "N:1"; "N:M" and "1:1" are symmetric. */
function flipCardinality(c: string | undefined): string | undefined {
  if (c === "1:N") return "N:1";
  if (c === "N:1") return "1:N";
  return c;
}

function buildGraph(relationships: RelationshipRecord[]): Map<string, Edge[]> {
  const g = new Map<string, Edge[]>();
  const add = (from: string, e: Edge) => (g.get(from) ?? g.set(from, []).get(from)!).push(e);
  for (const r of relationships) {
    // Prefer a same-name key over a value-overlap one, and a key that
    // doesn't fan out both ways over one that does.
    const score = (r.basis === "name" ? 2 : 0) + (r.cardinality && r.cardinality !== "N:M" ? 1 : 0) + r.confidence;
    add(r.datasetIdA, { to: r.datasetIdB, leftOn: r.columnA, rightOn: r.columnB, basis: r.basis, cardinality: r.cardinality, score });
    const flipped = flipCardinality(r.cardinality);
    add(r.datasetIdB, { to: r.datasetIdA, leftOn: r.columnB, rightOn: r.columnA, basis: r.basis, cardinality: flipped, score });
  }
  for (const edges of g.values()) edges.sort((a, b) => b.score - a.score);
  return g;
}

/** Shortest join chain from `from` to `to`, best-scoring edges first. */
export function findJoinPath(from: string, to: string, relationships: RelationshipRecord[]): JoinStep[] | undefined {
  if (from === to) return [];
  const g = buildGraph(relationships);
  const prev = new Map<string, { via: string; edge: Edge }>();
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of g.get(cur) ?? []) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      prev.set(e.to, { via: cur, edge: e });
      if (e.to === to) {
        const path: JoinStep[] = [];
        let node = to;
        while (node !== from) {
          const p = prev.get(node)!;
          path.unshift({ datasetId: node, leftOn: p.edge.leftOn, rightOn: p.edge.rightOn, basis: p.edge.basis, cardinality: p.edge.cardinality });
          node = p.via;
        }
        return path;
      }
      queue.push(e.to);
    }
  }
  return undefined;
}

/**
 * The full link: linked columns, required datasets, a suggested base and
 * the join path that reaches everything from it.
 */
export function linkSchema(question: string, datasets: LinkableDataset[], relationships: RelationshipRecord[]): SchemaLink {
  const columns = linkColumns(question, datasets);
  const mentioned = mentionedDatasets(question, datasets);

  // Two linked columns that a detected relationship connects hold the same
  // values under different names (a "Branch" column and a "branch_name"
  // column, say). Treat them as ONE concept present in both files: neither
  // file can then be declared mandatory on the strength of that concept
  // alone, since forcing the wrong one sends the plan down the wrong path.
  const holdersOf = (c: LinkedColumn): Set<string> => {
    const out = new Set(c.datasetIds);
    for (const r of relationships) {
      const sides = [
        { ds: r.datasetIdA, col: r.columnA, otherDs: r.datasetIdB },
        { ds: r.datasetIdB, col: r.columnB, otherDs: r.datasetIdA },
      ];
      for (const side of sides) {
        // The relationship itself is the evidence that the other file holds
        // the same values — whether or not its column name also linked.
        if (side.col.toLowerCase() === c.column.toLowerCase() && c.datasetIds.includes(side.ds)) out.add(side.otherDs);
      }
    }
    return out;
  };

  // A dataset is required when it is the ONLY holder of a linked concept, or
  // the question names it outright.
  const required = new Set<string>(mentioned);
  for (const c of columns) {
    if (c.strength === "strong" && holdersOf(c).size === 1) required.add(c.datasetIds[0]);
  }

  const byId = new Map(datasets.map((d) => [d.id, d]));
  const requiredIds = Array.from(required);

  // Base: among required datasets, the one holding a linked NUMERIC column
  // (the thing being aggregated); failing that, the one with the most rows —
  // the fact table, whose rows the question is usually counting or summing.
  // `anchor` is where join paths start from; it is only SUGGESTED to the
  // model as the base when there is evidence for it — a linked numeric
  // column to aggregate, or several required datasets that need ordering.
  // A single required lookup-style table ("by region name") is not evidence
  // that it should be the base; the rows being summed usually live elsewhere.
  let anchor: string | undefined;
  let suggestedBaseId: string | undefined;
  if (requiredIds.length > 0) {
    const holdsLinkedNumeric = (id: string) =>
      columns.some((c) => c.datasetIds.includes(id) && byId.get(id)?.columns.some((col) => col.name === c.column && col.type === "number"));
    const numericHolders = requiredIds.filter(holdsLinkedNumeric);
    const pool = numericHolders.length > 0 ? numericHolders : requiredIds;
    anchor = pool.sort((a, b) => (byId.get(b)?.rowCount ?? 0) - (byId.get(a)?.rowCount ?? 0))[0];
    if (numericHolders.length > 0 || requiredIds.length > 1) suggestedBaseId = anchor;
  }

  const joinPath: JoinStep[] = [];
  const unreachable: string[] = [];
  if (anchor) {
    const included = new Set([anchor]);
    for (const target of requiredIds) {
      if (included.has(target)) continue;
      // Reach the target from ANY dataset already on the path, not only the base.
      let best: JoinStep[] | undefined;
      for (const start of included) {
        const p = findJoinPath(start, target, relationships);
        if (p && (!best || p.length < best.length)) best = p;
      }
      if (!best) { unreachable.push(target); continue; }
      for (const step of best) {
        if (included.has(step.datasetId)) continue;
        joinPath.push(step);
        included.add(step.datasetId);
      }
    }
  }

  // A linked column that is the child side of a relationship whose other
  // side is unique points at a lookup table. Offer the join to it.
  const lookupJoins: JoinStep[] = [];
  const onPath = new Set([anchor, ...joinPath.map((j) => j.datasetId)].filter(Boolean) as string[]);
  for (const c of columns) {
    for (const holder of c.datasetIds) {
      if (!onPath.has(holder)) continue;
      for (const r of relationships) {
        const childIsA = r.datasetIdA === holder && r.columnA === c.column;
        const childIsB = r.datasetIdB === holder && r.columnB === c.column;
        if (!childIsA && !childIsB) continue;
        const parent = childIsA ? r.datasetIdB : r.datasetIdA;
        const parentUnique = childIsA ? r.cardinality === "N:1" : r.cardinality === "1:N";
        if (!parentUnique || onPath.has(parent) || lookupJoins.some((l) => l.datasetId === parent)) continue;
        lookupJoins.push({ datasetId: parent, leftOn: c.column, rightOn: childIsA ? r.columnB : r.columnA, basis: r.basis, cardinality: childIsA ? r.cardinality : flipCardinality(r.cardinality) });
      }
    }
  }

  const conceptHolders = new Map(columns.map((c) => [c.column.toLowerCase(), Array.from(holdersOf(c))]));
  return { columns, conceptHolders, lookupJoins, mentionedDatasetIds: mentioned, requiredDatasetIds: requiredIds, suggestedBaseId, joinPath, unreachable };
}

/**
 * Linked columns that the plan cannot reach: they exist only in datasets
 * the plan neither uses as base nor joins. This is provable from the plan
 * and the schema — no guess about what the user meant is involved.
 */
export function unreachableLinkedColumns(link: SchemaLink, planDatasetIds: string[]): LinkedColumn[] {
  const inPlan = new Set(planDatasetIds);
  return link.columns.filter((c) => c.strength === "strong" && !(link.conceptHolders.get(c.column.toLowerCase()) ?? c.datasetIds).some((id) => inPlan.has(id)));
}
