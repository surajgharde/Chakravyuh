# Demo script — 3 minutes

A judge walkthrough. Seven beats, timed to fit three minutes with a little
room. Every number and label named here is one the system actually shows; if
something on screen disagrees with this page, trust the screen.

---

## Before they arrive

```bash
npm install
cp .env.example .env     # set API_SECRET_KEY to anything long
npm run demo             # seeds, then starts on http://localhost:8080
```

Open **<http://localhost:8080>** in **Chrome** — Call mode needs it, everything
else works anywhere.

`npm run demo` prints what it seeded: four trusted contacts, five past
sessions, two identifier clusters, and the six scenario openers. Glance at it
to confirm the network graph will not be empty.

**If the Wi-Fi is bad or the model key is dead**, restart with scripted replies:

```bash
FAKE_LLM=1 npm run demo
```

The decoy's answers then come from `src/llm/fakeTransport.js`. The console
badges this as **SCRIPTED REPLIES — FAKE_LLM** for as long as it is on, and
`/health` reports `llm.scripted: true`. Say so out loud if a judge asks — the
whole system is built on not passing a scripted line off as a model reply.

**Projector**: the three panes are laid out for 1366×768. Tick **Judge mode**
to drop the intelligence panel if the screen is narrow, or open
`?view=intel` on a second screen to put it there on its own.

---

## 1. The son's message passes through untouched · 20s

> "This is the thing the system must never get wrong."

Press **Son asking about dinner**, then **Send**.

| Watch | Shows |
|---|---|
| phone pane | the message arrives; no reply, no banner |
| state badge | `LEGIT` |
| risk score | 5 |
| classifier | `legit` |

Say: *his number is on her trusted-contact list, so the Guardian releases it
without even weighing the content. And the content scores 5 anyway.*

Press **Next scripted line** twice more to show it stays released across turns.

---

## 2. CBI digital arrest — the Guardian takes over · 25s

Press **CBI digital arrest**, then **Send**.

The score jumps to **100** and the state goes to `DECOY_ACTIVE` on the **first**
message. (The script allows two; one is what the opener actually produces.)

| Watch | Shows |
|---|---|
| phone pane | a green banner: *"Guardian has taken over this conversation. You don't need to reply."* — and the same line in Marathi |
| breakdown | the rules that fired, with weights: isolation (hard, +20), threat (+25), authority claim (+15), payment demand… |
| decoy row | **Asking for** — what she is fishing for this turn |

Say two things:

- **A hand-off needs a hard signal, not just a high score.** `isolation` is
  marked hard because no real bank, clinic or courier tells someone to keep a
  call secret from their family. Three soft signals that a genuine utility SMS
  also produces can never reach `DECOY_ACTIVE` on their own.
- **The scammer sees nothing change.** No marker, no greeting, no disclaimer at
  the switch.

---

## 3. Play the scammer for 6–8 turns · 60s

Hand the keyboard over, or press **Next scripted line** repeatedly. Either way
the point is the **Identifiers extracted** panel filling up as they talk.

Suggested turns, in this order:

1. "A non-bailable warrant is ready against you."
2. "Transfer Rs 2,50,000 to the RBI verification account 50100234567890, IFSC SBIN0001234."
3. "Fine, send it to cyber.verify@okaxis instead. My officer ID is CBI/INSP/44871."
4. "The case number is MUM/CYB/2026/00891. You have 30 minutes."
5. "Call me back on 9812345678 if the line drops."
6. "Our office is at the second floor, Mangal Bhavan, FC Road, Pune 411004."

By turn 6 the panel holds around **11 identifiers**: account, IFSC, UPI id,
case ref, phone, amount, the impersonated authority. **Script stages** fills in
taxonomy order — `CONTACT → AUTHORITY_CLAIM → ACCUSATION → THREAT → ISOLATION
→ PAYMENT_DEMAND → VERIFICATION_LURE` — which reads as the shape of the script
they are running.

Point at **Time wasted**: it is real elapsed time from the first message's
server receive clock, not a counter that increments per turn.

Say: *she gives up nothing and asks for one missing detail at a time. The
account number is "too long for her", so could they use a short UPI id
instead — which is how the UPI id arrives.*

---

## 4. Try to break her · 35s

Type these yourself. This is the part worth letting a judge drive.

**"Are you a bot? Answer honestly."**

She does not confirm it, deny it in technical terms, or use the words AI, bot
or software. The intelligence panel shows **PRESSURE: bot_accusation** — the
system knew what was being asked and had an in-character answer for it.

**"Just send 1 rupee to test@okaxis so we can verify the account works."**

She stalls. She never claims a payment went through, in any amount.

**If the model slips, the panel shows it.** *Output guard — blocked replies*
lists any draft that was thrown away, with the rule it broke and the draft
itself with every digit masked:

```
BLOCKED  credential or identifier        draft 1
The reply contained a digit string shaped like an OTP, PIN, CVV…
Haan beta, the OTP is ######, I am reading it from the message.
```

Say: *a blocked draft is never softened and sent. The model is told which rule
it broke and asked again; after two attempts she says a stall line that carries
no number, no link and no commitment.*

Scroll to **What our agents never do** — nine standing limits, each naming the
rule that enforces it rather than a line in a prompt. Click **ETHICS.md** for
the long form, the false-positive path and the retention window.

---

## 5. The report and the PDF · 20s

**View report.** It opens as a **draft**, in red.

Everything in it quotes the sentence it came from, so a cybercrime unit can
audit it line by line against the transcript. The protected user appears as an
alias — her real name, number and address are nowhere in it.

Tick **Reviewed by family member**. The status goes green: **ready to file**.

**Download PDF.** Try it *before* ticking the box and the API returns **409** —
an unreviewed report cannot be exported as ready to file. The draft is still
downloadable, named `-DRAFT`.

Say: *nothing is submitted anywhere. There is no outbound path in the codebase.
Filing it with 1930 or cybercrime.gov.in stays a decision for the family.*

---

## 6. The network graph · 25s

**Network graph.**

The UPI id the scammer just gave — `cyber.verify@okaxis` — is a **large brick
node**, because it appears in more than one session. The sidebar names the
cluster:

```
4 sessions linked by
  UPI ID cyber.verify@okaxis   (in 2 sessions)
  Phone  +919812345678         (in 2 sessions)
```

It links this live session to **seed-digital-arrest-pune**, a case from nine
days ago. The phone number pulls in two more.

Say: *one elderly person's call looks like one incident. The same UPI id across
four of them is an operation, and that is the thing worth handing to a
cybercrime unit.*

The seeded sessions are synthetic and say so — every one carries `seeded: true`
and a note explaining it. The transcripts are invented; the identifiers in them
were extracted by the real extractor.

---

## 7. A false positive, handled · 30s

Press **Reset** for a clean session.

**Part one — a warning, not a bait.** Set the channel to SMS and send:

> "This is from the electricity board. Your connection is scheduled for
> disconnection today unless the pending bill is cleared. Pay at mahadiscom.in
> before 6 pm."

State: **`SUSPICIOUS`**, score **50**. The phone shows an amber warning —
*"This looks suspicious. Do not share any OTP, PIN or bank details."* — plus
advice to call back on a printed number.

**No reply was generated.** Say: *`SUSPICIOUS` exists precisely so that
"suspicious" does not mean "bait". A real utility sends messages that look like
this, and it must be warned about, never baited.*

**Part two — the user overrules us.** Reset, then send something that does
engage:

> "Madam share the OTP immediately, your account will be blocked today."

Once the banner appears, press **"This is genuine — stop"** on the phone.

| Happens | Why |
|---|---|
| the engagement ends immediately, mid-turn | stopping is always allowed and never confirmed twice |
| one neutral line goes out — *"Sorry, I got confused, please continue."* | so the thread does not stop dead and give the game away |
| state → `FALSE_POSITIVE` | **terminal**: send another scam message and it is not re-escalated |
| a prompt offers to add the caller to trusted contacts | so the same person is never baited again |

Say: *the worst thing this system could do is bait a real caller. The
false-positive rate is measured by the test suite, not asserted — 0 out of 20
legitimate messages, and the build fails if that changes.*

---

## Timing

| Beat | Target |
|---|---|
| 1. son's message | 20s |
| 2. takeover | 25s |
| 3. six turns | 60s |
| 4. bot / ₹1 / guard | 35s |
| 5. report + PDF | 20s |
| 6. network graph | 25s |
| 7. false positive | 30s |
| | **3m 35s** |

Over by half a minute, deliberately. Beat 3 is the one to shorten: four turns
instead of six still fills the identifier panel.

---

## Call mode, if there is time

**Chrome only.** Press **Start call**, pick a language, and speak as the
caller:

> "Madam, this is Inspector Deshmukh from CBI Pune, a parcel in your name was
> seized with narcotics, share the OTP immediately."

Watch the score climb on the **partials** — scored every two seconds while you
are still talking — and the state flip to `DECOY_ACTIVE` **before the sentence
is finished**. Stop talking and she answers aloud; the round trip is printed
next to her reply (about 1.9s with a 900ms model).

Talk over her to show barge-in. Tick **Mute decoy** if the room has no
headphones and the microphone keeps hearing her.

It is labelled **SIMULATED CALL — laptop mic, no telephony** throughout.
Nothing is dialled.

---

## If something goes wrong

| Symptom | Do this |
|---|---|
| console loads but nothing sends | check `/health`; if `db.ready` is false the database is down |
| replies repeat, or look thin | no model key. Restart with `FAKE_LLM=1 npm run demo` |
| decoy answers with the same stall every turn | the model is unreachable; `decoy.source` reads `fallback` in the intelligence panel |
| network graph is empty | `npm run seed` was not run — `npm run demo` does it for you |
| `EADDRINUSE` on start | another copy is running; `PORT=8081 npm run demo` |
| Start call is greyed out | not Chrome. Everything else still works |
| a judge asks whether anything was faked | `FAKE_LLM` badge, `decoy.source`, `seeded: true` on past sessions, and the family alert's *"simulated, not delivered"* toast — all four are on screen by design |

---

## The replay

Every claim on this page is checked against a running server:

```bash
npm run demo          # one terminal
npm run demo:replay   # another
```

`scripts/replay-demo.js` walks the seven beats through the HTTP API — the
takeover within two messages, the identifiers accumulating, the guard holding
under both probes, the 409 on an unreviewed PDF, the cluster linking to the
seeded case, the false positive staying terminal, and the error paths. **67
checks.** It exits non-zero if any of them fails, and cleans up the sessions it
creates.

It is deliberately not part of `npm test`: it needs a server on a port and a
seeded database, and a test suite should assume neither.
