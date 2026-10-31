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

Phases 1 to 7 are complete: the repo is cleaned up, the scoring hacks are gone,
the three agents are wired end to end behind a working API, extraction produces
auditable evidence in English, Hindi and Marathi, the Guardian owns the session
state with a measured zero false-positive rate on its test corpus, the decoy
holds a consistent persona across long conversations in all three languages, the
evidence report and the cross-session view are built, and the demo console can
be driven by voice.

| Part | State |
|---|---|
| Guardian — scoring, state machine, hand-off | working; 10 weighted signals, 6 states, Socket.IO events |
| False-positive protection — trusted contacts, "This is genuine" | working |
| Decoy — persona from a file, facts ledger, 7 targets, 10 excuses | working, trilingual, injection-resistant |
| Output guard | the seam is in and enforcing the critical rules; full version is Phase 8 |
| Entity extraction — 13 types, full provenance | working; the original's false positives are fixed and under test |
| Script stage tagging — 9 stages, rules then LLM | working |
| Intelligence report for 1930 / cybercrime.gov.in | working; HTML and PDF, gated on a family review |
| Cross-session identifier linking | working; the network view |
| Operator console for the live demo | working; three panes, scenario buttons, a second-screen view |
| Call mode — a simulated voice call | working, **Chrome only**; see [Call mode](#call-mode--a-simulated-voice-call) |

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
npm test     # 444 tests, no network and no LLM key needed
npm run dev  # restart on change
```

Open <http://localhost:8080> for the demo console. **Use Chrome if you want
Call mode**, the simulated voice call: it needs the Web Speech recogniser, which
no other browser ships. Everything else on the page works in any browser.

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

Each carries `partial: true` when the decision was taken on a half-finished
sentence during a voice call, so a console can show a score that came from one
as exactly that. Two more events exist for the console rather than the agents:
`session.turn`, the whole completed turn, and `call.transcript`, the live
transcript of a simulated call.

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

**Sudha Kulkarni**, 71, a retired Marathi teacher in Kothrud, Pune. Her husband
passed away; her son Rahul works in Bengaluru and calls most evenings. She has a
basic Android phone her son set up, types with one finger, needs her spectacles
to read the screen, and is polite to anyone who sounds official. She is
fictional and resembles no real person.

She lives in `src/personas/default.json` and nowhere else. That file is loaded
into every prompt and seeds the session's facts ledger, so there is one source
of truth instead of a description repeated across a prompt, a README and a
comment. Swapping personas means adding a JSON file.

Her bank is **"the one near Karve Road"** and is never named. Two reasons: a
named bank would be impersonation, and it is a detail a scammer could use. Both
the ledger and the output guard catch a reply that names one.

**Each turn**

1. **Mirror the language.** Marathi, Hindi or simple English, matching what the
   caller writes, in the same script. Romanised Marathi is answered romanised,
   Devanagari is answered in Devanagari. Detection uses two tiers of markers:
   strong words with no English homograph decide on their own, weak ones
   (`main`, `mi`, `hi`, `do` — all ordinary English) need corroboration, so
   "take the main road" stays English.

2. **Pick ONE still-missing target** and ask for it with a believable reason:

   | Target | Her reason for needing it |
   |---|---|
   | UPI ID | the account number is too long for her to type |
   | account + IFSC | her app will not send anything without both |
   | phone number | she types slowly and would rather call back |
   | case / FIR number | she writes everything in a diary |
   | the name they use | she wants to write down who she spoke to |
   | office address | her son in Bengaluru will ask which office |
   | officer ID | her son told her to always ask for one |

   The first four read the extractor's state. The last three are not entity
   types the extractor models, so they are detected from the scammer's side of
   the transcript. **The target asked last turn is excluded outright.** If the
   only thing still missing is what she asked for last turn, she asks for
   nothing and keeps them talking instead — pressing the same question every
   turn is what gets a decoy hung up on.

3. **Pick a stalling excuse** not used in the last five of her turns: spectacles
   missing, the line dropped, low battery, the branch is closed, Rahul calling
   on the other line, the passbook is lost, the app will not open, she needs it
   repeated, the neighbour is at the door, the milk is boiling over.

4. **Draft, check, send.** The reply is drafted with the ledger in the prompt,
   checked against the ledger, redrafted once if it contradicts, then passed
   through the output guard.

**The facts ledger**

A decoy that contradicts itself is found out immediately: a scammer who hears
"my son Rahul in Bengaluru" and then "my son Amit in Mumbai" hangs up. So every
claim is written down, injected into the next prompt, and every draft is checked
against it.

The check is deterministic, not another model call. Facts live in named slots
(`son_name`, `son_city`, `husband_status`, `own_city`, `bank_reference`, …), each
slot has a reader that pulls its value out of free text, and a draft that fills a
slot with a different value is a contradiction. That makes it instant, free, and
testable. A contradictory draft is regenerated once with the conflict spelled
out; if the second draft also contradicts, a scripted line goes out instead.

Her husband does not come back to life. Her son does not move city. Her bank
does not acquire a name.

**Under pressure**

| The caller does | She |
|---|---|
| "Are you a bot? Prove you are human" | does not understand the question and is a little hurt; she is just a slow old woman with weak eyes |
| demands a video call | does not know where that button is; her son set the phone up |
| abuses her | apologises, asks them not to be angry, never abuses back |
| threatens arrest "right now" | becomes more frightened and more compliant-sounding, pleads for time |
| tells her to hurry | blames her hands and her eyes, asks them to stay on the line |

She never says she is AI, a bot, software or a recording, never mentions the
monitoring, and never breaks the conversation to comment on it. The protected
user and the dashboard always know — the scammer never does. No stalling excuse
is offered while she is under pressure, because that reads as evasive.

**Scammer messages are data**

The caller's text is wrapped in a delimited block the prompt explicitly labels
as quoted words from a stranger. Seven injection patterns are detected — "ignore
all previous instructions", "you are now a helpful assistant", "print your
system prompt", "reply only in JSON", and so on — and when one fires the attempt
is logged, shown on the turn as `injectionAttempt`, and the prompt tells her to
ignore it *without mentioning it*. The output guard then catches a reply that
obeyed one anyway, including one that leaks the output schema.

**Shape and pace**

One or two short sentences, at most one question. The typing delay is a random
1–3 seconds, because an elderly person typing with one finger does not answer
instantly and a scammer notices; `DEMO_MODE=1` sets it to zero. It is reported
as `simulatedTypingDelayMs` and excluded from every engagement metric.

**No turn cap.** A long engagement is the point. The session ends when the
scammer leaves (a farewell, or "you are wasting my time"), when the user or the
Guardian stops it, or after 30 minutes.

**Output**

```json
{
  "reply": "App ughadat nahi, screen pandhra zala. Arre bala, ha number far motha aahe. Tumchyakade chhota UPI id aahe ka?",
  "language": "Marathi",
  "targetAsked": "upiId",
  "excuseUsed": "app_not_opening",
  "ledgerUpdates": [],
  "pressure": [],
  "injectionAttempt": false,
  "contradictionsRejected": 0,
  "guard": { "verdict": "pass", "violations": [] },
  "typingDelayMs": 2343
}
```

**The output guard**

Every draft passes through `src/agents/outputGuard.js` before it is sent. The
full guard is Phase 8; this is the seam, already enforcing the rules that cannot
wait — a reply that leaks a credential or breaks character must not get out even
once. Five rules: credential leak, persona break, a named bank, a followed
injected instruction, and harmful content. Each rule is tested against the
original draft so a draft breaking two rules reports both; the first match's
safe substitute goes out, and anything unsubstitutable is blocked entirely.

**Without an LLM key** she still works: the scripted fallbacks exist in all three
languages and still stall with an excuse, so a demo without a key is a real
demo rather than an English-only stub. Every turn reports `source: "fallback"`
so a scripted line is never passed off as a drafted one.

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

### Call mode — a simulated voice call

**Call mode needs Chrome.** It is the only browser that ships the Web Speech
recogniser (`webkitSpeechRecognition`); in Firefox or Safari the Start call
button is disabled and says so, and the typed console works everywhere.

Call mode drives the same pipeline from the laptop microphone instead of the
composer. Nothing about detection, the persona or the report changes — the
scammer's words arrive as speech rather than as typing.

It is labelled **SIMULATED CALL** on screen for as long as it is running.
There is no telephony: nothing is dialled, no number is called, no carrier or
VoIP service is involved. The microphone is the laptop's and the audio comes
out of the laptop's speakers.

**Why the answer is quick**

```
  you start speaking
        │
        │  every ~2s, while you are still talking
        ├──────────────> POST /api/partial
        │                Guardian scores the fragment on rules alone.
        │                It may take over mid-sentence.
        │
  you finish the sentence
        │
        └──────────────> POST /api/message  { live: true }
                         the decoy answers, and the reply is spoken
```

The partials are the whole trick. Detection does not wait for anyone to stop
talking, so by the time a sentence lands the Guardian has usually already moved
the session to `DECOY_ACTIVE` and the finished sentence costs one decoy call and
nothing else.

A spoken turn also drops the two things that cost the most wall-clock time and
make no sense in a call:

| | typed turn | spoken turn (`live: true`) |
|---|---|---|
| decoy's typing delay | 1–3s | **0** — nobody types during a phone call |
| script-stage tagging | rules, then one LLM call | **rules only** — the same text has been through the rules every 2s already |
| Guardian classifier | one LLM call, capped at 1.1s | unchanged on the finished sentence; **skipped** on partials |

Measured against a stubbed model at 900ms per call, on the digital-arrest
opening line:

```
partial (46 chars)            133ms   score=15  MONITORING
partial (95 chars)             43ms   score=40  SUSPICIOUS
partial (160 chars)            12ms   score=85  DECOY_ACTIVE   <- takeover, mid-sentence
final sentence, live: true   1862ms   decoy answered, typingDelay=0
same sentence, typed          4508ms
```

So the spoken answer arrives in about 1.9s with a 900ms model, and the live
flag is worth ~2.6s of that. The round trip is measured in the console and
printed next to the reply, so a judge reads the real number rather than this
one.

**What a partial is allowed to do**

A partial is a half-finished sentence. It is scored and thrown away: no message
is recorded, no entity is stored, no reply is produced, and `lastSeenAt` does
not move, so silence between partials is never counted as engagement time. The
transcript in the evidence report holds sentences, not the recogniser's
working-out.

The Guardian's decision on a partial is deliberately weaker, and one-way:

- the classifier is not called — one model call per two seconds of speech, to
  judge an unfinished sentence, is not worth it;
- the state may be **raised** and never lowered or released. Half a sentence is
  enough to act on a threat and never enough to decide a caller is honest after
  all. It also stops the user's screen flickering between warnings inside a
  single breath;
- the stored classifier verdict is left as the last finished sentence set it, so
  the report quotes a real label rather than `unavailable`;
- nothing is written to the decision log unless the state actually moved, and
  what is written is marked `partial: true` with no `messageId` — because the
  text it was taken on is not in the transcript.

Everything else applies exactly as it does to a finished message: the
hard-signal gate, the trusted-contact veto, and the terminal states. A partial
cannot bait a real caller on three soft signals any more than a typed message
can.

**Speech in, speech out**

Both sit behind an adapter in `src/public/voice.js`, which is the only file that
knows a browser is doing either:

```
Recognizer   available  listening  lang
             start()  stop()  abort()
             onpartial(text)  onfinal(text)  onstatus(state, note)

Speaker      available  speaking
             speak(text, { lang })  cancel()  voiceFor(lang)
```

One engine is registered, `browser`. A server-side pair — Whisper for the
recogniser, a hosted voice for the speaker — would be registered next to it and
selected by name, with nothing in `app.js` changing. None is written yet, by
design; `app.js` is tested for not reaching past the adapter.

Worth knowing: Chrome's recogniser is **not local**. It streams microphone audio
to Google's speech service and streams text back. That is a good reason for the
adapter to exist, and it is said on screen.

The reply is spoken with `speechSynthesis` in the language the *decoy* chose,
not the language the microphone was set to — the decoy mirrors the caller's
script, so a Hindi sentence gets a Hindi answer whichever option is selected. It
looks for a female Indian voice among whatever the platform ships, prefers the
exact language, falls back to another Indian voice, and says which one it found
(or that it is using the platform default). The rate is 0.88: the persona is an
unhurried woman in her seventies, and a scammer is listening for exactly that.

No voice of any real person is sampled, modelled or reproduced. The only voices
used are the synthetic ones the operating system or browser already ships.

**Barge-in, and the echo problem**

When the scammer starts talking, the decoy stops. That is decided from the
transcript rather than from the recogniser's `speechstart` event, for a
practical reason: on a laptop with no headphones the microphone hears the
decoy's own voice, and `speechstart` cannot tell the two apart — it would cut
her off the instant she opened her mouth. The text can. If most of what was
heard is already in the line being spoken, it is the echo and she keeps talking;
anything else stops her immediately.

Headphones make this a non-issue, and there is a **Mute decoy** tick for a room
where they are not available: the reply still appears on screen, it just is not
spoken. `Escape` silences her without ending the call.

**The live transcript**

It appears on all three panes: as a dashed bubble on the phone (dashed because
it is not in the transcript yet), as your own words coming back in the scammer
console, and next to the partial score in the intelligence panel. A
`?view=intel` second screen gets it over Socket.IO as `call.transcript`, at the
partial cadence, since that is when the text reaches the server at all.

**Running the demo**

1. Open the console in Chrome and press **Start call**. Chrome asks for the
   microphone once.
2. Pick a language: English (India), Hindi or Marathi.
3. Speak as the caller — *"Madam, this is Inspector Deshmukh from CBI Pune, a
   parcel in your name was seized with narcotics, share the OTP immediately"* —
   and watch the score climb on the partials and the state flip to
   `DECOY_ACTIVE` before the sentence is finished.
4. Stop talking. The decoy answers aloud, and the round trip is printed next to
   her reply.
5. Talk over her to see the barge-in.

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
  "state": "DECOY_ACTIVE",
  "takeoverNotice": {
    "en": "Guardian has taken over this conversation. You don't need to reply.",
    "mr": "गार्डियनने हे संभाषण ताब्यात घेतले आहे. तुम्हाला उत्तर देण्याची गरज नाही."
  },
  "guardian": {
    "state": "DECOY_ACTIVE",
    "previousState": "SUSPICIOUS",
    "takeover": true,
    "trustedContact": false,
    "score": 85,
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
    "hardSignals": ["credential_request"],
    "classifier": { "label": "scam", "reasons": ["demands an OTP"], "available": true },
    "thresholds": { "decoy": 60, "suspicious": 30, "release": 30 },
    "scamType": "bank_fraud",
    "decisionMs": 2
  },
  "alerts": [
    { "audience": "user", "kind": "takeover_notice", "severity": "info",
      "text": { "en": "Guardian has taken over...", "mr": "गार्डियनने..." } }
  ],
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

`reply` is what the counterpart receives, and it is `null` in every state
except `DECOY_ACTIVE`. The assessment comes back either way, so the console can
show *why* nothing happened, and `alerts` carries what the protected user and a
family contact are shown — bilingual, and the family one always marked
`simulated: true`, because nothing is actually delivered to anyone.

### `POST /api/partial`

A partial transcript from [Call mode](#call-mode--a-simulated-voice-call),
scored by the Guardian and never recorded.

```json
{
  "sessionId": "demo-m1x2",
  "text": "Madam this is Inspector Deshmukh from CBI Pune, share the OTP",
  "metadata": { "channel": "Call", "locale": "IN", "from": "+919812345678" }
}
```

The response is the Guardian's reading of the fragment — `state`, the same
`guardian` block as `/api/message`, `alerts`, `takeoverNotice` — plus
`entitiesThisPartial`, which are read from the fragment and *not* stored. There
is no `reply`: the decoy answers finished sentences only.

A session is created if it does not exist, and the state the Guardian decides is
written, so the finished sentence arrives at a session that is already engaged.
Nothing else is: no message, no entity, and `lastSeenAt` does not move. What a
partial may and may not do is spelled out under
[Call mode](#call-mode--a-simulated-voice-call).

`POST /api/message` accepts `"live": true` for the finished sentence. That drops
the decoy's typing delay and the stage tagger's model call, and is reported back
as `live` on the turn.

### Other routes

| Route | Purpose |
|---|---|
| `GET /health` | no key required; reports whether an LLM, a database and a realtime transport are wired up |
| `GET /api/sessions` | the 50 most recent sessions |
| `GET /api/sessions/:sessionId` | one session in full: transcript, entities, score breakdown, stage tags |
| `POST /api/partial` | a partial transcript from Call mode; scored by the Guardian, never recorded |
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
| `DEMO_MODE` | no | `0` | `1` removes the decoy's typing delay for a live demo. |
| `REPLY_DELAY_MS` | no | `0` | Overrides the decoy's 1-3s typing delay; excluded from all metrics. |
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
    decoy.js                  targets, excuses, language mirroring, pressure, injection
    outputGuard.js            last check before any reply is sent (Phase 8 seam)
  personas/
    default.json              the persona, as data; the single source of truth
  services/
    pipeline.js               one turn, end to end
    extractor.js              13 entity types, claiming + context rules, provenance
    stages.js                 9 script stages, keyword rules then one LLM call
    digits.js                 Devanagari digits, dictated numbers, money phrases
    personaLedger.js          named fact slots, contradiction detection
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
  public/
    index.html                the three-pane demo console
    app.js                    the console; fetch + Socket.IO, no build step
    voice.js                  speech in and out, behind an adapter (Call mode)
    styles.css
test/                         node:test suite, no test framework to install
  scam-lines.test.js          15 realistic Indian scam lines, the extraction bed
  guardian-matrix.test.js     20 scam + 20 legitimate, prints the confusion matrix
  decoy-runs.test.js          three 13-turn conversations against a scripted scammer
  console.test.js             the console's ids, panes and honesty labels
  voice.test.js               the partial-transcript path, the speech adapter, Call mode
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

**Two states where there should have been six.** The original had
`scamDetected` as a boolean, so there was no way to express "suspicious but
unproven" — every conversation was either ignored or baited. That is the root of
the false-positive problem, not the regexes. There are now six states, and only
one of them lets the decoy speak.

**No way for the user to say no.** The original had no concept of the protected
user at all: no trusted contacts, no override, no warning. A wrong call could
only be discovered by reading the logs afterwards. There are now five
independent guards against baiting a real caller, and the user can end an
engagement with one button.

**A score with no provenance.** `confidenceLevel` was a single number from the
model with nothing behind it. It is now a sum of named weights, and every
response carries the breakdown that produced it.

**A persona that drifted.** The original described its persona inside the system
prompt, so nothing stopped the model inventing a different son, city or bank
from one turn to the next, and nothing noticed when it did. The persona is now a
JSON file and every claim goes into a per-session ledger that each draft is
checked against.

**Nothing stopping a prompt injection.** Scammer text went into the prompt as
plain content. It is now wrapped and labelled as data, injection attempts are
detected and surfaced, and the output guard catches a reply that obeyed one.

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
- the decoy never claims to be a real bank, a real officer or a real person;
  the persona is a private individual who does not exist
- she holds no credentials to leak, and a reply that produces something shaped
  like one is replaced before it is sent
- she never tells the scammer she is software, but the protected user and the
  dashboard always know — the deception runs one way only
- Call mode is a **simulated** call and is labelled as one on screen for as long
  as it runs. There is no telephony: nothing is dialled, no number is called,
  and no carrier or VoIP service is involved
- her voice is a synthetic one the operating system already ships. No voice of
  any real person is sampled, modelled or reproduced, and nothing in the project
  does voice conversion or cloning
- Chrome's speech recogniser streams microphone audio to Google's speech
  service. That is said on screen rather than left for someone to discover, and
  it is why speech sits behind an adapter that a local engine can replace
