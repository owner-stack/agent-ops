#!/usr/bin/env node
/**
 * approve-card.mjs
 *
 * Builds the approval card a human taps, and owns the only outbound Telegram
 * path in this repo. Every other script sends through sendText() here so that
 * chunking and error checking happen exactly once.
 *
 * Usage:
 *   node scripts/approve-card.mjs approvals/2026-05-04-login-redirect.json
 *   node scripts/approve-card.mjs --text "nightly cycle failed, see run 123"
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN   bot token from BotFather
 *   TELEGRAM_CHAT_ID     the one chat allowed to approve
 *   DRY_RUN=1            print the card instead of sending it (default on)
 *
 * Two rules this file exists to enforce:
 *   1. Telegram rejects any single sendMessage over 4096 characters. A long
 *      risk note silently kills the whole card, buttons included.
 *   2. Telegram answers a rejected send with HTTP 200 and {"ok":false,...}.
 *      Anything that ignores the response body cannot tell a delivered card
 *      from a dropped one.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const API_BASE = process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org";

// 4096 is the hard cap. Send well under it so a chunk header or a retry
// prefix can never push a message over the line.
export const CHUNK_LIMIT = 3800;

// Telegram truncates callback_data past 64 bytes, and a truncated payload
// routes an approval to the wrong id. Approval ids stay short for this reason.
const CALLBACK_LIMIT = 64;

const dryRun = () => process.env.DRY_RUN !== "0";

/** Split text into Telegram-sized pieces, preferring line boundaries. */
export function chunk(text, limit = CHUNK_LIMIT) {
  const out = [];
  let buf = "";
  for (const rawLine of String(text).split("\n")) {
    // A single line longer than the limit gets hard split; nothing is dropped.
    let line = rawLine;
    while (line.length > limit) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      out.push(line.slice(0, limit));
      line = line.slice(limit);
    }
    const candidate = buf ? `${buf}\n${line}` : line;
    if (candidate.length > limit) {
      out.push(buf);
      buf = line;
    } else {
      buf = candidate;
    }
  }
  if (buf) out.push(buf);
  return out.length ? out : [""];
}

/**
 * One Telegram API call. Throws on transport failure, on a non-2xx status, and
 * on a 200 that carries ok:false. The description from the API is preserved,
 * because "message is too long" and "chat not found" need different fixes.
 */
export async function api(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  let res;
  try {
    res = await fetch(`${API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new Error(`telegram ${method} transport failure: ${err.message}`);
  }
  const raw = await res.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error(`telegram ${method} returned unparseable body (status ${res.status}): ${raw.slice(0, 200)}`);
  }
  if (!body.ok) {
    throw new Error(`telegram ${method} refused the message: ${body.description ?? "no description"}`);
  }
  return body.result;
}

/**
 * Send text as one or more messages. An inline keyboard, when given, rides on
 * the final chunk so the buttons always sit under the last thing read.
 */
export async function sendText(text, { keyboard = null, chatId = process.env.TELEGRAM_CHAT_ID } = {}) {
  const parts = chunk(text);
  if (dryRun()) {
    parts.forEach((part, i) => {
      console.log(`--- [dry run] chunk ${i + 1}/${parts.length} (${part.length} chars)`);
      console.log(part);
    });
    if (keyboard) console.log(`--- [dry run] buttons: ${keyboard.inline_keyboard[0].map((b) => b.text).join(" ")}`);
    return { dryRun: true, chunks: parts.length };
  }
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID is not set");
  const sent = [];
  for (const [i, part] of parts.entries()) {
    const last = i === parts.length - 1;
    const payload = {
      chat_id: chatId,
      text: parts.length > 1 ? `${part}\n\n(${i + 1}/${parts.length})` : part,
      disable_web_page_preview: true,
    };
    if (last && keyboard) payload.reply_markup = keyboard;
    sent.push(await api("sendMessage", payload));
  }
  return { dryRun: false, chunks: parts.length, sent };
}

function callbackData(action, id) {
  const data = `ao:v1:${action}:${id}`;
  if (Buffer.byteLength(data) > CALLBACK_LIMIT) {
    throw new Error(
      `approval id "${id}" makes callback_data ${Buffer.byteLength(data)} bytes, over Telegram's ${CALLBACK_LIMIT}. Use a shorter id.`,
    );
  }
  return data;
}

export function keyboardFor(id) {
  return {
    inline_keyboard: [
      [
        { text: "Approve", callback_data: callbackData("approve", id) },
        { text: "Reject", callback_data: callbackData("reject", id) },
      ],
    ],
  };
}

/** Reject an approval record that cannot be executed safely later. */
export function validateApproval(a) {
  const problems = [];
  if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(a.id ?? "")) problems.push("id must be short, lowercase, and slug shaped");
  if (a.action !== "merge-pr") problems.push(`unsupported action: ${a.action}`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(a.repo ?? "")) problems.push("repo must look like owner/repo");
  if (!Number.isInteger(a.pr_number)) problems.push("pr_number must be an integer");
  if (!/^[0-9a-f]{40}$/.test(a.head_sha ?? "")) problems.push("head_sha must be the full 40 character commit sha");
  if (!a.summary) problems.push("summary is required");
  if (!a.risk) problems.push("risk is required");
  if (problems.length) throw new Error(`approval ${a.id ?? "(no id)"} is not sendable:\n  ${problems.join("\n  ")}`);
  return a;
}

/**
 * The card text. Deterministic on purpose. No model rewrites it, because the
 * sha printed here is the thing the executor will be held to.
 */
export function buildCard(a) {
  const d = a.diff ?? {};
  const lines = [
    `NEEDS YOUR TAP  ${a.id}`,
    "",
    a.summary,
    "",
    `does: merge ${a.repo} PR #${a.pr_number}`,
    `sha: ${a.head_sha}`,
  ];
  if (d.files != null) lines.push(`diff: ${d.files} files, +${d.additions ?? 0} / -${d.deletions ?? 0}`);
  for (const p of (d.paths ?? []).slice(0, 8)) lines.push(`  ${p}`);
  if ((d.paths ?? []).length > 8) lines.push(`  and ${d.paths.length - 8} more`);
  if (a.checks?.length) lines.push(`checks: ${a.checks.join(", ")}`);
  lines.push(`risk: ${a.risk}`);
  if (a.skeptic) lines.push(`skeptic: ${a.skeptic}`);
  if (a.expires_at) lines.push(`expires: ${a.expires_at}`);
  return lines.join("\n");
}

/** The shortest card that can still carry a tap, used if the full one fails. */
function fallbackCard(a, reason) {
  return [
    `NEEDS YOUR TAP  ${a.id}`,
    `does: merge ${a.repo} PR #${a.pr_number} at ${a.head_sha.slice(0, 10)}`,
    `the full card did not send (${reason}); details are in the approval record`,
  ].join("\n");
}

export async function sendCard(approval) {
  const a = validateApproval(approval);
  const keyboard = keyboardFor(a.id);
  try {
    return await sendText(buildCard(a), { keyboard });
  } catch (err) {
    // The buttons are the point of a card. If the full text will not go
    // through, a minimal tappable card beats nothing arriving at all.
    console.error(String(err.message));
    return await sendText(fallbackCard(a, err.message), { keyboard });
  }
}

async function main(argv) {
  if (argv[0] === "--text") {
    const text = argv.slice(1).join(" ");
    if (!text) throw new Error("--text needs a message");
    await sendText(text);
    return;
  }
  const path = argv[0];
  if (!path) throw new Error("usage: approve-card.mjs <approval.json> | --text <message>");
  const approval = JSON.parse(readFileSync(path, "utf8"));
  const result = await sendCard(approval);
  console.log(`card ${approval.id}: ${result.dryRun ? "printed (DRY_RUN)" : `sent in ${result.chunks} message(s)`}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
