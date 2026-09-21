import type { ColumnSchema, DatasetFile, DatasetLink } from "./types";

/**
 * A plain-language description of one uploaded file, so the user can see
 * what the system will be answering FROM before asking anything: how big it
 * is, what identifies a row, what period it covers, which categories and
 * ranges it holds, what it links to, and anything the parser changed.
 *
 * Built entirely from the column profile computed at upload — no model call
 * — so it is the same on every load and never invents a fact about the data.
 */
export interface DatasetSummary {
  /** One line, for the collapsed card: "1,200 rows · keyed by member_id · Jan 2024 – Jun 2024". */
  headline: string;
  /** Fuller facts, one per line, for the expanded card. */
  facts: string[];
  /** Parser notes (a summary row excluded, etc.) — shown as warnings. */
  notes: string[];
}

const isKeyName = (name: string) => /(^|_)(id|key|code|no|number)$/i.test(name) || /^id$/i.test(name);

function fmtNum(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
}

function list(values: string[], max = 6): string {
  return values.length <= max ? values.join(", ") : `${values.slice(0, max).join(", ")} +${values.length - max} more`;
}

export function summarizeDataset(ds: DatasetFile, all: DatasetFile[], links: DatasetLink[] = []): DatasetSummary {
  const cols = ds.columns;
  const facts: string[] = [];

  // What a row is: the first unique column that looks like an identifier,
  // else any unique column.
  const key = cols.find((c) => c.isUnique && isKeyName(c.name)) ?? cols.find((c) => c.isUnique && c.type !== "number" && c.distinctCount === ds.rowCount);
  const size = `${ds.rowCount.toLocaleString()} rows × ${ds.columnCount} columns${ds.sheetName ? ` (sheet "${ds.sheetName}")` : ""}`;
  facts.push(key ? `${size} — one row per ${key.name}` : size);

  // An id column that is ALMOST unique is worth flagging: a handful of
  // duplicate rows is usually a data-quality issue, and it is why the file
  // is not treated as a lookup table.
  if (!key && ds.rowCount > 0) {
    const nearKey = cols.find((c) => isKeyName(c.name) && typeof c.distinctCount === "number" && c.distinctCount < ds.rowCount && c.distinctCount >= ds.rowCount * 0.9 && (c.nullCount ?? 0) === 0);
    if (nearKey) {
      const dups = ds.rowCount - nearKey.distinctCount!;
      facts.push(`${nearKey.name} repeats in ${dups} row${dups > 1 ? "s" : ""} (${nearKey.distinctCount!.toLocaleString()} distinct of ${ds.rowCount.toLocaleString()}) — duplicates, not one row per ${nearKey.name}`);
    }
  }

  // Period covered, from date columns.
  const dates = cols.filter((c): c is ColumnSchema & { min: string; max: string } => c.type === "date" && typeof c.min === "string" && typeof c.max === "string");
  for (const d of dates.slice(0, 2)) {
    facts.push(d.min === d.max ? `${d.name}: all on ${d.min}` : `${d.name}: ${d.min} to ${d.max}`);
  }

  // Vocabulary of the categorical columns — the values a question can filter on.
  const categorical = cols.filter((c) => c.distinctValues && c.distinctValues.length >= 2 && !c.isUnique);
  for (const c of categorical.slice(0, 4)) facts.push(`${c.name}: ${list(c.distinctValues!)}`);

  // Ranges of the numeric measures (id-like numbers are not measures).
  const numeric = cols.filter((c) => c.type === "number" && typeof c.min === "number" && typeof c.max === "number" && !c.isUnique && !isKeyName(c.name));
  for (const c of numeric.slice(0, 4)) facts.push(`${c.name}: ${fmtNum(c.min as number)} to ${fmtNum(c.max as number)}`);

  // Blank cells worth knowing about before averaging.
  const gappy = cols.filter((c) => (c.nullCount ?? 0) > 0 && ds.rowCount > 0 && (c.nullCount! / ds.rowCount) >= 0.05);
  if (gappy.length) facts.push(`Blank in ≥5% of rows: ${list(gappy.map((c) => `${c.name} (${Math.round((c.nullCount! / ds.rowCount) * 100)}%)`), 4)}`);

  // What it joins to.
  const nameOf = (id: string) => all.find((d) => d.id === id)?.name ?? id;
  const mine = links.filter((l) => l.datasetIdA === ds.id || l.datasetIdB === ds.id);
  const seen = new Set<string>();
  const joins: string[] = [];
  for (const l of mine) {
    const otherId = l.datasetIdA === ds.id ? l.datasetIdB : l.datasetIdA;
    const myCol = l.datasetIdA === ds.id ? l.columnA : l.columnB;
    const theirCol = l.datasetIdA === ds.id ? l.columnB : l.columnA;
    const k = `${otherId}|${myCol}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const via = myCol === theirCol ? myCol : `${myCol} → ${theirCol}`;
    // Cardinality is stored from A's point of view; flip it when we are B.
    const card = l.cardinality && l.datasetIdA !== ds.id ? ({ "1:N": "N:1", "N:1": "1:N" } as Record<string, string>)[l.cardinality] ?? l.cardinality : l.cardinality;
    const how = card === "N:1" ? "each row looks up one row in" : card === "1:N" ? "each row has many rows in" : card === "1:1" ? "one-to-one with" : "many-to-many with";
    joins.push(`${how} ${nameOf(otherId)} via ${via}`);
  }
  if (joins.length) facts.push(`Links: ${joins.join("; ")}`);
  else if (all.length > 1) facts.push("No link to any other file detected — questions combining it with another file cannot be joined automatically.");

  const headlineParts = [
    `${ds.rowCount.toLocaleString()} rows`,
    key ? `keyed by ${key.name}` : null,
    dates[0] ? `${fmtDate(dates[0].min)} – ${fmtDate(dates[0].max)}` : null,
    joins.length ? `links to ${joins.length} file${joins.length > 1 ? "s" : ""}` : null,
  ].filter((p): p is string => Boolean(p));

  return { headline: headlineParts.join(" · "), facts, notes: ds.notes ?? [] };
}
