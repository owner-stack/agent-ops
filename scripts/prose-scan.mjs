#!/usr/bin/env node
/**
 * prose-scan.mjs
 *
 * Deterministic scan for structural AI-writing tells in outbound prose.
 *
 * Word-level tells (the famous ones: "delve", em dashes, rule of three) are
 * the weak signal — they decay with every model release and word-level
 * rewriting barely moves detection. The durable fingerprint is structural:
 * discourse-level classifiers separate AI text from human text at ~93%
 * accuracy from structure alone (StoryScope, Russell et al. 2026,
 * arXiv:2604.03136). The full structural audit takes judgment and lives in
 * charters/prose.md; this script flags the pattern-matchable slice:
 *
 *   embodied_emotion   emotion performed through the body ("her chest tightened")
 *   stated_lesson      takeaway/moral markers ("the lesson here is")
 *   tidy_closer        wrap-it-with-a-bow phrases in the final two paragraphs
 *   vague_allusion     unnamed authorities/works ("experts say", "a well-known book")
 *   metrics            paragraph-length uniformity, reader address, concrete numbers
 *
 * Usage:
 *   node scripts/prose-scan.mjs FILE [FILE ...]
 *   node scripts/prose-scan.mjs --html page.html      # strip tags first
 *   cat draft.md | node scripts/prose-scan.mjs -
 *   node scripts/prose-scan.mjs --json draft.md       # machine-readable output
 *   node scripts/prose-scan.mjs --strict draft.md     # exit 1 if any category
 *                                                     # meets its threshold
 *
 * Thresholds used by --strict (hits per document): every category >= 2.
 */

import { readFileSync } from "node:fs";

const PRONOUN = "(?:my|his|her|their|your|the)";

const EMBODIED_EMOTION = [
  `\\b${PRONOUN}\\s+(?:chest|throat|jaw|stomach|gut|shoulders?)\\s+(?:tighten|clench|knot|drop|sink|sag|constrict|seize|flip|turn|twist|churn)\\w*`,
  `\\b${PRONOUN}\\s+breath\\s+(?:caught|hitched|stalled)\\b`,
  "\\bcaught\\s+(?:my|his|her|their)\\s+breath\\b",
  `\\b${PRONOUN}\\s+heart\\s+(?:pound|hammer|race|sink|sank|lurch|clench|skip|stutter)\\w*`,
  "\\ba\\s+knot\\s+(?:of\\s+\\w+\\s+)?(?:in|form)\\w*",
  "\\bblood\\s+ran\\s+cold\\b",
  `\\b${PRONOUN}\\s+pulse\\s+(?:quicken|race|spike)\\w*`,
  `\\bsomething\\s+in\\s+${PRONOUN}\\s+\\w+\\s+(?:shift|loosen|settle|break|broke|unclench)\\w*`,
  "\\bpit\\s+of\\s+(?:my|his|her|their)\\s+stomach\\b",
  "\\b(?:cold|nervous)\\s+sweat\\b",
  `\\b${PRONOUN}\\s+(?:spine|skin|scalp|neck)\\s+(?:tingl|prickl|crawl)\\w*`,
  "\\bswallow(?:ed|s|ing)?\\s+hard\\b",
  `\\b${PRONOUN}\\s+hands?\\s+(?:trembl|shak|shook)\\w*`,
  "\\bexhal\\w+\\s+(?:a\\s+breath\\s+)?(?:I|he|she|they)\\s+(?:didn.t|had\\s+not|hadn.t)\\s+(?:know|known|realized?)\\b",
  "\\bbreath\\s+(?:I|he|she|they)\\s+(?:didn.t|hadn.t)\\s+(?:know|known|realized?)\\b",
];

const STATED_LESSON = [
  "\\bthe\\s+(?:lesson|takeaway|point|moral)\\s+(?:here\\s+)?is\\b",
  "\\bwhat\\s+this\\s+means\\s+for\\s+you\\b",
  "\\bif\\s+you\\s+take\\s+(?:one\\s+thing|only\\s+one\\s+thing|nothing\\s+else)\\b",
  "\\bhere'?s\\s+(?:the\\s+thing|what\\s+matters|what\\s+I\\s+want\\s+you\\s+to\\s+(?:take|remember))\\b",
  "\\bthe\\s+bottom\\s+line\\b",
  "\\bmoral\\s+of\\s+the\\s+story\\b",
  "\\band\\s+that'?s\\s+(?:the\\s+point|the\\s+whole\\s+point|why\\s+\\w[\\w\\s]{0,40}\\s+matters)\\b",
  "\\bthe\\s+(?:real|key|big)\\s+(?:insight|lesson|takeaway|idea)\\s+(?:here\\s+)?is\\b",
  "\\blet\\s+that\\s+sink\\s+in\\b",
  "\\bthe\\s+lesson\\s+(?:I|we)\\s+(?:learned|took)\\b",
  "\\bwhich\\s+is\\s+exactly\\s+why\\b",
];

const TIDY_CLOSER = [
  "^(?:so|ultimately|in\\s+the\\s+end|at\\s+the\\s+end\\s+of\\s+the\\s+day|looking\\s+back)\\b[,:]?",
  "\\bin\\s+the\\s+end\\b",
  "\\bat\\s+the\\s+end\\s+of\\s+the\\s+day\\b",
  "\\bultimately\\b",
  "\\bthe\\s+future\\s+(?:looks|is)\\b",
  "\\band\\s+(?:I|we)\\s+(?:finally\\s+)?(?:realized|understood|learned)\\s+that\\b",
  "\\bfull\\s+circle\\b",
];

const VAGUE_ALLUSION = [
  "\\b(?:experts?|researchers?|scientists|economists|psychologists|professionals)\\s+(?:say|agree|believe|argue|warn|suggest|estimate)\\b",
  "\\bstudies\\s+(?:show|suggest|have\\s+shown|indicate)\\b",
  "\\bresearch\\s+(?:shows|suggests|indicates|has\\s+shown)\\b",
  "\\ba\\s+(?:famous|popular|well-known|renowned|leading|prominent)\\s+(?:book|author|study|expert|entrepreneur|investor|writer|thinker|framework)\\b",
  "\\bas\\s+the\\s+(?:old\\s+)?saying\\s+goes\\b",
  "\\bthere'?s\\s+an?\\s+(?:old\\s+)?(?:saying|adage|quote)\\b",
  "\\bsome\\s+(?:people|critics|observers|folks)\\s+(?:say|argue|believe|claim)\\b",
  "\\bit'?s\\s+(?:often|widely|commonly)\\s+(?:said|believed|claimed)\\b",
  "\\byou'?ve\\s+probably\\s+heard\\s+(?:the\\s+saying|it\\s+said)\\b",
];

export const STRICT_THRESHOLDS = {
  embodied_emotion: 2,
  stated_lesson: 2,
  tidy_closer: 2,
  vague_allusion: 2,
};

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function stripHtml(text) {
  return text
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#?\w+);/g, (m, name) => {
      if (ENTITIES[name] !== undefined) return ENTITIES[name];
      if (name.startsWith("#")) {
        const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return Number.isNaN(code) ? m : String.fromCodePoint(code);
      }
      return m;
    });
}

function findHits(lines, patterns) {
  const hits = [];
  lines.forEach((line, i) => {
    const claimed = []; // spans already matched on this line, to dedup overlapping patterns
    for (const pat of patterns) {
      for (const m of line.matchAll(new RegExp(pat, "gi"))) {
        const start = m.index;
        const end = start + m[0].length;
        if (claimed.some(([s, e]) => start < e && end > s)) continue;
        claimed.push([start, end]);
        let excerpt = line.trim();
        if (excerpt.length > 100) {
          const from = Math.max(0, start - 40);
          excerpt = "..." + line.slice(from, from + 100).trim() + "...";
        }
        hits.push({ line: i + 1, match: m[0], excerpt });
      }
    }
  });
  return hits;
}

const paragraphsOf = (text) => text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
const wordsOf = (text) => text.match(/[A-Za-z']+/g) ?? [];

export function scan(text) {
  const lines = text.split("\n");
  const paras = paragraphsOf(text);
  const nWords = wordsOf(text).length || 1;

  const result = {
    embodied_emotion: findHits(lines, EMBODIED_EMOTION),
    stated_lesson: findHits(lines, STATED_LESSON),
    vague_allusion: findHits(lines, VAGUE_ALLUSION),
  };

  // tidy closers only matter near the end: scan the final two paragraphs
  const tail = paras.slice(-2).join("\n");
  const tailLines = tail.split("\n");
  const tailOffset = Math.max(lines.length - tailLines.length, 0);
  result.tidy_closer = findHits(tailLines, TIDY_CLOSER).map((h) => ({ ...h, line: h.line + tailOffset }));

  // ---- metrics (informational; not counted by --strict) ----
  const metrics = {};
  const paraLens = paras.map((p) => wordsOf(p).length);
  if (paraLens.length >= 5) {
    const mean = paraLens.reduce((a, b) => a + b, 0) / paraLens.length;
    if (mean > 0) {
      const pstdev = Math.sqrt(paraLens.reduce((a, b) => a + (b - mean) ** 2, 0) / paraLens.length);
      const cv = pstdev / mean;
      metrics.paragraph_length_cv = Math.round(cv * 100) / 100;
      metrics.uniform_paragraphs = cv < 0.35;
    }
  }
  const youCount = (text.match(/\byou(?:r|'re|'ll|'ve)?\b/gi) ?? []).length;
  metrics.reader_address_per_100w = Math.round((1000 * youCount) / nWords) / 10;
  const numCount = (text.match(/(?<![A-Za-z])[$€£]?\d[\d,.]*%?/g) ?? []).length;
  metrics.numbers_per_100w = Math.round((1000 * numCount) / nWords) / 10;
  if (nWords > 300 && numCount === 0) metrics.no_concrete_numbers = true;
  metrics.word_count = nWords;
  result.metrics = metrics;
  return result;
}

export const overThreshold = (result) =>
  Object.entries(STRICT_THRESHOLDS).some(([cat, t]) => result[cat].length >= t);

function report(name, result) {
  console.log(`\n=== ${name} ===`);
  let total = 0;
  for (const cat of ["embodied_emotion", "stated_lesson", "tidy_closer", "vague_allusion"]) {
    const hits = result[cat];
    total += hits.length;
    const flag = hits.length >= STRICT_THRESHOLDS[cat] ? " <-- over threshold" : "";
    console.log(`\n[${cat}] ${hits.length} hit(s)${flag}`);
    for (const h of hits) console.log(`  L${h.line}: "${h.match}"  |  ${h.excerpt}`);
  }
  const m = result.metrics;
  console.log(
    `\n[metrics] words=${m.word_count}  reader-address/100w=${m.reader_address_per_100w}  numbers/100w=${m.numbers_per_100w}` +
      (m.paragraph_length_cv !== undefined ? `  paragraph-CV=${m.paragraph_length_cv}` : "")
  );
  if (m.uniform_paragraphs) console.log("  NOTE: paragraph lengths are suspiciously uniform (CV < 0.35). Vary them.");
  if (m.no_concrete_numbers) console.log("  NOTE: 300+ words and zero concrete numbers. Add named specifics.");
  if (total === 0) {
    console.log(
      "\nClean on the grep-able tells. The judgment-level audits (stated theme, tidiness, shape convergence) still apply; see charters/prose.md."
    );
  }
}

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const files = argv.filter((a) => !a.startsWith("--"));
  if (files.length === 0) {
    console.error("usage: prose-scan.mjs [--html] [--json] [--strict] FILE [FILE ...]  ('-' for stdin)");
    process.exit(2);
  }
  let anyOver = false;
  const jsonOut = {};
  for (const path of files) {
    const name = path === "-" ? "<stdin>" : path;
    let text = readFileSync(path === "-" ? 0 : path, "utf8");
    if (flags.has("--html") || /\.html?$/.test(path)) text = stripHtml(text);
    const result = scan(text);
    if (flags.has("--json")) jsonOut[name] = result;
    else report(name, result);
    if (overThreshold(result)) anyOver = true;
  }
  if (flags.has("--json")) console.log(JSON.stringify(jsonOut, null, 2));
  process.exit(flags.has("--strict") && anyOver ? 1 : 0);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
