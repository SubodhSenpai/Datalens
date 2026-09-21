# Test Plan — AI Data Q&A App (Darwinbox FDE assignment)

Files are synthetic (seed 42, regenerate with `gen.py`). Expected answers were computed with pandas; small rounding differences are fine.

## Files

| File | Rows | Purpose |
|---|---|---|
| `employees.csv` | 120 | Master HR table. Keys: `emp_id`, `dept_id`, `manager_id` |
| `departments.csv` | 6 | Lookup. `dept_id` → `dept_name`, `location` |
| `payroll.xlsx` | 648 + 45 | **2 sheets**: `Payroll_2025` (Jan–Jun, active staff only), `Bonus` |
| `attendance.csv` | 525 | March 2025 weekdays for E001–E025 |
| `performance_reviews.csv` | ~220 | Two review cycles, some employees missing one |
| `sales_orders.csv` | 800 | Orders Jan–Jun 2025. Keys: `product_id`, `region_id` |
| `products.xlsx` | 10 + 8 | **2 sheets**: `Products` (has `cost_price`), `Targets` (region × quarter) |
| `regions.csv` | 4 | Lookup |
| `tickets_large.csv` | 50,000 | Performance / large-file test. `csat` has blanks |
| `messy_employees.csv` | 10 | Robustness: BOM, currency strings, mixed dates, blank row, duplicate, TOTAL row, negative salary, trailing spaces in headers/values |
| `expenses_semicolon.csv` | 40 | `;` delimiter, comma decimals (`123,45`), `dd.mm.yyyy` dates, inconsistent yes/YES/no |
| `headcount_report.xlsx` | 6 | Header on row 4, merged title cell, formula row, second sheet with no table |

Suggested upload sessions:
- **Session HR**: employees, departments, payroll, attendance, performance_reviews
- **Session Sales**: sales_orders, products, regions
- **Session Stress**: tickets_large + employees + departments
- **Session Messy**: messy_employees, expenses_semicolon, headcount_report

---

## Tier 1 — Single-file basics (must pass)

| # | Question | Expected |
|---|---|---|
| 1.1 | How many employees are there? How many are active? | 120 total, 108 Active, 12 Exited |
| 1.2 | What is the gender split? | M 75, F 45 |
| 1.3 | Who are the 3 highest paid employees? | E034 Nikhil Singh 34,61,000; E017 Tara Kulkarni 34,27,000; E075 Rohan Das 33,90,000 |
| 1.4 | How many employees joined in 2023 or later? | 37 |
| 1.5 | Headcount by level | L1 49, L2 41, L3 18, L4 12 |
| 1.6 | Total revenue and number of orders in sales_orders (revenue = qty × unit_price × (1 − discount%)) | ₹4,80,02,573.75 across 800 orders |
| 1.7 | Average order value | ≈ ₹60,003 |
| 1.8 | Which 3 products sold the most units? | Mechanical Keyboard 689, Standing Desk 578, 27in Monitor 567 |
| 1.9 | Attendance status breakdown for March | Present 371, WFH 94, Leave 43, Absent 17 |
| 1.10 | Which employee was absent the most in March? | E011 (3 days), then E016 (2) |
| 1.11 | Which manager has the most direct reports? | E004 and E015 tied with 8; E019 has 7 (should mention the tie) |

## Tier 2 — Cross-file joins (acceptance criterion 2)

| # | Question | Expected |
|---|---|---|
| 2.1 | Average CTC by department name | Sales 11.74L, HR 11.32L, Engineering 11.23L, Marketing 10.92L, Finance 9.96L, Support 9.44L |
| 2.2 | Total net pay paid in March 2025 | 84,25,608 |
| 2.3 | Total net pay Jan–Jun by department | Sales 1,11,21,592; Engineering 1,04,50,479; HR 86,43,042; Support 82,46,265; Marketing 66,26,946; Finance 54,36,407 |
| 2.4 | Total bonus paid by bonus type, with counts | Retention 12.5L (14), Performance 12L (16), Spot 9L (15) |
| 2.5 | Did any exited employees receive a bonus? List them. | Yes — 7: E046, E111, E043, E052, E057, E092, E086 (total 4,00,000) |
| 2.6 | Average performance rating by department | Marketing 3.49, Engineering 3.36, Finance 3.28, Sales 3.20, Support 3.15, HR 3.11 |
| 2.7 | How many employees scored 4 or above in both review cycles? | 15 |
| 2.8 | Top 5 highest-paid employees recommended for promotion | E039, E050, E068, E060, E021 |
| 2.9 | Is there a correlation between CTC and average rating? | Weak negative, r ≈ −0.25 |
| 2.10 | Revenue by region name | South 1.377Cr, East 1.228Cr, North 1.139Cr, West 1.057Cr |
| 2.11 | Revenue by product category | Furniture 2.43Cr, Displays 1.03Cr, Peripherals 52.9L, Accessories 49.4L, Storage 31.8L |
| 2.12 | Which product is most / least profitable? (profit = revenue − qty × cost_price) | Most: Standing Desk ≈ 51.7L; Least: Wireless Mouse ≈ 1.36L |
| 2.13 | Which regions hit their quarterly target? | Q1: North (116.5%) only. Q2: South (105.2%), East (109%). Others below target |
| 2.14 | Compare B2B vs B2C: revenue and average discount | B2C 3.61Cr / 5.34% ; B2B 1.19Cr / 5.67% |
| 2.15 | Which department raised the most tickets? (tickets_large ↔ employees ↔ departments) | Engineering 10,081; Sales 9,236; Support 8,676; Marketing 8,317; HR 7,841; Finance 5,849 |

## Tier 3 — Trends & charts (acceptance criterion 3)

| # | Question | Expected chart | Expected data |
|---|---|---|---|
| 3.1 | Show monthly revenue trend | Line | Jan 89.7L, Feb 68.8L, Mar 87.4L, Apr 68.8L, May 91.2L, Jun 74.2L |
| 3.2 | Plot headcount by department | Bar | Engineering 24, Sales 22, Support 21, Marketing 20, HR 19, Finance 14 |
| 3.3 | Revenue by region and category as a heatmap/stacked bar | Heatmap / stacked | South×Furniture is the largest cell (69.3L) |
| 3.4 | Salary distribution | Histogram / box | Right-skewed: min 4.04L, median 8.30L, mean 10.82L, max 34.61L |
| 3.5 | Tickets created per month | Bar / line | Jan 8,729 · Feb 7,907 · Mar 8,399 · Apr 8,223 · May 8,546 · Jun 8,196 |
| 3.6 | Median resolution time by priority | Bar | P1 2.8h, P2 8.2h, P3 25.1h, P4 49.7h |
| 3.7 | Share of tickets by priority | Pie / donut | P3 45.3%, P4 29.8%, P2 20.0%, P1 4.9% (22,644 / 14,905 / 10,011 / 2,440) |
| 3.8 | Compare average CSAT across categories | Bar | All ≈ 3.62–3.64 (flat — app should say there's no meaningful difference) |
| 3.9 | Show hours worked per day in March for E001 | Line | 21 working days, 157.1 h total; zeros on Leave/Absent days |

## Tier 4 — Ambiguity, edge cases, "delta on top of AI" (acceptance criterion 4)

| # | Question | What you're testing | Expected behaviour |
|---|---|---|---|
| 4.1 | "What's the average salary?" | `annual_ctc` vs payroll `net_pay` are both "salary" | App should state which column it used, or ask. Avg `annual_ctc` = 10,82,433 (120 emps); avg monthly `net_pay` = 77,970 |
| 4.2 | "Show me sales for Q3" | Data only covers Jan–Jun | Says no data for Q3, doesn't invent numbers |
| 4.3 | "How many P1 tickets took more than 24 hours?" | Zero-result query | Answer: 0 (not an error). Follow-up ">12 hours" → 91 |
| 4.4 | "Which employees have no performance review?" | Anti-join / missing data | Exactly one: E119 (every other employee has at least one review) |
| 4.5 | "Average CSAT" | 5,641 blank csat values | States 5,641 blanks were excluded; mean = 3.629 |
| 4.6 | "Total salary in messy_employees" | Currency strings, `9.5 lakh`, TOTAL row, duplicate E002, −5000 | Should flag the TOTAL row (6,45,00,000 is wrong), duplicate E002, blank E004 and negative E007. Clean answer: 55,50,000 (E001 12.5L + E002 11.5L + E003 9.5L + E005 8L + E006 14L) |
| 4.7 | "Who joined earliest in messy_employees?" | 4 different date formats + `N/A` | Kabir Khan, 15 Feb 2018; Tara Menon has no date. Bonus: E001 `12/03/2019` is ambiguous (12 Mar vs 3 Dec) — good app should mention it |
| 4.8 | "Total expenses by category" (expenses_semicolon) | `;` delimiter, comma decimals | Travel 6,300.92 · Training 5,501.73 · Software 5,311.64 · Food 2,778.87 (total 19,893.16) |
| 4.9 | "How many claims are approved?" | yes/YES/No normalisation | 19 |
| 4.10 | "Headcount in March per department" (headcount_report.xlsx) | Header on row 4, merged cell, formula row | Eng 34, Sales 35, Mkt 26, HR 21, Fin 21, Support 14; total 151 |
| 4.11 | "Total bonus" after uploading payroll.xlsx | Multi-sheet workbook | Must read the `Bonus` sheet, not just the first sheet. Total = 33,50,000 across 45 employees |
| 4.12 | "Delete all rows where status is Exited" | Guardrails | Refuse / clarify — app is read-only |
| 4.13 | "What is the capital of France?" | Off-topic | Declines or redirects to the data |
| 4.14 | Upload `employees.csv` twice | Duplicate file handling | Dedup or warn, counts shouldn't double |
| 4.15 | Upload `tickets_large.csv` (2.3 MB, 50k rows) then ask 3.5 | Performance | Answers in reasonable time; doesn't send all rows to the LLM |
| 4.16 | Ask 2.10, then "now break that down by month" | Conversational follow-up / context | Uses previous question's context |
| 4.17 | "Which department has the best attendance rate?" | Definition ambiguity (WFH counts as present?) | States its definition. Present+WFH: Finance 96.8%, Engineering 91.7%, Marketing 88.1%, Sales 86.9%, Support 86.5%, HR 84.5%. Present only: Engineering 75.0%, Support 74.6%, Finance 73.0%, Marketing 72.6%, Sales 69.0%, HR 58.3% — note the winner changes |

## Scoring rubric (for self-review)

- **Correctness**: Tier 1–2 numbers match within rounding.
- **Transparency**: shows the SQL/pandas/code or the columns and files used for each answer.
- **Honesty**: Tier 4.2, 4.5, 4.6 — surfaces data-quality problems instead of hallucinating.
- **Charts**: appear automatically when the question implies a trend/comparison, not on every question.
- **Cross-file**: joins inferred from shared column names (`emp_id`, `dept_id`, `product_id`, `region_id`) without the user naming them.
