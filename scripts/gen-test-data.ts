import * as fs from "fs";
import * as path from "path";
import * as XLSX from "xlsx";

// Deterministic PRNG (mulberry32) so the generated datasets are reproducible.
function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);
const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
const int = (min: number, max: number) => Math.floor(min + rand() * (max - min + 1));
const float = (min: number, max: number, decimals = 2) => Number((min + rand() * (max - min)).toFixed(decimals));
const bool = (pTrue = 0.5) => rand() < pTrue;
const dateBetween = (start: string, end: string) => {
  const s = new Date(start).getTime(), e = new Date(end).getTime();
  return new Date(s + rand() * (e - s)).toISOString().slice(0, 10);
};

const OUT_ROOT = path.resolve(__dirname, "..", "..", "test-data");
const CSV_DIR = path.join(OUT_ROOT, "csv");
const XLSX_DIR = path.join(OUT_ROOT, "xlsx");
fs.mkdirSync(CSV_DIR, { recursive: true });
fs.mkdirSync(XLSX_DIR, { recursive: true });

// ─── Shared reference pools (real-world names, not fabricated categories) ──

const COUNTRIES = ["USA", "Germany", "India", "China", "Brazil", "United Kingdom", "France", "Japan", "Canada", "Australia", "Mexico", "South Africa", "Nigeria", "Indonesia", "South Korea"];
const CITIES_BY_COUNTRY: Record<string, string[]> = {
  USA: ["New York", "Chicago", "Los Angeles", "Houston", "Phoenix"],
  Germany: ["Berlin", "Munich", "Hamburg", "Frankfurt", "Cologne"],
  India: ["Mumbai", "Delhi", "Bangalore", "Chennai", "Hyderabad"],
  China: ["Shanghai", "Beijing", "Shenzhen", "Guangzhou", "Chengdu"],
  Brazil: ["Sao Paulo", "Rio de Janeiro", "Brasilia", "Salvador", "Fortaleza"],
  "United Kingdom": ["London", "Manchester", "Birmingham", "Leeds", "Glasgow"],
  France: ["Paris", "Marseille", "Lyon", "Toulouse", "Nice"],
  Japan: ["Tokyo", "Osaka", "Yokohama", "Nagoya", "Sapporo"],
  Canada: ["Toronto", "Vancouver", "Montreal", "Calgary", "Ottawa"],
  Australia: ["Sydney", "Melbourne", "Brisbane", "Perth", "Adelaide"],
  Mexico: ["Mexico City", "Guadalajara", "Monterrey", "Puebla", "Tijuana"],
  "South Africa": ["Johannesburg", "Cape Town", "Durban", "Pretoria", "Bloemfontein"],
  Nigeria: ["Lagos", "Abuja", "Kano", "Ibadan", "Port Harcourt"],
  Indonesia: ["Jakarta", "Surabaya", "Bandung", "Medan", "Semarang"],
  "South Korea": ["Seoul", "Busan", "Incheon", "Daegu", "Daejeon"],
};
const FIRST_NAMES = ["James", "Mary", "Robert", "Patricia", "John", "Jennifer", "Michael", "Linda", "David", "Elizabeth", "Wei", "Priya", "Carlos", "Fatima", "Yuki", "Ahmed", "Olga", "Chen", "Amara", "Lucas"];
const LAST_NAMES = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez", "Kim", "Patel", "Silva", "Muller", "Nguyen", "Khan", "Ivanov", "Tanaka", "Okafor", "Santos"];
const fullName = () => `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
const PRODUCT_CATEGORIES = ["Electronics", "Clothing", "Home & Garden", "Books", "Sports & Outdoors", "Beauty", "Toys", "Automotive", "Grocery", "Office Supplies"];
const REGIONS = ["North", "South", "East", "West", "Central"];

function toCSV(rows: Record<string, unknown>[]): string {
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(","), ...rows.map((r) => headers.map((h) => escape(r[h])).join(","))].join("\n");
}

function writeCSV(name: string, rows: Record<string, unknown>[]) {
  const filePath = path.join(CSV_DIR, name);
  fs.writeFileSync(filePath, toCSV(rows));
  const sizeMB = (fs.statSync(filePath).size / 1024 / 1024).toFixed(2);
  console.log(`csv/${name}: ${rows.length.toLocaleString()} rows, ${sizeMB} MB`);
}

function writeXLSX(name: string, rows: Record<string, unknown>[]) {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const filePath = path.join(XLSX_DIR, name);
  XLSX.writeFile(wb, filePath);
  const sizeMB = (fs.statSync(filePath).size / 1024 / 1024).toFixed(2);
  console.log(`xlsx/${name}: ${rows.length.toLocaleString()} rows, ${sizeMB} MB`);
}

// ─── 1. sales_transactions.csv — VERY BIG (~80k rows) ──────────────────────
{
  const rows = Array.from({ length: 80_000 }, (_, i) => {
    const category = pick(PRODUCT_CATEGORIES);
    const qty = int(1, 8);
    const unitPrice = float(5, 800);
    const discountPct = pick([0, 0, 0, 5, 10, 15, 20]);
    const total = Number((qty * unitPrice * (1 - discountPct / 100)).toFixed(2));
    return {
      order_id: 100000 + i,
      customer_id: int(1, 5000),
      product_id: int(1, 2000),
      product_name: `${category} Item ${int(1, 500)}`,
      category,
      quantity: qty,
      unit_price: unitPrice,
      discount_pct: discountPct,
      total_amount: total,
      order_date: dateBetween("2023-01-01", "2024-12-31"),
      region: pick(REGIONS),
      sales_channel: pick(["Online", "In-Store", "Mobile App", "Marketplace"]),
    };
  });
  writeCSV("sales_transactions.csv", rows);
}

// ─── 2. customers.csv (~5k rows) ────────────────────────────────────────────
{
  const rows = Array.from({ length: 5_000 }, (_, i) => {
    const country = pick(COUNTRIES);
    return {
      customer_id: i + 1,
      first_name: pick(FIRST_NAMES),
      last_name: pick(LAST_NAMES),
      email: `customer${i + 1}@example.com`,
      signup_date: dateBetween("2019-01-01", "2024-06-30"),
      country,
      city: pick(CITIES_BY_COUNTRY[country]),
      age: int(18, 75),
      gender: pick(["Female", "Male", "Non-binary"]),
      loyalty_tier: pick(["Bronze", "Silver", "Gold", "Platinum"]),
      total_lifetime_value: float(20, 15000),
    };
  });
  writeCSV("customers.csv", rows);
}

// ─── 3. products.csv (~2k rows) ─────────────────────────────────────────────
{
  const rows = Array.from({ length: 2_000 }, (_, i) => {
    const category = pick(PRODUCT_CATEGORIES);
    const cost = float(2, 400);
    return {
      product_id: i + 1,
      product_name: `${category} Item ${i + 1}`,
      category,
      subcategory: `${category} Sub${int(1, 5)}`,
      brand: `Brand${int(1, 60)}`,
      unit_cost: cost,
      unit_price: Number((cost * float(1.2, 2.5)).toFixed(2)),
      weight_kg: float(0.05, 25, 2),
      supplier_id: int(1, 150),
      in_stock_qty: int(0, 5000),
      reorder_level: int(10, 200),
    };
  });
  writeCSV("products.csv", rows);
}

// ─── 4. employees.csv (~3k rows) ────────────────────────────────────────────
{
  const departments = ["Engineering", "Sales", "Marketing", "HR", "Finance", "Operations", "Customer Support", "Legal", "Product", "Design"];
  const rows = Array.from({ length: 3_000 }, (_, i) => {
    const name = fullName().split(" ");
    return {
      employee_id: i + 1,
      first_name: name[0],
      last_name: name[1],
      department: pick(departments),
      job_title: pick(["Analyst", "Manager", "Senior Engineer", "Associate", "Director", "Coordinator", "Specialist", "VP"]),
      hire_date: dateBetween("2015-01-01", "2024-06-30"),
      salary: int(38000, 220000),
      manager_id: bool(0.9) ? int(1, 3000) : "",
      office_location: pick(CITIES_BY_COUNTRY.USA.concat(CITIES_BY_COUNTRY["United Kingdom"], CITIES_BY_COUNTRY.India)),
      performance_rating: float(1, 5, 1),
      years_experience: int(0, 30),
    };
  });
  writeCSV("employees.csv", rows);
}

// ─── 5. marketing_campaigns.csv (~1.5k rows) ────────────────────────────────
{
  const rows = Array.from({ length: 1_500 }, (_, i) => {
    const impressions = int(5_000, 2_000_000);
    const clicks = int(50, Math.floor(impressions * 0.08));
    const conversions = int(0, Math.floor(clicks * 0.15));
    return {
      campaign_id: i + 1,
      campaign_name: `Campaign ${i + 1}`,
      channel: pick(["Search", "Social", "Email", "Display", "Affiliate", "Influencer", "TV", "Radio"]),
      start_date: dateBetween("2023-01-01", "2024-10-01"),
      end_date: dateBetween("2024-10-02", "2024-12-31"),
      budget_usd: int(500, 250_000),
      impressions,
      clicks,
      conversions,
      ctr_pct: Number(((clicks / impressions) * 100).toFixed(2)),
      region: pick(REGIONS),
    };
  });
  writeCSV("marketing_campaigns.csv", rows);
}

// ─── 6. weather_data.csv (~6k rows: 15 countries x ~1 city x ~400 days) ─────
{
  const rows: Record<string, unknown>[] = [];
  for (const country of COUNTRIES) {
    const city = CITIES_BY_COUNTRY[country][0];
    for (let d = 0; d < 400; d++) {
      const date = new Date(2023, 0, 1 + d).toISOString().slice(0, 10);
      const base = { USA: 15, Germany: 10, India: 27, China: 14, Brazil: 25, "United Kingdom": 11, France: 13, Japan: 15, Canada: 6, Australia: 20, Mexico: 20, "South Africa": 18, Nigeria: 28, Indonesia: 28, "South Korea": 13 }[country] ?? 15;
      const avg = Number((base + Math.sin(d / 20) * 8 + float(-3, 3)).toFixed(1));
      rows.push({
        date, city, country,
        avg_temp_c: avg,
        min_temp_c: Number((avg - float(2, 6)).toFixed(1)),
        max_temp_c: Number((avg + float(2, 6)).toFixed(1)),
        precipitation_mm: float(0, 40, 1),
        humidity_pct: int(30, 95),
        wind_speed_kmh: float(2, 45, 1),
        condition: pick(["Clear", "Cloudy", "Rain", "Storm", "Fog", "Snow"]),
      });
    }
  }
  writeCSV("weather_data.csv", rows);
}

// ─── 7. industries_output.csv (~countries x sectors x years) ──────────────
// Uses "country" + "year" — exact-name-joinable with energy_consumption.xlsx
// and agriculture_yields.xlsx, and NOT with environment_emissions.csv
// (which uses "nation") — deliberately, to exercise both join paths.
const SECTORS = ["Manufacturing", "Agriculture", "Technology", "Mining", "Construction", "Energy"];
{
  const rows: Record<string, unknown>[] = [];
  for (const country of COUNTRIES) {
    for (const sector of SECTORS) {
      for (let year = 2018; year <= 2023; year++) {
        const base = COUNTRIES.indexOf(country) < 4 ? 300 : 80;
        rows.push({
          country, sector, year,
          output_usd_billion: float(base * 0.5, base * 1.5),
          employment_thousands: int(50, 5000),
          exports_usd_billion: float(10, base),
          imports_usd_billion: float(10, base),
          growth_rate_pct: float(-3, 8, 1),
          productivity_index: float(70, 140, 1),
          region: pick(REGIONS),
        });
      }
    }
  }
  writeCSV("industries_output.csv", rows);
}

// ─── 8. environment_emissions.csv — uses "nation" not "country" ────────────
{
  const rows: Record<string, unknown>[] = [];
  for (const nation of COUNTRIES) {
    for (let year = 2018; year <= 2023; year++) {
      const base = COUNTRIES.indexOf(nation) < 4 ? 4500 : 900;
      rows.push({
        nation, year,
        co2_emissions_mt: float(base * 0.8, base * 1.2),
        renewable_energy_pct: float(5, 65, 1),
        forest_area_pct: float(5, 60, 1),
        air_quality_index: int(20, 180),
        water_stress_index: float(0.1, 0.9, 2),
        waste_recycled_pct: float(5, 55, 1),
        region_group: pick(REGIONS),
        population_millions: float(2, 1400, 1),
      });
    }
  }
  writeCSV("environment_emissions.csv", rows);
}

// ─── 9. website_analytics.csv — BIG (~50k rows) ────────────────────────────
{
  const pages = ["/home", "/pricing", "/blog", "/product", "/signup", "/docs", "/about", "/contact", "/checkout", "/login"];
  const rows = Array.from({ length: 50_000 }, () => {
    const sessions = int(10, 5000);
    return {
      date: dateBetween("2023-06-01", "2024-12-31"),
      page_url: pick(pages),
      sessions,
      users: int(Math.floor(sessions * 0.6), sessions),
      pageviews: int(sessions, sessions * 4),
      bounce_rate_pct: float(15, 85, 1),
      avg_session_duration_sec: int(10, 600),
      conversions: int(0, Math.floor(sessions * 0.1)),
      device_category: pick(["Desktop", "Mobile", "Tablet"]),
      traffic_source: pick(["Organic", "Paid Search", "Social", "Referral", "Direct", "Email"]),
      country: pick(COUNTRIES),
    };
  });
  writeCSV("website_analytics.csv", rows);
}

// ─── 10. hr_attrition.csv (~3k rows) ────────────────────────────────────────
{
  const departments = ["Engineering", "Sales", "Marketing", "HR", "Finance", "Operations", "Customer Support", "Legal", "Product", "Design"];
  const jobRoles = ["Analyst", "Manager", "Senior Engineer", "Associate", "Director", "Coordinator", "Specialist", "VP", "Lead", "Consultant", "Architect", "Intern", "Principal", "Executive"];
  const rows = Array.from({ length: 3_000 }, () => ({
    employee_id: int(1, 3000),
    department: pick(departments),
    job_role: pick(jobRoles),
    monthly_income: int(2500, 18000),
    years_at_company: int(0, 25),
    job_satisfaction: int(1, 5),
    work_life_balance: int(1, 5),
    overtime: pick(["Yes", "No"]),
    attrition: pick(["Yes", "No", "No", "No", "No"]),
    age: int(21, 60),
    gender: pick(["Female", "Male", "Non-binary"]),
  }));
  writeCSV("hr_attrition.csv", rows);
}

// ══════════════════════════════ XLSX datasets ══════════════════════════════

// ─── 11. finance_stock_prices.xlsx (~4k rows) ───────────────────────────────
{
  const tickers = [
    ["AAPL", "Apple Inc.", "Technology"], ["MSFT", "Microsoft Corp.", "Technology"], ["GOOGL", "Alphabet Inc.", "Technology"],
    ["AMZN", "Amazon.com Inc.", "Consumer Discretionary"], ["TSLA", "Tesla Inc.", "Consumer Discretionary"],
    ["JPM", "JPMorgan Chase", "Financials"], ["XOM", "Exxon Mobil", "Energy"], ["JNJ", "Johnson & Johnson", "Healthcare"],
    ["PG", "Procter & Gamble", "Consumer Staples"], ["NVDA", "NVIDIA Corp.", "Technology"],
  ];
  const rows: Record<string, unknown>[] = [];
  for (const [ticker, company, sector] of tickers) {
    let price = float(50, 500);
    for (let d = 0; d < 400; d++) {
      const date = new Date(2023, 0, 1 + d).toISOString().slice(0, 10);
      const change = float(-0.04, 0.04, 4);
      const open = price;
      price = Number((price * (1 + change)).toFixed(2));
      const high = Number((Math.max(open, price) * (1 + float(0, 0.02))).toFixed(2));
      const low = Number((Math.min(open, price) * (1 - float(0, 0.02))).toFixed(2));
      rows.push({
        date, ticker, company_name: company, open, high, low, close: price,
        volume: int(500_000, 80_000_000), sector, market_cap_billion: float(50, 3000),
      });
    }
  }
  writeXLSX("finance_stock_prices.xlsx", rows);
}

// ─── 12. real_estate_listings.xlsx (~6k rows) ───────────────────────────────
{
  const propertyTypes = ["Single Family", "Condo", "Townhouse", "Multi-Family", "Land"];
  const usStates = ["CA", "TX", "NY", "FL", "WA", "IL", "CO", "MA", "GA", "AZ"];
  const rows = Array.from({ length: 6_000 }, (_, i) => {
    const sqft = int(500, 6000);
    const pricePerSqft = int(80, 900);
    return {
      listing_id: 50000 + i,
      city: pick(CITIES_BY_COUNTRY.USA),
      state: pick(usStates),
      property_type: pick(propertyTypes),
      bedrooms: int(1, 6),
      bathrooms: int(1, 5),
      sqft,
      list_price: sqft * pricePerSqft,
      year_built: int(1950, 2024),
      days_on_market: int(1, 250),
      price_per_sqft: pricePerSqft,
    };
  });
  writeXLSX("real_estate_listings.xlsx", rows);
}

// ─── 13. hospital_patients.xlsx (~4k rows) ──────────────────────────────────
{
  const diagnoses = ["Hypertension", "Diabetes Type 2", "Fracture", "Pneumonia", "Appendicitis", "Asthma", "Migraine", "Arthritis", "Anemia", "Influenza"];
  const departments = ["Cardiology", "Orthopedics", "Pulmonology", "General Surgery", "Neurology", "Internal Medicine", "Pediatrics", "Emergency"];
  const rows = Array.from({ length: 4_000 }, (_, i) => {
    const admission = dateBetween("2023-01-01", "2024-11-01");
    const stay = int(1, 21);
    const discharge = new Date(new Date(admission).getTime() + stay * 86400000).toISOString().slice(0, 10);
    return {
      patient_id: 20000 + i,
      age: int(0, 95),
      gender: pick(["Female", "Male"]),
      diagnosis: pick(diagnoses),
      admission_date: admission,
      discharge_date: discharge,
      length_of_stay_days: stay,
      department: pick(departments),
      treatment_cost_usd: int(300, 45000),
      insurance_type: pick(["Private", "Medicare", "Medicaid", "Uninsured", "Employer-Sponsored"]),
      readmission_flag: pick(["Yes", "No", "No", "No", "No"]),
    };
  });
  writeXLSX("hospital_patients.xlsx", rows);
}

// ─── 14. education_scores.xlsx (~7k rows) ───────────────────────────────────
{
  const schools = Array.from({ length: 12 }, (_, i) => `Lincoln High ${i + 1}`);
  const subjects = ["Math", "Science", "English", "History", "Art"];
  const rows = Array.from({ length: 7_000 }, () => ({
    student_id: int(1, 5000),
    school: pick(schools),
    grade_level: int(6, 12),
    subject: pick(subjects),
    test_score: int(35, 100),
    attendance_pct: float(60, 100, 1),
    study_hours_week: float(0, 25, 1),
    parental_education: pick(["High School", "Bachelor's", "Master's", "Doctorate", "Some College"]),
    free_lunch_eligible: pick(["Yes", "No"]),
    year: pick([2022, 2023, 2024]),
    region: pick(REGIONS),
  }));
  writeXLSX("education_scores.xlsx", rows);
}

// ─── 15. energy_consumption.xlsx — uses "country"+"year" (exact-name join) ──
const ENERGY_SOURCES = ["Coal", "Natural Gas", "Nuclear", "Hydro", "Solar", "Wind", "Oil"];
{
  const rows: Record<string, unknown>[] = [];
  for (const country of COUNTRIES) {
    for (let year = 2018; year <= 2023; year++) {
      for (const source of ENERGY_SOURCES) {
        rows.push({
          country, year, energy_source: source,
          consumption_twh: float(5, 900),
          co2_intensity: float(50, 900, 1),
          renewable_share_pct: float(5, 70, 1),
          gdp_billion_usd: float(200, 25000),
          population_millions: float(2, 1400, 1),
          per_capita_kwh: float(500, 14000),
          region: pick(REGIONS),
        });
      }
    }
  }
  writeXLSX("energy_consumption.xlsx", rows);
}

// ─── 16. supply_chain_shipments.xlsx (~5k rows) ─────────────────────────────
{
  const carriers = ["Maersk", "DHL", "FedEx", "UPS", "COSCO", "MSC"];
  const rows = Array.from({ length: 5_000 }, (_, i) => {
    const ship = dateBetween("2023-01-01", "2024-11-01");
    const transit = int(1, 45);
    return {
      shipment_id: 70000 + i,
      origin_country: pick(COUNTRIES),
      destination_country: pick(COUNTRIES),
      product_category: pick(PRODUCT_CATEGORIES),
      weight_kg: float(1, 20000),
      shipping_cost_usd: float(20, 15000),
      transit_days: transit,
      carrier: pick(carriers),
      status: pick(["Delivered", "In Transit", "Delayed", "Delivered", "Delivered"]),
      ship_date: ship,
      delay_flag: pick(["Yes", "No", "No", "No"]),
    };
  });
  writeXLSX("supply_chain_shipments.xlsx", rows);
}

// ─── 17. social_media_engagement.xlsx (~6k rows) ────────────────────────────
{
  const platforms = ["Instagram", "TikTok", "X", "Facebook", "LinkedIn", "YouTube"];
  const rows = Array.from({ length: 6_000 }, (_, i) => {
    const impressions = int(200, 500_000);
    const likes = int(0, Math.floor(impressions * 0.1));
    return {
      post_id: 90000 + i,
      platform: pick(platforms),
      account_name: `brand_${int(1, 40)}`,
      post_date: dateBetween("2023-06-01", "2024-12-01"),
      likes,
      shares: int(0, Math.floor(likes * 0.3)),
      comments: int(0, Math.floor(likes * 0.2)),
      impressions,
      engagement_rate_pct: Number(((likes / impressions) * 100).toFixed(2)),
      content_type: pick(["Photo", "Video", "Carousel", "Reel", "Story", "Text"]),
      country: pick(COUNTRIES),
    };
  });
  writeXLSX("social_media_engagement.xlsx", rows);
}

// ─── 18. restaurant_orders.xlsx (~5k rows) ──────────────────────────────────
{
  const cuisines = ["Italian", "Mexican", "Chinese", "Indian", "Japanese", "American", "Thai", "Mediterranean"];
  const rows = Array.from({ length: 5_000 }, (_, i) => ({
    order_id: 30000 + i,
    restaurant_name: `${pick(cuisines)} House ${int(1, 25)}`,
    city: pick(CITIES_BY_COUNTRY.USA),
    cuisine_type: pick(cuisines),
    order_value_usd: float(8, 180),
    items_count: int(1, 10),
    delivery_time_min: int(10, 90),
    rating: float(1, 5, 1),
    order_date: dateBetween("2023-06-01", "2024-12-01"),
    payment_method: pick(["Credit Card", "Debit Card", "Cash", "Digital Wallet"]),
    is_repeat_customer: pick(["Yes", "No"]),
  }));
  writeXLSX("restaurant_orders.xlsx", rows);
}

// ─── 19. agriculture_yields.xlsx — uses "country"+"year" (exact-name join) ──
const CROPS = ["Wheat", "Rice", "Maize", "Soybean", "Barley"];
{
  const rows: Record<string, unknown>[] = [];
  for (const country of COUNTRIES) {
    for (const crop of CROPS) {
      for (let year = 2018; year <= 2023; year++) {
        const areaHa = float(10000, 5_000_000);
        const yieldT = float(1.5, 9);
        rows.push({
          country, year, crop_type: crop,
          area_harvested_ha: Math.round(areaHa),
          yield_tonnes_per_ha: yieldT,
          production_tonnes: Math.round(areaHa * yieldT),
          fertilizer_use_kg_per_ha: float(20, 300),
          irrigation_pct: float(5, 95, 1),
          rainfall_mm: float(200, 2500),
          region: pick(REGIONS),
        });
      }
    }
  }
  writeXLSX("agriculture_yields.xlsx", rows);
}

// ─── 20. banking_transactions.xlsx — BIG (~40k rows) ────────────────────────
{
  const rows = Array.from({ length: 40_000 }, (_, i) => {
    const type = pick(["Deposit", "Withdrawal", "Transfer", "Payment", "Fee"]);
    const amount = type === "Fee" ? float(1, 50) : float(10, 25000);
    return {
      transaction_id: 500000 + i,
      account_id: int(1, 8000),
      transaction_type: type,
      amount_usd: amount,
      transaction_date: dateBetween("2023-01-01", "2024-12-31"),
      branch_city: pick(CITIES_BY_COUNTRY.USA.concat(CITIES_BY_COUNTRY["United Kingdom"])),
      channel: pick(["Branch", "ATM", "Online", "Mobile App", "Phone"]),
      customer_segment: pick(["Retail", "Premium", "Business", "Private Banking"]),
      fraud_flag: bool(0.02) ? "Yes" : "No",
      balance_after: float(0, 500000),
      currency: pick(["USD", "GBP", "EUR"]),
    };
  });
  writeXLSX("banking_transactions.xlsx", rows);
}

console.log("\nDone. Files written to", OUT_ROOT);
