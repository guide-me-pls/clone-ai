# WhatsApp phone bridge

**English** · [简体中文](mobile-whatsapp.zh-CN.md)

Clone AI can accept text from WhatsApp on the owner's phone and run it through
the same Main Agent used by the Mac app. The phone never connects directly to
the Mac runtime.

## Why WhatsApp instead of iMessage

Apple does not provide a supported bot API for iMessage or the Messages app.
Driving Messages.app through AppleScript or reading its local database is a
private, version-sensitive integration and is not suitable for a product that
must behave reliably after a macOS update. WhatsApp Cloud API has a supported
webhook and reply API, so it is the mobile channel implemented here.

WhatsApp uses the internet rather than SMS. It is **not guaranteed to be free**:
Meta can charge for business-initiated conversations or messages depending on
the account, region, and current platform rules. Check the current Meta pricing
page before enabling it. A normal reply to a user-initiated service conversation
may have a free allowance, but Clone AI does not assume or promise one.

## Data path

```text
iPhone WhatsApp
  -> Meta Cloud API webhook
  -> HTTPS tunnel
  -> clone-ai mobile WhatsApp bridge (127.0.0.1:4318)
  -> companion API (127.0.0.1, bearer protected)
  -> Main Agent / Run queue
  -> reply through Meta Graph API
  -> iPhone WhatsApp
```

The bridge is deliberately separate from the desktop window. It owns its own
SQLite inbox, verifies every raw webhook body, and only accepts allowlisted
phone numbers. The in-app wizard starts it as a detached local process, so
closing the desktop window does not stop it. Stop it from the same wizard when
you want to take the phone channel offline.

## Bind from the app

The shortest path is the in-app wizard:

1. Click **Connect phone** in the left sidebar, or open **Settings → Phone channel**.
2. Fill in the allowlisted WhatsApp number, Phone Number ID, Access Token, and
   App Secret. Generate a Verify Token, then click **Save and start bridge**.
3. If `cloudflared` is missing, click **Install cloudflared**. This uses
   Homebrew and requires an explicit in-app confirmation.
4. Click **Start free tunnel**, copy the generated HTTPS Webhook address, and
   copy the Verify Token.
5. In Meta's WhatsApp configuration, paste the callback URL ending in
   `/webhook`, paste the Verify Token, subscribe to `messages`, then send a
   message from the allowlisted phone.

The checklist in the app shows whether credentials are saved, the bridge is
running, the tunnel exists, Meta has completed its GET challenge, and a message
has arrived. Access Token and App Secret are write-only fields in this UI: they
are stored in `~/.clone/whatsapp.env` with mode `0600` and are never returned by
the status API.

## Configure Meta manually

1. Create a Meta app with the WhatsApp product and a test or production phone
   number.
2. Record the Phone number ID, App Secret, and a Cloud API access token.
3. Generate a random webhook verify token. Do not reuse the access token.
4. Put the values only in the shell or LaunchAgent environment:

```bash
export WHATSAPP_ACCESS_TOKEN='...'
export WHATSAPP_PHONE_NUMBER_ID='...'
export WHATSAPP_VERIFY_TOKEN='...'
export WHATSAPP_APP_SECRET='...'
export WHATSAPP_ALLOWED_NUMBERS='+8613800000000'
```

Multiple owners must be separated by commas. The allowlist is required; an
empty allowlist refuses every sender.

The older command-line LaunchAgent installer remains for recovery and
non-GUI setups. Choose either the app-managed bridge or the LaunchAgent,
not both: two processes cannot share one bridge port and inbox.

```bash
npm run mobile:install
```

This creates `~/.clone/whatsapp.env` with mode `0600` and a LaunchAgent plist.
Fill the env file (never put secrets in the plist), then follow the commands
printed by the installer. The file is read only by the bridge process.

## Run locally

```bash
npm run mobile:whatsapp
```

The bridge listens on `127.0.0.1:4318` and reports only non-secret startup data.
Set `CLONE_AI_WHATSAPP_PORT` to change the port.

Expose only that bridge through a temporary HTTPS tunnel:

```bash
cloudflared tunnel --url http://127.0.0.1:4318
```

Use the resulting HTTPS origin plus `/webhook` in Meta's webhook settings.
Subscribe to the `messages` field. Meta's verification request is handled by
`GET /webhook`; delivery events arrive at `POST /webhook`.

Do **not** expose the companion port (`4317`). The bridge is the only public
surface, and it does not implement configuration, approvals, connector
installation, or arbitrary API proxying.

## Safety and behaviour

- `X-Hub-Signature-256` is checked against the raw request body with
  HMAC-SHA256 and a timing-safe comparison.
- Unknown numbers, group messages, media, reactions, and status callbacks are
  ignored.
- The WhatsApp message id is the inbox primary key. Meta retries cannot run the
  same message twice.
- The same id is passed to the companion as `whatsapp:<message id>`. A retry of
  a completed turn returns the stored reply instead of invoking the model again.
- Messages are persisted before the webhook returns `200`. A crash leaves a
  recoverable `processing` row, which is retried after restart.
- If the standalone bridge is running but the desktop runtime is closed or
  busy, the message stays in the local queue and is retried with backoff. The
  owner receives one "queued, not executed" notice; a later retry sends the
  real reply.
- Long visible replies are split below the Cloud API's 4096-character limit
  and numbered.
- Failures are reported as failures. The bridge never claims that a task ran
  when the Main Agent was offline or the turn failed.
- Only visible reply text is sent to WhatsApp. Model-private reasoning, tool
  transcripts, tokens, and local file contents are not forwarded.

## Approving from the phone

When a step would affect an external system, the run pauses. The bridge polls
paused runs, issues a one-time code (eight characters), and sends it to the
allowlisted number:

```
需要你确认一项外部动作：
「发送周报」
回复 APPROVE 2345ABCD 执行，或 REJECT 2345ABCD 放弃。
10 分钟内有效，仅一次；转发这条内容不能用于审批。
```

Reply with `APPROVE <code>` or `REJECT <code>` (批准/拒绝 also work). The bridge
handles the reply itself — it never becomes a Main Agent turn — consumes the
code, calls the same approval endpoint the desktop uses, and answers with the
result. Codes are bound to one run and step, expire in ten minutes, are stored
only as a salted hash, and are replaced if a newer code is issued. A forwarded
message can never approve anything, whatever it says.

The request is journaled as `approval.requested`; the approval itself remains
`approval.granted`, so the trace shows both the question and the answer.

## Current limitation

The bridge runs on the Mac. If the Mac sleeps, the tunnel is down, or the bridge
is not running, Meta cannot deliver a new webhook. Meta may retry failed
deliveries, but the bridge does not promise a remote offline queue. The local
queue covers a closed desktop window or a busy Main Agent, not a powered-off
Mac. For always-on phone access, the next step is a small relay with an
authenticated outbound device connection; do not solve that by opening the
companion port to the internet.

## Tests

```bash
node --experimental-strip-types --test test/whatsapp-bridge.test.ts
```
