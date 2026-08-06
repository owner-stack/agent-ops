#!/usr/bin/env node
/**
 * executor.mjs
 *
 * The only code in this repo allowed to change the target repository. It runs
 * from repository_dispatch after a human taps Approve, and its whole job is to
 * merge the exact commit that was on the card and nothing else.
 *
 * The rule it enforces: an approval is a decision about one commit, not about a
 * branch. Between the card being sent and the tap arriving, the branch can move.
 * If it moved, the human approved something they never saw, so this exits
 * non-zero and merges nothing.
 *
 * Env in (from the dispatch payload):
 *   APPROVAL_ID   short slug, echoed in every message
 *   DECISION      approve | reject
 *   REPO          owner/repo
 *   PR_NUMBER     integer
 *   HEAD_SHA      the full 40 character sha printed on the card
 *
 * Env in (from repository settings):
 *   GH_TOKEN_WRITE   token with contents and pull_requests write on REPO
 *   ALLOWED_REPOS    comma separated allowlist, default TARGET_REPO
 *   DEFAULT_BRANCH   base a PR is allowed to target, default main
 *   MERGE_MODE       api (default) or git
 *   MERGE_METHOD     squash (default), merge, or rebase, api mode only
 *   DRY_RUN=1        verify everything, merge nothing (default on)
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sendText } from "./approve-card.mjs";

const GH = "https://api.github.com";
const dryRun = () => process.env.DRY_RUN !== "0";

class Refusal extends Error {}

function refuse(message) {
  throw new Refusal(message);
}

/** Telegram is best effort. A failed notification never fails the merge. */
async function notify(text) {
  try {
    await sendText(text);
  } catch (err) {
    console.error(`notify failed (not fatal): ${err.message}`);
  }
}

export function readPayload(env = process.env) {
  const p = {
    id: env.APPROVAL_ID ?? "",
    decision: env.DECISION ?? "",
    repo: env.REPO ?? env.TARGET_REPO ?? "",
    prNumber: Number(env.PR_NUMBER),
    headSha: (env.HEAD_SHA ?? "").toLowerCase(),
  };
  const allowed = (env.ALLOWED_REPOS ?? env.TARGET_REPO ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(p.id)) refuse(`bad approval id: ${JSON.stringify(p.id)}`);
  if (!["approve", "reject"].includes(p.decision)) refuse(`bad decision: ${JSON.stringify(p.decision)}`);
  if (!allowed.length) refuse("no allowlist configured; set ALLOWED_REPOS or TARGET_REPO");
  if (!allowed.includes(p.repo)) refuse(`repo ${p.repo} is not in the allowlist`);
  if (!Number.isInteger(p.prNumber) || p.prNumber < 1) refuse(`bad pr number: ${env.PR_NUMBER}`);
  if (!/^[0-9a-f]{40}$/.test(p.headSha)) refuse("head sha must be the full 40 character sha from the card");
  return p;
}

async function gh(path, init = {}) {
  const token = process.env.GH_TOKEN_WRITE;
  if (!token) refuse("GH_TOKEN_WRITE is not set");
  const res = await fetch(`${GH}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, ok: res.ok, body };
}

/**
 * GitHub computes mergeability lazily, so the first read can say "unknown".
 * Ask again a couple of times before deciding.
 */
async function loadPr(repo, prNumber, attempts = 3) {
  let pr = null;
  for (let i = 0; i < attempts; i++) {
    const res = await gh(`/repos/${repo}/pulls/${prNumber}`);
    if (!res.ok) refuse(`cannot read ${repo} PR #${prNumber}: HTTP ${res.status}`);
    pr = res.body;
    if (pr.mergeable !== null) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return pr;
}

export function checkPr(pr, payload, expectedBase) {
  if (pr.state !== "open") refuse(`PR #${payload.prNumber} is ${pr.state}, not open`);
  if (pr.draft) refuse(`PR #${payload.prNumber} is a draft`);

  // A PR based on another open PR's head merges that other PR's commits too.
  // The card only ever described this one, so anything but the default branch
  // is refused.
  if (pr.base?.ref !== expectedBase) {
    refuse(`PR #${payload.prNumber} targets ${pr.base?.ref}, not ${expectedBase}; stacked PRs are not auto mergeable here`);
  }

  // The whole point. The card carried one commit; only that commit merges.
  if (pr.head?.sha?.toLowerCase() !== payload.headSha) {
    refuse(
      `branch moved after the card was sent. approved ${payload.headSha.slice(0, 10)}, head is now ${(pr.head?.sha ?? "unknown").slice(0, 10)}. nothing merged; send a fresh card.`,
    );
  }

  if (pr.mergeable === false) refuse(`PR #${payload.prNumber} has conflicts (mergeable=false)`);
  return true;
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}

/**
 * git mode. Fetches the PR head by ref (never by bare sha, which depends on
 * server config), checks the sha one last time, and fast forwards. If the base
 * has moved ahead, --ff-only fails and nothing is rewritten.
 */
function mergeWithGit({ repo, prNumber, headSha }, base) {
  const dir = mkdtempSync(join(tmpdir(), "agent-ops-"));
  try {
    // Full clone on purpose. A depth 1 clone cannot answer ancestry questions,
    // and --ff-only is an ancestry question.
    run("git", ["clone", "--quiet", "--no-tags", `https://x-access-token:${process.env.GH_TOKEN_WRITE}@github.com/${repo}.git`, dir]);
    run("git", ["-C", dir, "checkout", "--quiet", base]);
    run("git", ["-C", dir, "fetch", "--quiet", "origin", `pull/${prNumber}/head`]);
    const fetched = run("git", ["-C", dir, "rev-parse", "FETCH_HEAD"]).toLowerCase();
    if (fetched !== headSha) refuse(`pull head is ${fetched.slice(0, 10)} at fetch time, card said ${headSha.slice(0, 10)}`);
    run("git", ["-C", dir, "merge", "--ff-only", "FETCH_HEAD"]);
    run("git", ["-C", dir, "push", "--quiet", "origin", `HEAD:${base}`]);
    return { mode: "git", merged: true, sha: headSha };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * api mode. The sha field makes GitHub itself refuse the merge if the head
 * moved, so the guard survives even a race between the check and the call.
 */
async function mergeWithApi({ repo, prNumber, headSha }) {
  const method = process.env.MERGE_METHOD ?? "squash";
  const res = await gh(`/repos/${repo}/pulls/${prNumber}/merge`, {
    method: "PUT",
    body: JSON.stringify({ sha: headSha, merge_method: method }),
  });
  if (res.status === 409) refuse(`GitHub refused the merge: head no longer at ${headSha.slice(0, 10)}`);
  if (!res.ok) refuse(`merge failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  return { mode: "api", merged: true, method, sha: res.body?.sha ?? headSha };
}

export async function main(env = process.env) {
  const payload = readPayload(env);
  const base = env.DEFAULT_BRANCH ?? "main";

  if (payload.decision === "reject") {
    console.log(`${payload.id}: rejected, nothing to do`);
    await notify(`Rejected ${payload.id}. Nothing merged.`);
    return { decision: "reject" };
  }

  const pr = await loadPr(payload.repo, payload.prNumber);
  checkPr(pr, payload, base);

  if (dryRun()) {
    const line = `[dry run] would merge ${payload.repo} PR #${payload.prNumber} at ${payload.headSha.slice(0, 10)} into ${base}`;
    console.log(line);
    await notify(line);
    return { decision: "approve", dryRun: true };
  }

  const result = (env.MERGE_MODE ?? "api") === "git"
    ? mergeWithGit(payload, base)
    : await mergeWithApi(payload);

  const line = `Merged ${payload.repo} PR #${payload.prNumber} at ${payload.headSha.slice(0, 10)} into ${base} (${result.mode}).`;
  console.log(line);
  await notify(line);
  return { decision: "approve", ...result };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(async (err) => {
    const prefix = err instanceof Refusal ? "refused" : "failed";
    const id = process.env.APPROVAL_ID ?? "unknown";
    console.error(`${prefix}: ${err.message}`);
    await notify(`Approval ${id} ${prefix}: ${err.message}`);
    process.exit(err instanceof Refusal ? 2 : 1);
  });
}
