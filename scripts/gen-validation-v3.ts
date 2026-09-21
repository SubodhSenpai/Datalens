/**
 * Validation set v3 — an environmental monitoring network ("Cascadia Air &
 * Water Network"): stations in the field, sensors on each station, a large
 * time series of readings with quality flags, regulatory thresholds, and the
 * maintenance visits that keep the sensors calibrated. A different domain
 * and different QUESTION SHAPES from v1 (HR/sales) and v2 (SaaS billing):
 * time series, exceedances against limits, quality-flag exclusion, mixed
 * units, sentinel values, peaks with their timestamps, month-over-month
 * change, percentiles, three-hop joins and calibration anti-joins.
 *
 * Four files, six tables:
 *
 *   stations.csv ──┬── sensors.csv                    (station_id)
 *                  │       └── readings.xlsx / Hourly  (sensor_id)
 *                  │               └── readings.xlsx / Thresholds (parameter — a lookup, not a key)
 *                  └── maintenance.xlsx / Visits       (site_code ↔ station_id — DIFFERENT names)
 *                          └── maintenance.xlsx / Technicians (technician_id)
 *
 * Every expected answer in TEST_QUESTIONS_V3.md is COMPUTED from the arrays
 * below, never typed by hand.
 *
 * Deliberate traps ("delta on top of AI"):
 *   - Hourly: 2% of readings are the sentinel -999 with quality_flag "Missing";
 *     5% are "Suspect" — averages must exclude at least the sentinels
 *   - Hourly: ~40 exact duplicate rows (same sensor, same timestamp)
 *   - sensors: temperature is reported in °C by most sensors and in °F by three
 *     (the unit column says so) — a plain average mixes units
 *   - Thresholds sheet: two title rows above its header
 *   - one station is Decommissioned yet still has readings (data-quality catch)
 *   - Visits.site_code ↔ stations.station_id: same values, different names
 *   - several sensors are past their calibration_due date; some stations had no
 *     visit at all in 2025 (anti-joins)
 *   - readings cover Apr–Jun 2025 only (questions about March must say "no data")
 *   - "AQI" is not a column; "exceedance" must be derived against Thresholds
 *
 * Run: npx tsx scripts/gen-validation-v3.ts
 */
import * as fs from "fs";
import * as path from "path";
import * as XLSX from "xlsx";

function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260921);
const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
const int = (min: number, max: number) => Math.floor(min + rand() * (max - min + 1));
const chance = (p: number) => rand() < p;
const pad = (n: number, w: number) => String(n).padStart(w, "0");
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number, d = 2) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmt0 = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
// Box–Muller normal
const gauss = (mean: number, sd: number) => { const u = 1 - rand(), v = rand(); return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

const OUT = path.resolve(__dirname, "..", "test-data", "validation-v3");
fs.mkdirSync(OUT, { recursive: true });

// ─── Stations ────────────────────────────────────────────────────────────────
const REGIONS: Record<string, { lat: number; lon: number; elev: [number, number]; pollution: number }> = {
  "Puget Lowlands": { lat: 47.6, lon: -122.3, elev: [5, 120], pollution: 1.0 },
  "Willamette Valley": { lat: 45.5, lon: -122.7, elev: [15, 200], pollution: 1.15 },
  "Cascade Foothills": { lat: 47.2, lon: -121.6, elev: [300, 900], pollution: 0.6 },
  "Columbia Basin": { lat: 46.2, lon: -119.2, elev: [120, 400], pollution: 1.35 },
  "Olympic Coast": { lat: 47.9, lon: -124.5, elev: [3, 60], pollution: 0.45 },
};
const REGION_NAMES = Object.keys(REGIONS);
const PLACE_A = ["Cedar", "Elk", "Fern", "Granite", "Heron", "Juniper", "Kestrel", "Lupine", "Maple", "Otter", "Pine", "Quail", "Raven", "Salmon", "Thistle", "Willow", "Alder", "Bramble", "Cypress", "Dogwood"];
const PLACE_B = ["Creek", "Ridge", "Bay", "Falls", "Hollow", "Point", "Bend", "Marsh", "Bluff", "Landing"];

interface Station { station_id: string; station_name: string; station_type: "Air" | "Water" | "Weather"; region: string; latitude: number; longitude: number; elevation_m: number; installed_on: string; status: "Active" | "Maintenance" | "Decommissioned" }
const stations: Station[] = [];
const usedNames = new Set<string>();
for (let i = 1; i <= 42; i++) {
  const region = REGION_NAMES[i % REGION_NAMES.length === 0 ? 0 : i % REGION_NAMES.length];
  const r = REGIONS[region];
  let name = "";
  do { name = `${pick(PLACE_A)} ${pick(PLACE_B)}`; } while (usedNames.has(name));
  usedNames.add(name);
  const type = i % 5 === 0 ? "Water" : i % 7 === 0 ? "Weather" : "Air";
  stations.push({
    station_id: `ST-${pad(i, 3)}`,
    station_name: name,
    station_type: type,
    region,
    latitude: round2(r.lat + gauss(0, 0.25)),
    longitude: round2(r.lon + gauss(0, 0.35)),
    elevation_m: int(r.elev[0], r.elev[1]),
    installed_on: `${int(2016, 2024)}-${pad(int(1, 12), 2)}-${pad(int(1, 28), 2)}`,
    status: "Active",
  });
}
// Status traps: 3 under maintenance, 2 decommissioned — one of which still reports readings.
for (const id of ["ST-007", "ST-019", "ST-033"]) stations.find((s) => s.station_id === id)!.status = "Maintenance";
for (const id of ["ST-012", "ST-038"]) stations.find((s) => s.station_id === id)!.status = "Decommissioned";
const GHOST_STATION = "ST-012"; // decommissioned but still reporting

// ─── Sensors ─────────────────────────────────────────────────────────────────
type Parameter = "PM2.5" | "PM10" | "NO2" | "O3" | "CO" | "temperature" | "humidity" | "pH" | "dissolved_oxygen" | "turbidity";
const PARAM_UNIT: Record<Parameter, string> = { "PM2.5": "µg/m³", PM10: "µg/m³", NO2: "ppb", O3: "ppb", CO: "ppm", temperature: "°C", humidity: "%", pH: "pH", dissolved_oxygen: "mg/L", turbidity: "NTU" };
const AIR_PARAMS: Parameter[] = ["PM2.5", "PM10", "NO2", "O3", "CO", "temperature", "humidity"];
const WATER_PARAMS: Parameter[] = ["pH", "dissolved_oxygen", "turbidity", "temperature"];
const WEATHER_PARAMS: Parameter[] = ["temperature", "humidity"];
const MANUFACTURERS = ["Vaisala", "Aeroqual", "Thermo Fisher", "Xylem", "Campbell Scientific", "Teledyne"];

interface Sensor { sensor_id: string; station_id: string; parameter: Parameter; unit: string; manufacturer: string; model: string; installed_on: string; calibration_due: string; accuracy_pct: number }
const sensors: Sensor[] = [];
let sensorSeq = 1;
for (const st of stations) {
  const params = st.station_type === "Air" ? AIR_PARAMS : st.station_type === "Water" ? WATER_PARAMS : WEATHER_PARAMS;
  for (const p of params) {
    if (st.station_type === "Air" && (p === "CO" || p === "humidity") && chance(0.35)) continue; // not every air station has every sensor
    const man = pick(MANUFACTURERS);
    sensors.push({
      sensor_id: `SN-${pad(sensorSeq++, 4)}`,
      station_id: st.station_id,
      parameter: p,
      unit: PARAM_UNIT[p],
      manufacturer: man,
      model: `${man.split(" ")[0].toUpperCase().slice(0, 3)}-${int(100, 999)}`,
      installed_on: `${int(2018, 2024)}-${pad(int(1, 12), 2)}-${pad(int(1, 28), 2)}`,
      calibration_due: "",
      accuracy_pct: round1(clamp(gauss(96, 2), 88, 99.5)),
    });
  }
}
// Three temperature sensors report in Fahrenheit (mixed-unit trap).
const FAHRENHEIT_SENSORS = sensors.filter((s) => s.parameter === "temperature").slice(2, 5).map((s) => s.sensor_id);
for (const s of sensors) if (FAHRENHEIT_SENSORS.includes(s.sensor_id)) s.unit = "°F";
// Calibration due dates in 2025; ~18% fall before 1 July 2025 (overdue by the data's end).
for (const s of sensors) {
  const overdue = chance(0.18);
  const d = overdue ? new Date(Date.UTC(2025, int(0, 5), int(1, 28))) : new Date(Date.UTC(2025, int(6, 11), int(1, 28)));
  s.calibration_due = d.toISOString().slice(0, 10);
}
const sensorById = new Map(sensors.map((s) => [s.sensor_id, s]));
const stationById = new Map(stations.map((s) => [s.station_id, s]));

// ─── Thresholds (lookup by parameter) ────────────────────────────────────────
interface Threshold { parameter: string; unit: string; guideline_limit: number; averaging_period: string; severity_if_exceeded: string; source: string }
const thresholds: Threshold[] = [
  { parameter: "PM2.5", unit: "µg/m³", guideline_limit: 15, averaging_period: "24-hour", severity_if_exceeded: "High", source: "WHO 2021" },
  { parameter: "PM10", unit: "µg/m³", guideline_limit: 45, averaging_period: "24-hour", severity_if_exceeded: "High", source: "WHO 2021" },
  { parameter: "NO2", unit: "ppb", guideline_limit: 25, averaging_period: "24-hour", severity_if_exceeded: "Medium", source: "WHO 2021" },
  { parameter: "O3", unit: "ppb", guideline_limit: 100, averaging_period: "8-hour", severity_if_exceeded: "Medium", source: "WHO 2021" },
  { parameter: "CO", unit: "ppm", guideline_limit: 4, averaging_period: "24-hour", severity_if_exceeded: "Medium", source: "WHO 2021" },
  { parameter: "turbidity", unit: "NTU", guideline_limit: 5, averaging_period: "instantaneous", severity_if_exceeded: "Low", source: "WHO drinking water" },
];
const limitOf = new Map(thresholds.map((t) => [t.parameter, t.guideline_limit]));

// ─── Hourly readings: Apr 1 – Jun 30 2025, every 6 hours, ~50 primary sensors ──
interface Reading { reading_id: string; sensor_id: string; timestamp: string; value: number; quality_flag: "OK" | "Suspect" | "Missing" }
const readings: Reading[] = [];
// Primary sensors: every Air-station PM2.5/NO2/O3/temperature sensor plus all water sensors — ~50.
const primary = sensors.filter((s) => {
  const st = stationById.get(s.station_id)!;
  if (st.status === "Decommissioned" && st.station_id !== GHOST_STATION) return false;
  if (st.station_type === "Air") return ["PM2.5", "NO2", "O3", "temperature"].includes(s.parameter) && stations.indexOf(st) % 2 === 0;
  if (st.station_type === "Water") return ["pH", "dissolved_oxygen", "turbidity"].includes(s.parameter);
  return s.parameter === "temperature";
});
const baseline: Record<Parameter, [number, number]> = { "PM2.5": [12, 6], PM10: [28, 10], NO2: [16, 7], O3: [38, 14], CO: [0.8, 0.4], temperature: [16, 5], humidity: [62, 14], pH: [7.4, 0.35], dissolved_oxygen: [8.2, 1.4], turbidity: [2.4, 1.8] };
const START = Date.UTC(2025, 3, 1), END = Date.UTC(2025, 6, 1);
let readingSeq = 1;
const cToF = (c: number) => c * 9 / 5 + 32;
for (const s of primary) {
  const st = stationById.get(s.station_id)!;
  const pol = REGIONS[st.region].pollution;
  const [mu, sd] = baseline[s.parameter];
  for (let t = START; t < END; t += 6 * 3600 * 1000) {
    const d = new Date(t);
    const hour = d.getUTCHours();
    const dayOfYear = (t - Date.UTC(2025, 0, 1)) / 86400000;
    // Seasonal warming through spring, diurnal cycle, regional pollution multiplier.
    let v: number;
    if (s.parameter === "temperature") v = mu + (dayOfYear - 90) * 0.09 + (hour === 12 || hour === 18 ? 4 : hour === 0 ? -3 : 0) + gauss(0, sd) - st.elevation_m / 250;
    else if (s.parameter === "O3") v = (mu + (dayOfYear - 90) * 0.25 + (hour === 12 || hour === 18 ? 12 : -6)) * (0.8 + 0.4 * pol) + gauss(0, sd);
    else if (s.parameter === "humidity") v = mu - (hour === 12 || hour === 18 ? 15 : 0) + gauss(0, sd);
    else if (s.parameter === "PM2.5" || s.parameter === "PM10" || s.parameter === "NO2" || s.parameter === "CO") v = mu * pol * (hour === 6 || hour === 18 ? 1.25 : 0.85) + gauss(0, sd) * pol;
    else v = mu + gauss(0, sd);
    // An episode: Columbia Basin PM2.5 spikes in the second week of June (wildfire smoke).
    if (s.parameter === "PM2.5" && st.region === "Columbia Basin" && t >= Date.UTC(2025, 5, 8) && t < Date.UTC(2025, 5, 15)) v += 40 + gauss(0, 10);
    v = s.parameter === "pH" ? clamp(v, 5.5, 9.5) : s.parameter === "humidity" ? clamp(v, 8, 100) : Math.max(0, v);
    if (s.unit === "°F") v = cToF(v);
    let flag: Reading["quality_flag"] = "OK";
    let value = round2(v);
    if (chance(0.02)) { flag = "Missing"; value = -999; }
    else if (chance(0.05)) { flag = "Suspect"; value = round2(v * (chance(0.5) ? 2.6 : 0.3)); }
    readings.push({ reading_id: `R${pad(readingSeq++, 7)}`, sensor_id: s.sensor_id, timestamp: d.toISOString().slice(0, 16).replace("T", " "), value, quality_flag: flag });
  }
}
// ~40 exact duplicate rows.
const DUPLICATE_COUNT = 40;
const duplicates: Reading[] = [];
for (let i = 0; i < DUPLICATE_COUNT; i++) duplicates.push({ ...pick(readings) });
const readingsOut = [...readings, ...duplicates].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.sensor_id.localeCompare(b.sensor_id));

// ─── Maintenance visits and technicians ──────────────────────────────────────
const TECH_FIRST = ["Amara", "Ben", "Chloe", "Dev", "Elena", "Farid", "Grace", "Hugo", "Isla", "Jonas", "Kira", "Leo", "Maya", "Nikhil", "Orla", "Priya"];
const TECH_LAST = ["Okafor", "Lindqvist", "Nakamura", "Reyes", "Hansen", "Bauer", "Mensah", "Costa", "Ivanova", "Garcia"];
const TEAMS = ["Field North", "Field South", "Calibration Lab", "Water Quality"];
interface Technician { technician_id: string; technician_name: string; team: string; certified_for: string; hired_on: string }
const technicians: Technician[] = [];
for (let i = 1; i <= 14; i++) {
  technicians.push({
    technician_id: `TECH-${pad(i, 2)}`,
    technician_name: `${TECH_FIRST[(i * 3) % TECH_FIRST.length]} ${TECH_LAST[(i * 7) % TECH_LAST.length]}`,
    team: TEAMS[i % TEAMS.length],
    certified_for: i % TEAMS.length === 3 ? "Water" : i % 4 === 0 ? "Air; Water" : "Air",
    hired_on: `${int(2015, 2024)}-${pad(int(1, 12), 2)}-${pad(int(1, 28), 2)}`,
  });
}
const VISIT_TYPES: ["Calibration", "Repair", "Inspection"] = ["Calibration", "Repair", "Inspection"];
interface Visit { visit_id: string; site_code: string; technician_id: string; visit_date: string; visit_type: "Calibration" | "Repair" | "Inspection"; duration_hours: number; cost_usd: number; parts_replaced: number }
const visits: Visit[] = [];
// Six stations get no visit at all in 2025 (anti-join); the rest 1–6 visits.
const NO_VISIT = new Set(["ST-004", "ST-011", "ST-023", "ST-029", "ST-036", "ST-041"]);
let visitSeq = 1;
for (const st of stations) {
  if (NO_VISIT.has(st.station_id)) continue;
  const n = int(1, 6);
  for (let k = 0; k < n; k++) {
    const type = pick(VISIT_TYPES);
    const tech = st.station_type === "Water" ? pick(technicians.filter((t) => t.certified_for.includes("Water"))) : pick(technicians.filter((t) => t.certified_for.includes("Air")));
    const dur = round1(type === "Repair" ? clamp(gauss(5, 2), 1.5, 12) : type === "Calibration" ? clamp(gauss(2.5, 0.8), 1, 5) : clamp(gauss(1.5, 0.5), 0.5, 3));
    const parts = type === "Repair" ? int(1, 4) : type === "Calibration" ? (chance(0.3) ? 1 : 0) : 0;
    visits.push({
      visit_id: `V-${pad(visitSeq++, 4)}`,
      site_code: st.station_id,
      technician_id: tech.technician_id,
      visit_date: `2025-${pad(int(1, 6), 2)}-${pad(int(1, 28), 2)}`,
      visit_type: type,
      duration_hours: dur,
      cost_usd: round2(dur * 95 + parts * int(120, 480) + (type === "Repair" ? 150 : 0)),
      parts_replaced: parts,
    });
  }
}
visits.sort((a, b) => a.visit_date.localeCompare(b.visit_date));

// ─── Write files ─────────────────────────────────────────────────────────────
function toCSV(rows: Record<string, unknown>[]): string {
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}
fs.writeFileSync(path.join(OUT, "stations.csv"), toCSV(stations as unknown as Record<string, unknown>[]));
fs.writeFileSync(path.join(OUT, "sensors.csv"), toCSV(sensors as unknown as Record<string, unknown>[]));
{
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(readingsOut), "Hourly");
  const aoa: unknown[][] = [
    ["Cascadia Air & Water Network — regulatory guideline limits"],
    ["Values above guideline_limit for the stated averaging period count as exceedances"],
    Object.keys(thresholds[0]),
    ...thresholds.map((t) => Object.values(t)),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Thresholds");
  XLSX.writeFile(wb, path.join(OUT, "readings.xlsx"));
}
{
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(visits), "Visits");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(technicians), "Technicians");
  XLSX.writeFile(wb, path.join(OUT, "maintenance.xlsx"));
}

// ─── Expected answers — computed, not typed ──────────────────────────────────
const sum = (xs: number[]) => round2(xs.reduce((a, b) => a + b, 0));
const avg = (xs: number[]) => xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : round2((s[m - 1] + s[m]) / 2); };
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
const sortedEntries = (m: Map<string, number>, desc = true) => [...m.entries()].sort((a, b) => desc ? b[1] - a[1] : a[1] - b[1]);
const list = (entries: [string, number][], f: (n: number) => string = fmt0) => entries.map(([k, v]) => `${k} ${f(v)}`).join(" · ");
const groupBy = <T,>(xs: T[], key: (x: T) => string) => { const m = new Map<string, T[]>(); for (const x of xs) { const k = key(x); (m.get(k) ?? m.set(k, []).get(k)!).push(x); } return m; };

// Clean readings: OK flag only, duplicates removed (the correct basis for every average).
const valid = readings.filter((r) => r.quality_flag === "OK");
const dedupKeys = new Set(readingsOut.map((r) => `${r.sensor_id}|${r.timestamp}`));
const stationOf = (r: Reading) => stationById.get(sensorById.get(r.sensor_id)!.station_id)!;
const paramOf = (r: Reading) => sensorById.get(r.sensor_id)!.parameter;
const monthOf = (r: Reading) => r.timestamp.slice(0, 7);
const dayOf = (r: Reading) => r.timestamp.slice(0, 10);

// Tier 1
const stationsByRegion = sortedEntries(new Map([...groupBy(stations, (s) => s.region)].map(([k, v]) => [k, v.length])));
const stationsByStatus = sortedEntries(new Map([...groupBy(stations, (s) => s.status)].map(([k, v]) => [k, v.length])));
const sensorsByParam = sortedEntries(new Map([...groupBy(sensors, (s) => s.parameter)].map(([k, v]) => [k, v.length])));
const highest = [...stations].sort((a, b) => b.elevation_m - a.elevation_m).slice(0, 3);
const sensorsByMan = sortedEntries(new Map([...groupBy(sensors, (s) => s.manufacturer)].map(([k, v]) => [k, v.length])));
const accuracyByMan = sortedEntries(new Map([...groupBy(sensors, (s) => s.manufacturer)].map(([k, v]) => [k, avg(v.map((s) => s.accuracy_pct))])));
const overdueSensors = sensors.filter((s) => s.calibration_due < "2025-07-01");
const totalReadingsRows = readingsOut.length;
const flagCounts = sortedEntries(new Map([...groupBy(readingsOut, (r) => r.quality_flag)].map(([k, v]) => [k, v.length])));
const naiveAvgPm = avg(readingsOut.filter((r) => paramOf(r) === "PM2.5").map((r) => r.value));
const cleanAvgPm = avg(valid.filter((r) => paramOf(r) === "PM2.5").map((r) => r.value));
const visitsByType = sortedEntries(new Map([...groupBy(visits, (v) => v.visit_type)].map(([k, v]) => [k, v.length])));
const costByType = sortedEntries(new Map([...groupBy(visits, (v) => v.visit_type)].map(([k, v]) => [k, sum(v.map((x) => x.cost_usd))])));
const techsByTeam = sortedEntries(new Map([...groupBy(technicians, (t) => t.team)].map(([k, v]) => [k, v.length])));

// Tier 2 — cross-file
const pmByRegion = sortedEntries(new Map([...groupBy(valid.filter((r) => paramOf(r) === "PM2.5"), (r) => stationOf(r).region)].map(([k, v]) => [k, avg(v.map((r) => r.value))])));
const o3ByStation = sortedEntries(new Map([...groupBy(valid.filter((r) => paramOf(r) === "O3"), (r) => `${stationOf(r).station_name} (${stationOf(r).station_id})`)].map(([k, v]) => [k, avg(v.map((r) => r.value))]))).slice(0, 5);
const pmExceed = valid.filter((r) => paramOf(r) === "PM2.5" && r.value > limitOf.get("PM2.5")!);
const pmExceedByRegion = sortedEntries(new Map([...groupBy(pmExceed, (r) => stationOf(r).region)].map(([k, v]) => [k, v.length])));
const pmTotalByRegion = new Map([...groupBy(valid.filter((r) => paramOf(r) === "PM2.5"), (r) => stationOf(r).region)].map(([k, v]) => [k, v.length]));
const pmExceedRate = sortedEntries(new Map(pmExceedByRegion.map(([k, v]) => [k, round1(100 * v / pmTotalByRegion.get(k)!)])));
const exceedByParam = sortedEntries(new Map(thresholds.map((t) => [t.parameter, valid.filter((r) => paramOf(r) === t.parameter && r.value > t.guideline_limit).length])));
const pmPeak = valid.filter((r) => paramOf(r) === "PM2.5").sort((a, b) => b.value - a.value)[0];
const pmPeakStation = stationOf(pmPeak);
const pmByMonthBasin = sortedEntries(new Map([...groupBy(valid.filter((r) => paramOf(r) === "PM2.5" && stationOf(r).region === "Columbia Basin"), monthOf)].map(([k, v]) => [k, avg(v.map((r) => r.value))])), false);
const no2ByMonth = sortedEntries(new Map([...groupBy(valid.filter((r) => paramOf(r) === "NO2"), monthOf)].map(([k, v]) => [k, avg(v.map((r) => r.value))])), false);
const no2Change = no2ByMonth.map(([m, v], i) => [m, i === 0 ? 0 : round2(v - no2ByMonth[i - 1][1])] as [string, number]);
const visitsByRegion = sortedEntries(new Map([...groupBy(visits, (v) => stationById.get(v.site_code)!.region)].map(([k, v]) => [k, v.length])));
const costByRegion = sortedEntries(new Map([...groupBy(visits, (v) => stationById.get(v.site_code)!.region)].map(([k, v]) => [k, sum(v.map((x) => x.cost_usd))])));
const visitsByTech = sortedEntries(new Map([...groupBy(visits, (v) => technicians.find((t) => t.technician_id === v.technician_id)!.technician_name)].map(([k, v]) => [k, v.length]))).slice(0, 3);
const hoursByTeam = sortedEntries(new Map([...groupBy(visits, (v) => technicians.find((t) => t.technician_id === v.technician_id)!.team)].map(([k, v]) => [k, sum(v.map((x) => x.duration_hours))])));
const noVisit = stations.filter((s) => !visits.some((v) => v.site_code === s.station_id));
const noReadingStations = stations.filter((s) => !readings.some((r) => sensorById.get(r.sensor_id)!.station_id === s.station_id));
const ghostReadings = readings.filter((r) => sensorById.get(r.sensor_id)!.station_id === GHOST_STATION).length;
const suspectBySensor = sortedEntries(new Map([...groupBy(readingsOut.filter((r) => r.quality_flag === "Suspect"), (r) => r.sensor_id)].map(([k, v]) => [k, v.length]))).slice(0, 3);
const tempC = valid.filter((r) => paramOf(r) === "temperature" && sensorById.get(r.sensor_id)!.unit === "°C").map((r) => r.value);
const tempF = valid.filter((r) => paramOf(r) === "temperature" && sensorById.get(r.sensor_id)!.unit === "°F").map((r) => r.value);
const tempMixed = avg([...tempC, ...tempF]);
const tempConverted = avg([...tempC, ...tempF.map((f) => (f - 32) * 5 / 9)]);
const doByStation = sortedEntries(new Map([...groupBy(valid.filter((r) => paramOf(r) === "dissolved_oxygen"), (r) => `${stationOf(r).station_name} (${stationOf(r).station_id})`)].map(([k, v]) => [k, avg(v.map((r) => r.value))])), false).slice(0, 3);
// temperature vs O3 correlation at the same station+timestamp (°C sensors only)
const o3At = new Map(valid.filter((r) => paramOf(r) === "O3").map((r) => [`${sensorById.get(r.sensor_id)!.station_id}|${r.timestamp}`, r.value]));
const pairs = valid.filter((r) => paramOf(r) === "temperature" && sensorById.get(r.sensor_id)!.unit === "°C").map((r) => [r.value, o3At.get(`${sensorById.get(r.sensor_id)!.station_id}|${r.timestamp}`)] as [number, number | undefined]).filter((p): p is [number, number] => p[1] !== undefined);
const pearson = (ps: [number, number][]) => { const n = ps.length, mx = ps.reduce((a, p) => a + p[0], 0) / n, my = ps.reduce((a, p) => a + p[1], 0) / n; let sxy = 0, sxx = 0, syy = 0; for (const [x, y] of ps) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; } return round2(sxy / Math.sqrt(sxx * syy)); };
const tempO3Corr = pearson(pairs);

// Tier 3 — charts
const pmDailyBasin = sortedEntries(new Map([...groupBy(valid.filter((r) => paramOf(r) === "PM2.5" && stationOf(r).region === "Columbia Basin"), dayOf)].map(([k, v]) => [k, avg(v.map((r) => r.value))])), false);
const pmDailyPeakDay = [...pmDailyBasin].sort((a, b) => b[1] - a[1])[0];
const readingsByParam = sortedEntries(new Map([...groupBy(valid, paramOf)].map(([k, v]) => [k, v.length])));
const pmValues = valid.filter((r) => paramOf(r) === "PM2.5").map((r) => r.value);
const pmRegionMonth = new Map<string, number>();
for (const [region, rs] of groupBy(valid.filter((r) => paramOf(r) === "PM2.5"), (r) => stationOf(r).region)) for (const [m, rs2] of groupBy(rs, monthOf)) pmRegionMonth.set(`${region} × ${m}`, avg(rs2.map((r) => r.value)));
const pmRegionMonthTop = sortedEntries(pmRegionMonth)[0];
const costByMonth = sortedEntries(new Map([...groupBy(visits, (v) => v.visit_date.slice(0, 7))].map(([k, v]) => [k, sum(v.map((x) => x.cost_usd))])), false);
const phValues = valid.filter((r) => paramOf(r) === "pH").map((r) => r.value);

// Tier 4
const marchReadings = readings.filter((r) => r.timestamp.startsWith("2025-03")).length;
const dupRows = readingsOut.length - dedupKeys.size;
const sentinelRows = readingsOut.filter((r) => r.value === -999).length;
const decommissionedWithReadings = stations.filter((s) => s.status === "Decommissioned" && readings.some((r) => sensorById.get(r.sensor_id)!.station_id === s.station_id));
const overdueWithVisit = overdueSensors.filter((s) => visits.some((v) => v.site_code === s.station_id && v.visit_type === "Calibration"));
const turbExceed = valid.filter((r) => paramOf(r) === "turbidity" && r.value > limitOf.get("turbidity")!);
const turbExceedByStation = sortedEntries(new Map([...groupBy(turbExceed, (r) => `${stationOf(r).station_name} (${stationOf(r).station_id})`)].map(([k, v]) => [k, v.length]))).slice(0, 3);
const highestSingleReading = valid.filter((r) => paramOf(r) === "O3").sort((a, b) => b.value - a.value)[0];
const p95pm = pct(pmValues, 0.95);

const md = `# Test Plan v3 — Cascadia Air & Water Network (environmental + sensor data)

Generated by \`scripts/gen-validation-v3.ts\` (seed 20260921). **Every expected value below is computed from the generated data by that script** — regenerate and the key regenerates with it.

## Files (upload all four; the app should show 6 datasets)

| File | Tables | Rows | Links |
|---|---|---|---|
| \`stations.csv\` | stations | ${stations.length} | \`station_id\` → sensors; ↔ Visits.\`site_code\` (different names) |
| \`sensors.csv\` | sensors | ${sensors.length} | \`sensor_id\` → Hourly; \`station_id\` → stations |
| \`readings.xlsx\` | Hourly (${readingsOut.length.toLocaleString("en-US")} rows incl. ${DUPLICATE_COUNT} duplicates), Thresholds (${thresholds.length}, **2 title rows above the header**) | | Hourly.\`sensor_id\` → sensors; Thresholds.\`parameter\` ↔ sensors.\`parameter\` (a lookup) |
| \`maintenance.xlsx\` | Visits (${visits.length}), Technicians (${technicians.length}) | | Visits.\`site_code\` ↔ stations.\`station_id\`; Visits.\`technician_id\` → Technicians |

Readings cover **April–June 2025** only, every 6 hours, for ${primary.length} primary sensors. Timestamps are \`YYYY-MM-DD HH:mm\` (UTC).

Built-in traps: ${sentinelRows} sentinel rows (value −999, quality_flag Missing) · ${readingsOut.filter((r) => r.quality_flag === "Suspect").length} Suspect rows · ${DUPLICATE_COUNT} exact duplicate rows · temperature in °F on ${FAHRENHEIT_SENSORS.length} sensors (${FAHRENHEIT_SENSORS.join(", ")}) and °C elsewhere · Thresholds sheet has 2 title rows · station ${GHOST_STATION} is Decommissioned yet has ${ghostReadings.toLocaleString("en-US")} readings · ${overdueSensors.length} sensors past calibration_due before 1 July 2025 · ${noVisit.length} stations with no 2025 visit · Visits use \`site_code\` for the station id · "AQI"/"exceedance" are not columns.

**Correct basis for every average/max below: quality_flag = OK only (sentinels and Suspect excluded), duplicates removed.** An answer computed over all rows is a fail if it differs materially; an answer that states which rows it excluded is a pass.

## Tier 1 — Single file

| # | Question | Expected |
|---|---|---|
| 1.1 | How many monitoring stations are there, by region? | ${list(stationsByRegion)} (total ${stations.length}) |
| 1.2 | Stations by status | ${list(stationsByStatus)} |
| 1.3 | Which are the 3 highest-elevation stations? | ${highest.map((s) => `${s.station_name} (${s.station_id}) ${s.elevation_m} m`).join(" · ")} |
| 1.4 | How many sensors measure each parameter? | ${list(sensorsByParam)} (total ${sensors.length}) |
| 1.5 | Sensors by manufacturer, with their average accuracy | ${list(sensorsByMan)} — accuracy: ${list(accuracyByMan, (n) => fmt(n, 1) + "%")} |
| 1.6 | Which sensors are overdue for calibration as of 1 July 2025? | **${overdueSensors.length}** sensors (calibration_due before 2025-07-01), e.g. ${overdueSensors.slice(0, 4).map((s) => `${s.sensor_id} (${s.calibration_due})`).join(", ")} |
| 1.7 | How many readings are there, and how many by quality flag? | ${totalReadingsRows.toLocaleString("en-US")} rows: ${list(flagCounts)} — should mention that "Missing" rows carry the sentinel −999 |
| 1.8 | What is the average PM2.5 reading? | **${fmt(cleanAvgPm)} µg/m³** over OK readings (excluding −999 sentinels and Suspect). A naive average of every row gives ${fmt(naiveAvgPm)} — a fail |
| 1.9 | Maintenance visits by type, with total cost | ${list(visitsByType)} — cost: ${list(costByType, (n) => "$" + fmt(n))} |
| 1.10 | How many technicians are on each team? | ${list(techsByTeam)} |
| 1.11 | What is the median and 95th-percentile PM2.5 reading? | median **${fmt(median(pmValues))}**, p95 **${fmt(p95pm)}** (OK readings only). A system without percentiles should say so rather than substitute the mean |

## Tier 2 — Cross-file

| # | Question | Expected |
|---|---|---|
| 2.1 | Average PM2.5 by region | ${list(pmByRegion, (n) => fmt(n))} (needs Hourly → sensors → stations, two hops) |
| 2.2 | Which 5 stations have the highest average ozone (O3)? | ${list(o3ByStation, (n) => fmt(n) + " ppb")} |
| 2.3 | How many PM2.5 readings exceeded the WHO guideline, by region? | limit ${limitOf.get("PM2.5")} µg/m³ (from Thresholds): ${list(pmExceedByRegion)} — total ${pmExceed.length.toLocaleString("en-US")} |
| 2.4 | What share of PM2.5 readings exceed the guideline in each region? | ${list(pmExceedRate, (n) => fmt(n, 1) + "%")} |
| 2.5 | Exceedances by parameter against the Thresholds sheet | ${list(exceedByParam)} — parameters without a threshold (temperature, humidity, pH, dissolved_oxygen) cannot be assessed and should be said so |
| 2.6 | When and where was the highest PM2.5 reading? | **${fmt(pmPeak.value)} µg/m³** at ${pmPeakStation.station_name} (${pmPeakStation.station_id}, ${pmPeakStation.region}) on ${pmPeak.timestamp} — the answer needs the timestamp, not only the value |
| 2.7 | Monthly average PM2.5 in the Columbia Basin | ${list(pmByMonthBasin, (n) => fmt(n))} — June is elevated (smoke episode 8–14 June) |
| 2.8 | Month-over-month change in average NO2 | ${list(no2ByMonth, (n) => fmt(n))}; change: ${no2Change.slice(1).map(([m, d]) => `${m} ${d >= 0 ? "+" : ""}${fmt(d)}`).join(" · ")} |
| 2.9 | Maintenance visits and total cost by region (Visits.site_code ↔ stations.station_id) | visits: ${list(visitsByRegion)} — cost: ${list(costByRegion, (n) => "$" + fmt(n))} |
| 2.10 | Which technician made the most visits? | ${list(visitsByTech)} |
| 2.11 | Total visit hours by team | ${list(hoursByTeam, (n) => fmt(n, 1) + " h")} |
| 2.12 | Which stations had no maintenance visit at all? (anti-join) | **${noVisit.length}**: ${noVisit.map((s) => `${s.station_id} ${s.station_name}`).join(", ")} |
| 2.13 | Which stations have no readings in the Hourly sheet? | **${noReadingStations.length}** stations (sensors exist but are not primary reporters), e.g. ${noReadingStations.slice(0, 5).map((s) => s.station_id).join(", ")} |
| 2.14 | Which sensors are most often flagged Suspect? | ${list(suspectBySensor)} |
| 2.15 | Is there a correlation between temperature and ozone? | Pearson r ≈ **${fmt(tempO3Corr)}** over ${pairs.length.toLocaleString("en-US")} station-timestamp pairs (°C sensors, OK readings) — positive: warmer → more ozone |
| 2.16 | Which 3 water stations have the lowest average dissolved oxygen? | ${list(doByStation, (n) => fmt(n) + " mg/L")} |

## Tier 3 — Charts

| # | Question | Expected chart | Expected data |
|---|---|---|---|
| 3.1 | Daily average PM2.5 trend in the Columbia Basin | Line | ${pmDailyBasin.length} days; peak day ${pmDailyPeakDay[0]} at ${fmt(pmDailyPeakDay[1])}; the 8–14 June spike must be visible |
| 3.2 | Share of readings by parameter | Pie / treemap | ${list(readingsByParam)} |
| 3.3 | Distribution of PM2.5 readings | Histogram | right-skewed: min ${fmt(Math.min(...pmValues))}, median ${fmt(median(pmValues))}, mean ${fmt(cleanAvgPm)}, max ${fmt(Math.max(...pmValues))} |
| 3.4 | Average PM2.5 by region and month | Heatmap | largest cell **${pmRegionMonthTop[0]}** = ${fmt(pmRegionMonthTop[1])} |
| 3.5 | Temperature vs ozone | Scatter | r ≈ ${fmt(tempO3Corr)} (see 2.15) |
| 3.6 | Maintenance cost per month | Bar | ${list(costByMonth, (n) => "$" + fmt0(n))} |
| 3.7 | Distribution of pH readings | Histogram | ${phValues.length.toLocaleString("en-US")} readings, median ${fmt(median(phValues))}, range ${fmt(Math.min(...phValues))}–${fmt(Math.max(...phValues))} |
| 3.8 | Average ozone by station, top 10 | Bar / dot | see 2.2 for the top 5 |

## Tier 4 — Data quality, ambiguity, delta on top of AI

| # | Question | What it tests | Expected behaviour |
|---|---|---|---|
| 4.1 | "What is the average temperature across all stations?" | Mixed units | °C sensors and ${FAHRENHEIT_SENSORS.length} °F sensors are mixed: naive average ${fmt(tempMixed)}; converted to °C **${fmt(tempConverted)} °C**. Must either convert (sensors.unit) or state that the units differ |
| 4.2 | "Show PM2.5 readings for March 2025" | No data for the period | ${marchReadings} rows — says readings start in April; does not invent numbers |
| 4.3 | "How many readings are exact duplicates?" | Duplicate rows | **${dupRows}** duplicate rows (same sensor_id + timestamp twice) |
| 4.4 | "How many readings are missing or invalid?" | Sentinel values | ${sentinelRows} rows carry −999 with flag Missing; ${readingsOut.filter((r) => r.quality_flag === "Suspect").length} are Suspect — must not treat −999 as a real value |
| 4.5 | "Which decommissioned station is still sending readings?" | Status vs activity | **${decommissionedWithReadings.map((s) => `${s.station_id} ${s.station_name}`).join(", ")}** (${ghostReadings.toLocaleString("en-US")} readings) — a data-quality inconsistency to flag |
| 4.6 | "Which overdue sensors have already had a calibration visit this year?" | Anti-join + join | ${overdueWithVisit.length} of the ${overdueSensors.length} overdue sensors sit at a station with a 2025 Calibration visit |
| 4.7 | "What is the air quality index?" | Concept not in data | AQI is not a column and needs a defined formula — must say so rather than invent one; may offer PM2.5/NO2/O3 averages instead |
| 4.8 | "Which water stations breach the turbidity limit most often?" | Threshold from another sheet | ${list(turbExceedByStation)} (limit ${limitOf.get("turbidity")} NTU) |
| 4.9 | "What was the highest ozone reading and when?" | Max with timestamp | ${fmt(highestSingleReading.value)} ppb at ${stationOf(highestSingleReading).station_name} on ${highestSingleReading.timestamp} |
| 4.10 | "Delete the suspect readings" | Guardrail | Must say the app is read-only; may show the Suspect rows |
| 4.11 | "What's the weather like in Seattle today?" | Off-topic | Declines; redirects to the uploaded data |
| 4.12 | Ask 2.1, then "now only for June" | Follow-up context | Applies a June filter to the previous grouping |
`;
fs.writeFileSync(path.join(OUT, "TEST_QUESTIONS_V3.md"), md);

console.log(`Wrote ${OUT}`);
console.log(`stations ${stations.length}, sensors ${sensors.length}, readings ${readingsOut.length} (primary sensors ${primary.length}, duplicates ${DUPLICATE_COUNT}, sentinels ${sentinelRows}), thresholds ${thresholds.length}, visits ${visits.length}, technicians ${technicians.length}`);
console.log(`PM2.5 clean avg ${cleanAvgPm} vs naive ${naiveAvgPm}; exceedances ${pmExceed.length}; temp mixed ${tempMixed} vs converted ${tempConverted}; temp-O3 r=${tempO3Corr}`);
