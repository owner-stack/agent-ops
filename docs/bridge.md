# The bridge

Telegram needs somewhere to deliver taps. The bridge is the one piece not in
this repo, because it belongs on whatever serverless host you already use, and
it is small enough to write in one sitting. Its whole contract:

```js
// POST from Telegram. Reject anything that is not from you, turn a tap into a
// repository_dispatch, and always answer 200 so Telegram stops retrying.
export default async function handler(req, res) {
  if (req.headers["x-telegram-bot-api-secret-token"] !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).send("no");
  }
  const cb = req.body?.callback_query;
  if (!cb) return res.status(200).send("ignored");
  // The authorization model, in one line: one chat may approve.
  if (String(cb.from?.id) !== process.env.TELEGRAM_CHAT_ID) return res.status(403).send("no");

  const m = /^ao:v1:(approve|reject):([a-z0-9._-]{1,40})$/.exec(cb.data ?? "");
  if (!m) return res.status(200).send("unrecognized");
  const [, decision, approvalId] = m;

  // Look up the approval record you stored when the card was sent, so the sha
  // comes from your side rather than from the callback payload.
  const approval = await loadApproval(approvalId);

  await fetch(`https://api.github.com/repos/${process.env.HQ_REPO}/dispatches`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.GH_TOKEN_DISPATCH}`, accept: "application/vnd.github+json" },
    body: JSON.stringify({
      event_type: "approval-decision",
      client_payload: { approval_id: approvalId, decision, repo: approval.repo, pr_number: approval.pr_number, head_sha: approval.head_sha },
    }),
  });
  res.status(200).send("dispatched");
}
```

Two details worth keeping. Answer 200 even on a path you ignore, or Telegram
retries the same update forever. And read the sha from your stored approval
record rather than from `callback_data`, which only has 64 bytes to work with
and should carry nothing but an id.

Register the webhook once the function is deployed:

```
curl -X POST "https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook" \
  -H 'content-type: application/json' \
  -d '{"url":"https://your-bridge.example.com/api/telegram","secret_token":"YOUR_WEBHOOK_SECRET"}'
```

The approval record shape the bridge loads from is in
[../charters/README.md](../charters/README.md). What the executor does with the
dispatch, and every check it runs before merging, is in the main
[README](../README.md#the-approval-flow-locked-to-a-sha).
