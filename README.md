# Chakravyuh

A defensive three-agent system that protects an elderly user in India from scam
calls and chats. It detects a scam in real time, takes over the conversation with
a believable decoy to waste the scammer's time and draw out their payment
identifiers, and packages the evidence for the 1930 cyber-fraud helpline.

Built for **CYBER-01 "Scam-Baiting Agents"**.

Based on [github.com/swayam-8/FINAL_HONEYPOT_AI](https://github.com/swayam-8/FINAL_HONEYPOT_AI),
which was written for a different hackathon. The Express and Mongoose session
layer and the identifier extractor come from that project. The detection,
persona, scoring and reporting have been rebuilt — see
[What changed from the original](#what-changed-from-the-original).

---

## Status

Phases 1 to 3 are complete: the repo is cleaned up, the scoring hacks are gone,
the three agents are wired end to end behind a working API, extraction produces
auditable evidence in English, Hindi and Marathi, and the Guardian owns the
session state with a measured zero false-positive rate on its test corpus.

| Part | State |
|---|---|
| Guardian — scoring, state machine, hand-off | working; 10 weighted signals, 6 states, Socket.IO events |
| False-positive protection — trusted contacts, "This is genuine" | working |
| Decoy — elderly persona, target tracking | working, with guardrails and hard limits |
| Entity extraction — 13 types, full provenance | working; the original's false positives are fixed and under test |
| Script stage tagging — 9 stages, rules then LLM | working |
| Intelligence report for 1930 / cybercrime.gov.in | not yet built |
| Cross-session identifier linking | not yet built |
| Operator console for the live demo | not yet built; a placeholder page is served |

---

## Running it

Requires Node 20 or newer.

```bash
npm install
cp .env.example .env     # then edit it
npm start
```

Only two variables actually need a value:

```env
API_SECRET_KEY=any-long-random-string
LLM_API_KEY=your-llm-api-key
```

MongoDB is optional. With `MONGO_URI` empty, the server starts an in-process
MongoDB for the session — nothing to install, nothing persisted. The first such
run downloads a MongoDB binary (~100 MB) and needs network access; set
`MONGO_URI` to your own instance to skip that.

`LLM_API_KEY` is also optional, though the system is weaker without it: the
Guardian falls back to its deterministic rules and the Decoy to scripted replies.
Both paths log that they are degraded, and the API reports
`decoy.source: "fallback"` so a demo can never pass a scripted line off as a
model response.

```bash
npm test     # 235 tests, no network and no LLM key needed
npm run dev  # restart on change
```

---

## How it works

```
                inbound message
                       |
              [ normalize to one shape ]
                       |
         [ entity extraction + provenance ]
                       |
            [ script stage tagging ]
            keyword rules, then one LLM call
                       |
                 [  GUARDIAN  ]
        10 weighted rule signals + bounded LLM label
              owns the session state machine
                       |
     +--------------+--+-----------+-------------+
     |              |              |             |
 MONITORING    SUSPICIOUS    DECOY_ACTIVE      LEGIT
  no reply       warn the      hand off      released,
                 user, no                    never baited
                 reply              |
                              [  DECOY  ]
                           persona reply, one
                           missing detail at a time
```

### Guardian

The Guardian receives every incoming message for a protected user, scores it,
and owns the session state. It is the only thing that can let the decoy speak.

**The state machine**

```
  MONITORING ──> SUSPICIOUS ──> DECOY_ACTIVE ──> ENDED
       │              │               │
       └──> LEGIT <───┘               └──> FALSE_POSITIVE
```

| State | Meaning | Decoy replies? |
|---|---|---|
| `MONITORING` | watching; nothing to act on | no |
| `SUSPICIOUS` | worth warning the user about | **no** |
| `DECOY_ACTIVE` | the decoy has the conversation | yes |
| `ENDED` | engagement finished on its own terms | no |
| `LEGIT` | released as a real caller | no |
| `FALSE_POSITIVE` | the user pressed "This is genuine" | no |

**Scoring**

Ten rule signals, each with a fixed weight, summed and capped at 100:

| Signal | Weight | Hard |
|---|---|---|
| `credential_request` — asks for an OTP, PIN, CVV or password | 35 | yes |
| `remote_access_app` — asks to install an app or share a screen | 35 | yes |
| `payment_demand` — pushes money to an account, UPI id, QR or wallet | 30 | yes |
| `threat` — arrest, legal action, a criminal accusation, or an immediate cut-off | 25 | no |
| `isolation` — tells the user to keep it secret or stay on the line | 20 | **yes** |
| `prize_or_fee_lure` — dangles a prize, or asks a fee before a benefit | 20 | no |
| `authority_claim` — claims to be a bank, government body, courier or telecom | 15 | no |
| `urgency` — an artificial deadline | 10 | no |
| `link` — a link, short link or obfuscated one | 10 | no |
| `unknown_number` — the sender is not a known contact | 5 | no |

Four *exculpatory* rules subtract, because they are what separates a real
institution from someone imitating one: telling the user **not** to share an OTP
(−20), pointing at an official callback channel (−15), a `gov.in` or known
utility domain (−15), and stating that no action is needed (−10).

`isolation` is marked hard deliberately. A real bank, clinic or courier never
tells someone to keep a call secret from their family or not to hang up.

The tenth signal, `prize_or_fee_lure`, goes beyond the nine this agent was
specified with. The nine are all built around pressure, so an advance-fee scam —
lottery, job offer, investment — topped out around 40 and could only ever be
warned about, never engaged. Those are among the most common scams run in India.

**Confidence**

There is no invented probability anywhere. What is shown is the score, the
breakdown of exactly which rules produced it, and the classifier's label, side
by side:

```json
"guardian": {
  "state": "DECOY_ACTIVE",
  "score": 85,
  "rawScore": 85,
  "breakdown": [
    { "id": "credential_request", "label": "Credential request", "weight": 35, "hard": true,
      "description": "Asks for an OTP, PIN, CVV, password or card number" },
    { "id": "threat", "label": "Threat", "weight": 25, "hard": false,
      "description": "Threatens arrest, legal action, or an immediate cut-off" },
    { "id": "authority_claim", "label": "Authority claim", "weight": 15, "hard": false,
      "description": "Claims to be a bank, government body, courier or telecom" },
    { "id": "urgency", "label": "Urgency", "weight": 10, "hard": false,
      "description": "Imposes an artificial deadline" }
  ],
  "classifier": { "label": "scam", "reasons": ["demands an OTP", "threatens to block the account"] },
  "thresholds": { "decoy": 60, "suspicious": 30, "release": 30 },
  "decisionMs": 2
}
```

**Thresholds** (configurable via `GUARDIAN_*` in `.env`): 60 or above is
`DECOY_ACTIVE`, 30–59 is `SUSPICIOUS`, below 30 is `MONITORING`.

Scoring runs over the whole conversation, not just the newest line. A script
that arrives spread across turns — "this is CBI" first, "transfer to this
account" second — still adds up.

**The classifier's limits**

A short LLM call returns `{label: scam | suspicious | legit, reasons[]}`. It is
deliberately boxed in:

- it can raise the state by **one** rung at most;
- it can never reach `DECOY_ACTIVE` unless at least **two** rule signals have
  fired and one of them is **hard**;
- a `legit` label caps the state at `SUSPICIOUS`, whatever the score;
- it gets a 1.1 second budget and is abandoned if it exceeds it.

**False-positive protection**

This is the part the system is built around. Five independent guards:

1. **Trusted contacts.** Family, a doctor, a bank's real helpline. Their
   messages never reach the decoy, whatever the score. If the content does look
   like a scam, the user is warned that *their contact's account may have been
   hacked* and told to call them back on a number they already know.
2. **`SUSPICIOUS` never baits.** It warns the user, advises hanging up and
   calling back on the number printed on their card or bill, and shows a
   simulated alert to a family contact. No reply is ever sent.
3. **A hard signal is required**, not just a score. Authority claim + urgency +
   link clears 60 on arithmetic alone, and a real utility SMS produces exactly
   that combination.
4. **"This is genuine".** A button on the user's screen ends the engagement at
   any moment. One neutral line goes out — *"Sorry, I got confused, please
   continue."* — the session is marked `FALSE_POSITIVE`, it is never
   re-escalated, and the user is offered the chance to add the caller to their
   trusted contacts.
5. **Self-release.** While engaged, the Guardian keeps scoring and lets go on
   its own if the conversation turns out to be legitimate.

**Measured accuracy**

`npm test` prints this from 20 scam and 20 legitimate messages, on the rule
layer alone — no LLM key, no network:

```
                      DECOY_ACTIVE  SUSPICIOUS  MONITORING
  ----------------------------------------------------------
  actual scam (20)                13           7           0
  actual legitimate (20)           0           0          20
  ----------------------------------------------------------
  scam reaching DECOY_ACTIVE   13/20   (recall 65%)
  scam flagged at all          20/20   (engaged or warned)
  legitimate baited            0/20   (false-positive rate 0%)
  precision on engagement      100%
  slowest decision             4ms (budget 1500ms)
```

The legitimate half is deliberately hard: a real bank OTP SMS, a utility
reminder that mentions disconnection, a courier update carrying a link, an
insurance premium notice, a school fee receipt, a wrong number, and family
messages in Marathi and Hindi. The highest score any of them reaches is 15.

The 7 scams at `SUSPICIOUS` are *opening* messages — an authority claim with no
demand attached yet. A separate test feeds each one the message that
realistically follows, and every one escalates:

```
  UPI collect             40 SUSPICIOUS    ->   60 DECOY_ACTIVE
  tech support apk        45 SUSPICIOUS    ->   80 DECOY_ACTIVE
  TRAI SIM threat         50 SUSPICIOUS    ->   70 DECOY_ACTIVE
  safe account lure       45 SUSPICIOUS    ->   75 DECOY_ACTIVE
  video call arrest       35 SUSPICIOUS    ->   65 DECOY_ACTIVE
```

Raising single-message recall would mean lowering the hand-off bar. The
zero-false-positive guarantee is worth more than an earlier takeover.

**Hand-off**

Four Socket.IO events, each scoped to a `session:<id>` room:

| Event | When |
|---|---|
| `guardian.score` | every scored message, with the full breakdown |
| `guardian.state_changed` | any transition, with the reasons |
| `guardian.takeover` | the decoy has taken over |
| `guardian.released` | the decoy let go, or never engaged |

A client joins a room by emitting `watch` with a session id.

On takeover the user's screen shows, in both languages:

> Guardian has taken over this conversation. You don't need to reply.
>
> गार्डियनने हे संभाषण ताब्यात घेतले आहे. तुम्हाला उत्तर देण्याची गरज नाही.

The scammer sees nothing change: the decoy continues the same thread in the
same tone, and no marker, disclaimer or greeting is inserted at the switch.

Every decision is budgeted at **1.5 seconds**. The rule layer runs in single
digits of milliseconds; the classifier gets whatever is left minus a margin and
is abandoned, not awaited, if it overruns. A test asserts the whole decision
stays inside the budget even when the model takes 1.8 seconds to answer.

### Decoy

Mrs. Sunita Sharma, 68, a retired primary school teacher in Pune. Fictional, and
defined in exactly one place (`src/agents/decoy.js`). She speaks the English
many elderly Indians speak, with a few Hindi words mixed in.

She tracks which identifiers are still missing — bank account, UPI id, phone
number, email, reference number — and asks for one per reply, with a reason that
sounds like her own confusion rather than a question. **If an ask goes
unanswered, she switches target rather than repeating it**, because repeating a
question is what exposes a decoy.

Her guardrails are in the prompt and enforced again on the way out:

- never reveals an OTP, PIN, CVV, card number, Aadhaar or account number — she has none
- never sends money, clicks a link, or installs anything
- never threatens, abuses or frightens the other person
- never claims to be a police officer, a bank official, or any real named person
- never breaks character to announce that the call is monitored
- stands down automatically after 30 replies or 45 minutes

A reply that violates the first or fifth rule is replaced before it is sent, and
the violation is recorded on the turn.

### Entity extraction

Thirteen types: `phone`, `bankAccount`, `ifsc`, `upiId`, `email`, `url`,
`apkLink`, `cryptoWallet`, `amount`, `impersonatedAuthority`, `caseRef`,
`aadhaar`, `pan`.

Every entity is stored with its full provenance, so a report sent to a helpline
can be audited line by line against the transcript:

```json
{
  "type": "bankAccount",
  "raw": "50100234567890",
  "normalized": "50100234567890",
  "sessionId": "wertyu-dfghj-ertyui",
  "messageId": "m3",
  "timestamp": "2026-10-31T09:15:00.000Z",
  "sentence": "Lagech paach lakh khatyat 50100234567890 jama kara.",
  "method": "rules"
}
```

`raw` is what was written; `normalized` is what to act on. A phone number
becomes `+91XXXXXXXXXX` from any of `+91 98765 43210`, `0919876543210`,
`98765-43210` or `३२१०`-style Devanagari digits. An amount becomes whole
rupees, so `2 lakh`, `दो लाख` and `₹2,00,000` all arrive as `200000`.

Two rules keep the open-ended types honest:

**Claiming.** A digit run is offered to the specific detectors first — phone,
Aadhaar, PAN, IFSC, OTP, amount, date, case reference. Each match claims those
characters, and `bankAccount` only ever reads digits nothing more specific has
claimed. This is what stops a phone number, an Aadhaar or an OTP from being
filed as a mule account.

**Context.** Nine to eighteen digits become an account number only with a
qualifying word nearby — `a/c`, `account`, `beneficiary`, `IFSC`, `NEFT`,
`khata`, `खाते`, `खात्यात`, `खाता`. A bare number in a sentence is
not evidence of anything.

The language handling covers English, Hindi and Marathi, in Devanagari and
romanised. Numbers dictated aloud are read back (`nine eight seven...`,
`nau aath saat...`, `नऔ आठ सात...`), with `raw` keeping the spoken phrase.
A run of at least six digit-words is required, because `one`, `do`, `char` and
`sat` are ordinary words in all three languages and a dictated number is always
long.

Obfuscated links are normalised but `raw` keeps the obfuscation:
`hxxp://sbi-verify[.]co[.]in/kyc`, `sbi-verify(dot)co(dot)in` and
`sbi-verify dot co dot in` all resolve to `http://sbi-verify.co.in/kyc`.
Short links are flagged, and anything ending `.apk` is its own type.

### Script stage tagging

Scam calls follow a script, and the same operation reuses the same sequence.
Each scammer-side message is labelled with zero or more of nine stages:

`CONTACT`, `AUTHORITY_CLAIM`, `ACCUSATION`, `THREAT`, `ISOLATION`, `URGENCY`,
`PAYMENT_DEMAND`, `CREDENTIAL_REQUEST`, `VERIFICATION_LURE`.

Keyword rules run first, across all three languages. One cheap LLM call then
covers **only the stages the rules did not find** — the prompt lists the
remaining candidates, so a paraphrase the vocabulary misses still gets labelled
without a second pass over settled ground. Every tag records its method:

```json
{ "stage": "ISOLATION", "method": "rules", "evidence": "konala sangu naka" }
```

A rule tag quotes the words it matched. An LLM tag quotes the message and is
marked `llm`. The model cannot overrule a rule tag, duplicate one, or invent a
stage outside the taxonomy. With no key, or on any LLM failure, the rule tags
stand alone.

The session accumulates every stage it has seen, in taxonomy order, which is
what makes one session's script comparable to another's.

### Measured numbers only

Every number the system reports is counted or clocked:

- `engagementDurationSeconds` — real elapsed time between the first and last
  message, from the server's own receive clock
- `messageCount`, `scammerMessageCount`, `decoyMessageCount` — counted
- `score` — the sum of the rule weights listed above, with the breakdown
  that produced it; there is no separate probability
- `decisionMs` — how long the Guardian actually took on this message
- `newEntitiesThisTurn` — entities actually added this turn, with
  `newEntityTypesThisTurn` naming which kinds

`REPLY_DELAY_MS` can add a cosmetic pause before a decoy reply for a live demo.
It defaults to `0`, is reported separately as `simulatedReplyDelayMs`, and is
excluded from every engagement figure.

---

## API

Every route except `/health` needs an `x-api-key` header. The server refuses to
start without `API_SECRET_KEY`, so there is no configuration in which the
endpoints are open.

### `POST /api/message`

Both transcript shapes are accepted and converted to one internal form. In
`{sender, text}`, `sender` is the real-world speaker, so `sender: "user"` is the
person being protected. In `{role, content}`, `role` is a chat position, so
`role: "user"` is the counterparty and `role: "assistant"` is our own decoy.

```json
{
  "sessionId": "wertyu-dfghj-ertyui",
  "message": {
    "sender": "scammer",
    "text": "Your bank account will be blocked today. Share the OTP immediately.",
    "timestamp": 1770005528731
  },
  "conversationHistory": [],
  "metadata": { "channel": "SMS", "language": "English", "locale": "IN" }
}
```

Response on a confirmed scam — `reply` is what the decoy said:

```json
{
  "status": "success",
  "sessionId": "wertyu-dfghj-ertyui",
  "reply": "Haan beta, I want to do it, but my app is asking for an account number. Which number should I type?",
  "action": "decoy_engaged",
  "guardian": {
    "stage": "engage",
    "scamDetected": true,
    "confidence": 0.75,
    "scamType": "bank_fraud",
    "hasHardSignal": true,
    "handedOffThisTurn": true,
    "signals": [
      { "id": "otp_or_pin_request", "hard": true, "weight": 0.45,
        "description": "Asks for an OTP, PIN, CVV or password" },
      { "id": "urgency_pressure", "hard": false, "weight": 0.15,
        "description": "Artificial deadline or final-warning framing" },
      { "id": "account_threat", "hard": false, "weight": 0.15,
        "description": "Threatens that an account or service will be blocked" }
    ]
  },
  "decoy": { "askedFor": "bankAccounts", "source": "llm", "violations": [] },
  "scriptStages": {
    "thisMessage": [
      { "stage": "AUTHORITY_CLAIM", "method": "rules", "evidence": "SBI" },
      { "stage": "THREAT", "method": "rules", "evidence": "account will be blocked" },
      { "stage": "URGENCY", "method": "rules", "evidence": "immediately" },
      { "stage": "CREDENTIAL_REQUEST", "method": "rules", "evidence": "Share the OTP" }
    ],
    "session": ["AUTHORITY_CLAIM", "THREAT", "URGENCY", "CREDENTIAL_REQUEST"]
  },
  "entitiesThisTurn": [
    {
      "type": "impersonatedAuthority",
      "raw": "SBI",
      "normalized": "bank",
      "sessionId": "wertyu-dfghj-ertyui",
      "messageId": "m1",
      "timestamp": "2026-10-31T09:15:00.000Z",
      "sentence": "Your bank account will be blocked today.",
      "method": "rules"
    }
  ],
  "measured": {
    "messageCount": 2,
    "scammerMessageCount": 1,
    "decoyMessageCount": 1,
    "engagementDurationSeconds": 0,
    "newEntitiesThisTurn": 1,
    "newEntityTypesThisTurn": ["impersonatedAuthority"],
    "simulatedReplyDelayMs": 0
  },
  "intelligence": { "bankAccounts": [], "upiIds": [], "phoneNumbers": [] }
}
```

`GET /api/sessions/:sessionId` returns the same session with its full `entities`
array, the accumulated `scriptStages`, and each message's own stage tags.

On a legitimate caller, `reply` is `null` and `action` is `monitoring`. The
assessment is still returned, so the console can show *why* nothing happened.

### Other routes

| Route | Purpose |
|---|---|
| `GET /health` | no key required; reports whether an LLM, a database and a realtime transport are wired up |
| `GET /api/sessions` | the 50 most recent sessions |
| `GET /api/sessions/:sessionId` | one session in full: transcript, entities, score breakdown, stage tags |
| `POST /api/sessions/:sessionId/genuine` | the "This is genuine" button; ends the engagement, returns the neutral line |
| `POST /api/sessions/:sessionId/end` | end an engagement explicitly |
| `GET /api/trusted-contacts` | the protected user's trusted contacts |
| `POST /api/trusted-contacts` | add one (identifier, label, relationship) |
| `DELETE /api/trusted-contacts/:identifier` | remove one |

A protected user is identified by `metadata.userId` on a message, or
`?userId=` / the `x-user-id` header elsewhere. It defaults to `default-user`,
so nothing breaks in a single-user demo.

There is no outbound callback. The original posted every session to an external
scoring endpoint; the report is produced locally instead.

---

## Configuration

| Variable | Required | Default | Notes |
|---|---|---|---|
| `API_SECRET_KEY` | **yes** | — | 8+ characters. The process exits if unset. |
| `LLM_API_KEY` | no | — | Without it, rules-only detection and scripted decoy replies. |
| `LLM_BASE_URL` | no | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint. |
| `LLM_MODEL` | no | `gpt-4o-mini` | |
| `LLM_TIMEOUT_MS` | no | `20000` | One retry on a transient failure, then it gives up. |
| `MONGO_URI` | no | *(empty)* | Empty starts an in-process MongoDB. |
| `PORT` | no | `8080` | |
| `LOG_LEVEL` | no | `info` | `silent`, `error`, `warn`, `info`, `debug` |
| `REPLY_DELAY_MS` | no | `0` | Cosmetic only; excluded from all metrics. |
| `GUARDIAN_DECOY_THRESHOLD` | no | `60` | Score at or above which the decoy may engage. |
| `GUARDIAN_SUSPICIOUS_THRESHOLD` | no | `30` | Score at or above which the user is warned. |
| `GUARDIAN_RELEASE_THRESHOLD` | no | `30` | While engaged, a score below this plus a `legit` label releases. |

The hard-signal requirement for a hand-off is **not** configurable. Lowering
a threshold can make the Guardian warn more eagerly; it can never let three
soft signals alone bait a real caller.

---

## Layout

```
server.js                     boot: validate config, connect, listen
src/
  app.js                      Express app factory
  config/env.js               validation; fails closed on a missing API key
  llm/
    client.js                 the only LLM client: one key, one retry, a timeout
    errors.js                 LlmError with a code per failure mode
  agents/
    guardian.js               10 weighted signals, 6-state machine, hand-off policy
    decoy.js                  persona, objectives, pivot logic, output guardrails
  services/
    pipeline.js               one turn, end to end
    extractor.js              13 entity types, claiming + context rules, provenance
    stages.js                 9 script stages, keyword rules then one LLM call
    digits.js                 Devanagari digits, dictated numbers, money phrases
    trustedContacts.js        per-user allow list, cached, normalised identifiers
    normalize.js              both transcript shapes -> one internal shape
    db.js                     MongoDB, optional
    logger.js
  realtime/
    events.js                 Socket.IO transport, plus null and recording emitters
  models/
    Session.js                session, transcript, entities, score breakdown
    TrustedContact.js         one vouched-for number or handle per protected user
  middleware/auth.js          API key check, fails closed
  models/Session.js           session document and its measured metrics
  routes/api.js               HTTP surface
  public/                     placeholder page; the console lands here
test/                         node:test suite, no test framework to install
  scam-lines.test.js          15 realistic Indian scam lines, the extraction bed
  guardian-matrix.test.js     20 scam + 20 legitimate, prints the confusion matrix
  fixtures/messages.js        that corpus, shared with any offline tooling
docs/legacy/                  diagrams from the original project, unreferenced
```

---

## What changed from the original

The original repo was tuned to score well against a specific evaluation rubric.
That tuning had to come out before any of it could be trusted.

**Secrets.** `keys.txt` held 24 committed API keys and `.env.example` held a
real-looking MongoDB Atlas password. Both are deleted, `.gitignore` now covers
`.env*` and `keys*.txt`, and this repo was started with a fresh git history so
the keys were never pushed from here. *If you worked on the original, treat all
24 keys and that Atlas password as compromised and rotate them.*

**No real detection.** The prompt hardcoded `"isScam": true`, so every message
was baited, including a legitimate one. Replaced with the two-layer Guardian and
its three outcomes.

**Invented numbers.**

- A forced 19–23 second pause on every reply, to inflate a duration metric —
  removed; `REPLY_DELAY_MS` defaults to 0 and is excluded from metrics.
- `guviCallback.js` overrode the engagement duration to 185 seconds whenever a
  session reached nine turns — the whole file is gone; duration is now measured.
- `confidenceLevel` was an LLM-invented number that started at 0.80 and climbed —
  replaced with the documented weights.
- A "turn X of 10" scoreboard and an "items extracted N/3" counter in the prompt —
  both removed; a test asserts they do not come back.

**Prompt written for the wrong side.** The system prompt mixed in rules meant for
the scammer: *always provide a wallet or UPI*, *provide a fallback contact when
you share a link*, *ask for the OTP last*. A victim persona has no use for those.
Removed, with a test asserting they stay out.

**Inconsistent persona.** Male in the prompt, "Mrs. Sharma" in the README. Now
one definition, used everywhere.

**Auth that let everyone in.** The old check compared the request header against
`process.env.API_SECRET_KEY` directly, so with the variable unset a request
carrying no header passed on `undefined === undefined`. The process now refuses
to start without a key, and the middleware refuses to be constructed without one.

**History that was silently dropped.** The code read `{sender, text}` while the
README documented `{role, content}`, so a README-shaped history was discarded and
every conversation looked like it was starting over. Both shapes now normalize to
one internal form.

**A route that could not work.** `/api/callback-preview` called
`generatePayload()`, which did not exist — the endpoint threw on every request.
Gone along with the callback.

**Key rotation.** A pool of 24 keys was round-robined across sessions to dodge
rate limits. Replaced with one OpenAI-compatible client.

**Fake tests.** Six `verify_*.js` scripts needed a running server, a live
MongoDB, and a hardcoded key, and reported success by printing a checkmark for a
human to read. Replaced with 95 assertions under `node:test`.

**Extraction with no context.** The original matched bare patterns and filed
whatever came back. Every false positive below is now fixed, and each has a test
named after it:

- `support@fake-sbi.com` was also captured as the UPI id `support@fake` — the PSP
  must now be letters only with no domain continuing after it
- `919876543210` (a phone with its country code) was captured as a bank account
- a 12-digit Aadhaar number was captured as a bank account
- `UPI ID: 9876543210` was captured as a case id, from the bare word `ID`
- the URL pattern capped TLDs at six characters, missing longer ones
- the phone pattern's optional country-code group swallowed the preceding space,
  storing `" 9876543210"` and defeating de-duplication

Four more were found while building the replacement:

- a toll-free number collapsed to `18001234567` also yielded the phantom
  "mobile" `8001234567` sitting inside it
- a landline's separator was eaten by digit-joining, losing the number entirely
- `Pay Rs. 50000` was split into two sentences at `Rs.`, separating the currency
  marker from its amount, so it stopped being read as money at all
- a UPI id at the end of a sentence (`refund@okaxis.`) was rejected by the
  trailing full stop

**Detection that only worked in English.** Found by running a romanised Marathi
digital-arrest script through the finished pipeline: it reached 0.50 and stalled
at `WATCH` despite naming a mule account. The Guardian now also scores script
stage signals, which are tagged in all three languages.

### Still carried over, deliberately

The Express and Mongoose session layer, and the decoy's idea of tracking
still-missing details and switching target instead of repeating a question.

---

## Ethics

The decoy engages a confirmed scammer and nobody else. The design decisions that
enforce that:

- a hand-off requires a hard signal, not just a high score, so worry and urgency
  on their own are never enough
- an explicit legitimate verdict from the classifier vetoes hand-off entirely
- `WATCH` exists precisely so that "suspicious" does not mean "bait"
- the decoy's guardrails are checked on the way out, not only requested in a prompt
- it never impersonates a real person or a real institution — the persona is a
  private individual who does not exist
- it holds no real credentials to leak, and is instructed never to produce one
- engagement stops on its own after 30 replies or 45 minutes
- every reported number is measured, because a report sent to a helpline that
  contains an invented figure is worse than no report
- detection works the same in Hindi and Marathi as in English, so the protection
  does not quietly weaken for the people most often targeted
- every piece of evidence quotes the sentence it came from, so nothing in a
  report to the 1930 helpline has to be taken on trust
- a saved contact is never baited, whatever a message scores; the worst case
  for family is a warning that their own account may be compromised
- the protected user can end an engagement at any moment, and the system
  then stops treating that conversation as a scam permanently
- the false-positive rate is measured and printed by the test suite rather
  than asserted in prose

A fuller ethics note, and the false-positive handling shown in the demo, land
with the operator console.
