#!/usr/bin/env node
/**
 * skeptic.mjs
 *
 * A second model reads the work with none of the context that produced it: no
 * charter, no cycle notes, no memory of the reasoning. It gets the artifact and
 * a mandate to find what is wrong with it. An agent that has spent forty turns
 * on a change is the worst possible reviewer of that change.
 *
 * The output contract is a forced verdict. The reviewer must open with
 * "VERDICT: PASS", "VERDICT: CONCERNS", or "VERDICT: BLOCK". Prose with no
 * verdict is treated as BLOCK, so an ambiguous review can never read as
 * approval.
 *
 * Usage:
 *   node scripts/skeptic.mjs --pr owner/repo#128
 *   node scripts/skeptic.mjs --file draft.md --context "outbound email to 400 people"
 *   git diff main... | node scripts/skeptic.mjs --stdin --context "nightly fix"
 *
 * Exit codes: 0 PASS, 0 CONCERNS, 3 BLOCK, 4 the reviewer could not be run.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const VERDICTS = ["PASS", "CONCERNS", "BLOCK"];

const PROMPT = [
  "You are the in-house skeptic. Another agent produced the artifact on stdin.",
  "You were not involved, you get no credit if it ships, and you are not being asked to be kind.",
  "Red team it: false or unverifiable claims, logic that does not hold, security and privacy exposure,",
  "irreversible or high blast radius actions, missing tests around the exact behaviour that changed,",
  "and anything an owner would regret waking up to.",
  "Judge only what is in front of you. Do not assume unseen context makes it fine.",
  'Reply with exactly one line "VERDICT: PASS|CONCERNS|BLOCK" followed by at most six short bullets, each naming a specific thing.',
].join(" ");

function readArtifact(argv) {
  const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const context = flag("--context") ?? "no extra context given";

  const pr = flag("--pr");
  if (pr) {
    const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(pr);
    if (!m) throw new Error("--pr wants owner/repo#123");
    // gh is the only outside tool used here, and only to read a diff.
    const diff = execFileSync("gh", ["pr", "diff", m[2], "--repo", m[1]], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    return { body: diff, context: `pull request diff, ${pr}, ${context}` };
  }

  const file = flag("--file");
  if (file) return { body: readFileSync(file, "utf8"), context: `file ${file}, ${context}` };

  if (argv.includes("--stdin")) return { body: readFileSync(0, "utf8"), context };

  throw new Error("usage: skeptic.mjs --pr owner/repo#123 | --file path | --stdin  [--context text]");
}

/** First VERDICT token wins. No verdict at all means BLOCK. */
export function parseVerdict(output) {
  const m = /VERDICT:\s*(PASS|CONCERNS|BLOCK)/i.exec(String(output ?? ""));
  if (!m) return { verdict: "BLOCK", reason: "no verdict line in the review; failing closed" };
  return { verdict: m[1].toUpperCase(), reason: null };
}

export function runSkeptic({ body, context }, opts = {}) {
  const model = opts.model ?? process.env.SKEPTIC_MODEL ?? "opus";
  // Flag order matters. The prompt has to come immediately after -p, because a
  // variadic flag such as --allowedTools placed in between will swallow a
  // trailing positional prompt and the CLI then waits on stdin forever.
  const args = [
    "-p",
    `${PROMPT} (artifact on stdin; context: ${context})`,
    "--model",
    model,
    "--max-turns",
    "8",
    "--allowedTools",
    "Read,Grep,Glob",
  ];

  const res = spawnSync("claude", args, {
    input: body,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

  if (res.error?.code === "ENOENT") {
    return { ok: false, message: "claude CLI not found on PATH (npm i -g @anthropic-ai/claude-code)" };
  }
  if (res.status !== 0) {
    return { ok: false, message: `claude exited ${res.status}: ${(res.stderr ?? "").trim().slice(0, 400)}` };
  }
  return { ok: true, output: (res.stdout ?? "").trim() };
}

function main(argv) {
  const artifact = readArtifact(argv);
  const run = runSkeptic(artifact);
  if (!run.ok) {
    console.error(run.message);
    process.exit(4);
  }
  const { verdict, reason } = parseVerdict(run.output);
  console.log(run.output);
  if (reason) console.error(reason);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `verdict=${verdict}\n`);
  // CONCERNS is not a stop. It is text the human reads on the approval card
  // before deciding, which is the only place a judgement call belongs.
  if (verdict === "BLOCK") process.exit(3);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(4);
  }
}
