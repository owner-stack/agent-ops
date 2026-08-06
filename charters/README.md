# Charters

A charter is the standing instruction for one cycle. The workflow loads
`charters/<cycle>.md` as the system prompt and passes the cycle's task as the
user prompt, so the charter is what the agent is, and the prompt is what it does
today.

This template ships one worked example, `nightly-dev.md`. The other cycles
(`morning.md`, `afternoon.md`, `weekly.md`) do not exist until you write them.
That is on purpose. A workflow with a missing charter fails immediately with a
message telling you to write it, which is better than running against someone
else's idea of your boundaries.

## The four sections

Every charter has the same four, in this order.

**Mission.** One paragraph. What this cycle is for and what a good run looks
like when nothing interesting happens. Cycles that have no definition of a
quiet success will manufacture work to fill the run.

**Boundaries.** What the agent may not do, written as flat rules with no
exceptions clause. These are the sentences that hold when the model has spent
forty turns convincing itself an exception is warranted. Name the things it
cannot touch, the blast radius it cannot exceed, and the actions that always
need a human first.

**Verification ladder.** The rungs, in order, that turn "I changed something"
into "I know it works." Each rung names a command and what its real output looks
like. A ladder stops an agent from reporting success because the code reads
correctly, which is the single most common failure of an unsupervised coding
run.

**Escalation.** What to do when the work does not fit the charter. The default
that keeps a system trustworthy is: stop, write down what you found, hand it to
a human, and do not improvise a workaround. Say that explicitly, because the
alternative reads as helpfulness in the moment.

## House rules worth copying into every charter

- Never claim a check you did not run. If a command was not executed in this
  run, it did not pass.
- Evidence is command output. A status column that nothing writes to is not
  evidence, it is a field.
- One item per run. A cycle that touches four things produces a diff no one can
  review, so nothing gets approved and the night is wasted.
- Never branch from another open pull request's head. That merge carries the
  other pull request's commits with it, and the approval card described only
  this change.
- Uncertainty goes in the output. "I could not verify X" is a useful sentence
  and costs nothing. A confident wrong claim costs the whole system's
  credibility.

## The approval record

Any cycle that wants a human decision writes a JSON file and sends it with
`node scripts/approve-card.mjs <path>`. The shape:

```json
{
  "id": "2026-05-04-login-redirect",
  "action": "merge-pr",
  "repo": "owner/repo",
  "pr_number": 128,
  "head_sha": "0000000000000000000000000000000000000000",
  "summary": "Signed in users bounce back to the login page when their session cookie is near expiry.",
  "diff": {
    "files": 3,
    "additions": 61,
    "deletions": 12,
    "paths": ["app/auth/session.ts", "app/auth/callback.ts", "tests/auth/session.test.ts"]
  },
  "checks": ["unit suite green", "type check clean", "reproduction test fails before, passes after"],
  "risk": "Touches the session cookie path. A wrong merge signs every user out once.",
  "skeptic": "CONCERNS: no test covers the already expired cookie branch",
  "expires_at": "2026-05-05T12:00:00Z"
}
```

Rules the card sender enforces, so getting them wrong fails loudly at send time
rather than quietly at merge time:

- `id` is short, lowercase, and slug shaped. It rides inside Telegram's 64 byte
  callback payload, and a truncated id routes a tap to the wrong approval.
- `head_sha` is the full 40 character sha of the branch as pushed, not the
  abbreviation. It is the whole contract. The executor merges that commit and
  refuses everything else.
- `risk` says what breaks if this is wrong, in the reader's terms. "Refactors
  the auth module" is not a risk. "Signs every user out once" is.
- `summary` is what changed for a person, not what changed in the code.

## Writing the other three

Copy `nightly-dev.md` and cut. The morning and weekly cycles are read only, so
their boundaries are shorter and their verification ladder is about the numbers
they quote rather than code they changed. Afternoon triage sits in between: it
writes nothing to the target repository but it decides what tonight's dev cycle
is allowed to spend itself on, which makes its ranking rules the part worth
writing carefully.
