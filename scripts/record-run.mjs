#!/usr/bin/env node
/**
 * record-run.mjs
 *
 * The money brakes. Two modes, two distinct exit codes.
 *
 *   node scripts/record-run.mjs --preflight
 *       Runs before the agent starts. Exits 78 when the kill switch is on or
 *       the month has already reached BUDGET_MONTHLY. Nothing spends after 78.
 *
 *   claude -p "..." --output-format json > run.json
 *   node scripts/record-run.mjs --label nightly-dev < run.json
 *       Runs after. Appends one line to the spend ledger and exits 79 when this
 *       single run cost more than RUNNER_MAX_USD.
 *
 * 78 and 79 are used instead of 1 so a workflow can tell a designed stop from a
 * crash and say which one happened in the alert. A founder who cannot tell
 * those apart stops reading alerts.
 *
 * Env:
 *   BUDGET_MONTHLY   dollars per calendar month (default 100)
 *   RUNNER_MAX_USD   dollars per single run (default 10)
 *   KILL_SWITCH=1    hard stop, checked before anything else
 *   SPEND_LEDGER     ledger path (default state/spend.jsonl)
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const EXIT_MONTHLY_CAP = 78;
export const EXIT_PER_RUN_CAP = 79;

const ledgerPath = () => process.env.SPEND_LEDGER ?? "state/spend.jsonl";
const round2 = (n) => Math.round(n * 100) / 100;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function appendSpend(entry, file = ledgerPath()) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
  return entry;
}

/** Total spend for a YYYY-MM month. Unparseable lines are skipped, not fatal. */
export function monthSpend(month, file = ledgerPath()) {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(tryJson)
    .filter((e) => e && typeof e.cost_usd === "number" && String(e.date).startsWith(month))
    .reduce((sum, e) => sum + e.cost_usd, 0);
}

export function posture(spent, cap) {
  if (spent >= cap) return "stop";
  if (spent >= 0.8 * cap) return "lean";
  return "ok";
}

/**
 * Pull the totals out of claude-code output. Handles --output-format json (one
 * object) and --output-format stream-json (one object per line, the last result
 * line carrying the totals). Unrecognised output records a zero cost with a
 * note rather than throwing, because losing the ledger line is worse than
 * losing the number.
 */
export function parseRun(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { cost_usd: 0, notes: "empty-engine-output" };

  const whole = tryJson(text);
  if (whole) return fromRecord(whole);

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = tryJson(lines[i]);
    if (obj && (obj.type === "result" || typeof obj.total_cost_usd === "number")) return fromRecord(obj);
  }
  return { cost_usd: 0, notes: "unparseable-engine-output" };
}

function fromRecord(input) {
  let rec = input;
  if (Array.isArray(input)) {
    rec = [...input].reverse().find((x) => x && typeof x === "object" && "total_cost_usd" in x) ?? input.at(-1) ?? {};
  }
  const cost = Number(rec.total_cost_usd);
  return {
    cost_usd: Number.isFinite(cost) ? cost : 0,
    turns: rec.num_turns ?? null,
    duration_ms: rec.duration_ms ?? null,
    session_id: rec.session_id ?? null,
    engine_error: rec.is_error === true || rec.subtype === "error_max_turns" ? (rec.subtype ?? "error") : null,
    ...(Number.isFinite(cost) ? {} : { notes: "no-total_cost_usd-in-output" }),
  };
}

function writeOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${key}=${value}\n`);
}

function preflight() {
  if (process.env.KILL_SWITCH === "1") {
    console.error("kill switch is on (KILL_SWITCH=1); refusing to start");
    process.exit(EXIT_MONTHLY_CAP);
  }
  const cap = num(process.env.BUDGET_MONTHLY, 100);
  const month = new Date().toISOString().slice(0, 7);
  const spent = round2(monthSpend(month));
  const p = posture(spent, cap);
  console.log(JSON.stringify({ month, spent, cap, posture: p }));
  writeOutput("posture", p);
  writeOutput("month_spent", String(spent));
  if (p === "stop") {
    console.error(`monthly cap reached: $${spent} of $${cap}`);
    process.exit(EXIT_MONTHLY_CAP);
  }
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function record(argv) {
  const label = argv[argv.indexOf("--label") + 1] ?? process.env.CYCLE_LABEL ?? "adhoc";
  const fileArg = argv.includes("--file") ? argv[argv.indexOf("--file") + 1] : null;
  const raw = fileArg ? readFileSync(fileArg, "utf8") : readStdin();
  const parsed = parseRun(raw);

  const entry = appendSpend({
    date: new Date().toISOString().slice(0, 10),
    at: new Date().toISOString(),
    cycle: label,
    ...parsed,
  });

  const cap = num(process.env.RUNNER_MAX_USD, 10);
  const month = new Date().toISOString().slice(0, 7);
  const spent = round2(monthSpend(month));
  const monthlyCap = num(process.env.BUDGET_MONTHLY, 100);
  console.log(`run ${label} cost $${round2(entry.cost_usd)} (month $${spent} of $${monthlyCap})`);
  writeOutput("run_cost", String(round2(entry.cost_usd)));
  writeOutput("month_spent", String(spent));

  if (entry.cost_usd > cap) {
    console.error(`run cost $${round2(entry.cost_usd)} is over RUNNER_MAX_USD=$${cap}`);
    process.exit(EXIT_PER_RUN_CAP);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  if (argv.includes("--preflight")) preflight();
  else record(argv);
}
