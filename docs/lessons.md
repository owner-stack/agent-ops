# Lessons that cost something

Each of these is a production incident from running this system daily, and each
one is why some rule in the charters or some check in the scripts exists.

**A notification path that cannot fail loudly will fail silently.** Telegram
rejects any single message over 4096 characters. It answers with HTTP 200 and
`{"ok": false, "description": "..."}` in the body, so a send that pipes the
response to `/dev/null` cannot tell a delivered card from a dropped one. A long
risk note is enough to cross the limit, and when it does, the whole card goes,
buttons included. That failure looks identical to a quiet week: no card, no
error, no tap, and the assumption that the agent simply had nothing to propose.
It ran for days before anyone went looking. The fix is two lines of discipline.
Chunk before sending, and parse the response body rather than the status code.
`approve-card.mjs` does both, and falls back to the shortest card that can still
carry a tap when the full one will not go through.

**A status column that nothing writes to is not evidence.** An agent auditing a
feature found a `verified` field, saw it on the record, and reported the feature
working. Nothing in the codebase ever set that field. The audit was confident,
specific, and wrong, and it was wrong in the most expensive direction, which is
declaring something safe. Evidence is command output, a query result, or a
request you actually made. A field that exists is a fact about the schema and
says nothing about behavior. Charters carry this rule explicitly now, and the
verification ladder asks for pasted output rather than a summary of it.

**Never base a pull request on another open pull request's head.** It reads as
efficient when the second change depends on the first. What it means is that
merging the second one merges the first one too, including whatever was still
being argued about in review, and your approval card described one of them. The
executor refuses any pull request whose base is not the default branch, and the
nightly charter forbids branching from anything else. If work genuinely depends
on unmerged work, that is a reason to wait, not a reason to stack.

**A depth 1 clone cannot reason about history.** Shallow clones are the sensible
default for CI and the wrong default here. Ask an agent when a behavior changed,
or what else touched a file, and with one commit of history it will answer
anyway, from the shape of the code and its own confidence. `git log` returning
almost nothing does not read as an error to a model, it reads as a small
project. Clone at full depth for anything that reasons about the past, or
unshallow before you ask.

**Distinguish designed stops from crashes in the alert text.** Exit 78 for the
monthly cap and 79 for the per run cap, with alerts that name them in plain
words. When every stop looks like a fire, you stop reading the alerts, and then
a real one arrives and does nothing.

**Do not cancel a run in flight.** `cancel-in-progress: true` looks tidy on a
scheduled workflow. A cancelled job runs zero further steps, including the
failure alert, so the run that vanished is indistinguishable from the run that
went fine.

Two more, both about the nested `claude` process that runs the skeptic, are in
the [skeptic pass](../README.md#the-skeptic-pass) section where the code they
explain lives.
