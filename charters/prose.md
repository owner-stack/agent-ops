# The prose gate

Any text the company sends outside itself — a blog post, a campaign email, a
public reply — clears two passes before the skeptic reads it. Internal briefs
and approval cards are exempt. The person reading those chose to hire an
agent; they do not need its writing disguised.

## Pass 1: words

The tells everyone already knows. Em dashes doing a period's job. "Here's the
thing." Balanced not-X-but-Y pairs, more than once per piece. Hedges ("can
be", "may help", "typically") where a plain claim belongs. Everything in
threes. Statistics with no named source. Cut them all — and know that this
pass is nowhere near enough. Professional word-level rewriting moves AI
detection by under two points.

## Pass 2: structure

The durable fingerprint is structural. Discourse-level classifiers separate
AI text from human text at roughly 93% accuracy with every word-level feature
withheld (StoryScope, Russell et al. 2026, arXiv:2604.03136). Audit the
outline, not the prose:

1. **Stated lesson.** A model explains its point, then restates it at every
   section end. State the point once, where it lands hardest, and cut the
   paragraph that re-tells what the reader just read. Let one example go
   uninterpreted.
2. **Tidiness.** A model writes one unbroken chain where everything raised
   gets resolved. One tangent that only obliquely relates, or one named
   question left standing, reads more human than a bow on top. So does
   ending on the spike instead of a quiet wrap-up coda.
3. **Emotion mode.** This inverts the workshop advice. A model performs
   feeling through the body ("chest tightened", "breath caught"); people
   mostly just say it ("honestly, this worried me"). Name the feeling. One
   earned image per piece, at most.
4. **Reference specificity.** "A popular productivity book" is a tell; the
   actual title is a fact. Every vague allusion becomes a name, a price, a
   date — or gets cut.
5. **Shape convergence.** Same opener, same arc, same closer as the last two
   pieces is the cluster detectors key on. Compare, and break the repeat.

Do not fix all five everywhere. A piece where every audit fired reads
template-shaped in a new way, and rarity is the human signal. Pick the one or
two that matter for this piece, and vary the pick across pieces.

## The backstop

```
node scripts/prose-scan.mjs --strict <draft>
```

Nonzero exit means rewrite before anyone downstream sees it. A quiet scan
clears only the grep-able slice; the five audits above still take judgment.

One boundary worth stating: this gate is about not sounding like a model.
Sounding like *you* is a voice document, and that file this repo cannot write
for you.
