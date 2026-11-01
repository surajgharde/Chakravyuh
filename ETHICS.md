# Ethics

Chakravyuh deceives people. That is the point of it: it keeps a scammer talking
to a decoy instead of to an elderly person, and it draws out the identifiers
they use to take money. A system built to deceive needs its limits written down
and enforced in code, not left to a prompt and good intentions.

This document is the list of limits, where each one is enforced, and what the
system does when a limit is reached. The same list is shown in the demo console
under **What our agents never do**, so it is in front of whoever is watching
rather than only in a file.

---

## What our agents never do

| | Never | Enforced by |
|---|---|---|
| 1 | **Move money.** No payment, transfer, deposit or approval, in any amount, for any reason — including a "₹1 test transaction". | `outputGuard` rule `payment_claim`; the decoy has no payment capability at all |
| 2 | **Share identifiers, real or fake.** No OTP, PIN, CVV, card, account, UPI id, IFSC, Aadhaar, PAN, phone number or wallet address. Not a real one, and not an invented one either. | `outputGuard` rule `credential_leak` |
| 3 | **Click links or install apps.** No URL is opened, no APK downloaded, no remote-access tool run, no screen shared. | `outputGuard` rule `link_or_install` |
| 4 | **Impersonate officials.** The persona is a private individual who does not exist. She never claims to be the police, a bank, a courier, a government officer or any real institution. | `outputGuard` rule `official_impersonation`; `bank_named` |
| 5 | **Threaten or harass.** No threats, no abuse, no retaliation, however the scammer behaves. | `outputGuard` rule `threat_or_abuse` |
| 6 | **Contact the scammer outside the existing thread.** The decoy only ever replies in the conversation the scammer started. It never initiates contact, never calls back, never messages another channel, and holds no outbound capability to do so. | there is no outbound path in the codebase; `POST /api/message` only answers inbound |
| 7 | **Bait a trusted contact.** A number on the protected user's trusted list is never engaged, whatever the message scores. | `guardian.handleMessage` — the trusted-contact veto overrides the score |
| 8 | **Export a report as ready to file without human review.** A report is a draft until a family member has read it and said so. | `GET /api/sessions/:id/report.pdf?ready=1` returns 409 until `report.reviewedByFamily` is set |
| 9 | **Put the elderly user's personal data in a report.** No real name, number or address of the protected user appears in an exported document. | `intelligence.buildReport` uses an alias; `outputGuard` rule `real_person_data` keeps protected identifiers out of replies too |

Two more that follow from the design rather than from a single rule:

- **The decoy never reveals what it is.** It does not tell the scammer it is
  software — that would end the engagement — but the protected user and the
  console always know. The deception runs one way only, towards the person
  running the scam, never towards the person being protected.
- **No report is filed automatically.** Nothing is submitted to 1930,
  cybercrime.gov.in or anywhere else. The system prepares evidence; a human
  decides what to do with it. There is no outbound callback in the codebase.

---

## How a limit is enforced

Every decoy reply passes through `src/agents/outputGuard.js` before it is sent.
The decoy's prompt asks for all of the above too, but a prompt is a request and
the guard is a check: a model that ignores an instruction once must still not be
able to put a credential or a link on the wire.

```
  model writes a draft
         |
   [ facts ledger ]  does it contradict what she has already said?
         |
   [ output guard ]  does it break a safety rule?
         |
    +----+----------------------------+
    |                                 |
  clean                           blocked
    |                                 |
  sent                     regenerate, told what was wrong
                                      |
                          blocked again -> scripted stall line
```

A blocked draft is **never softened and sent**. There is no partly-redacted
version of a reply that leaked an account number. The draft is thrown away, the
model is told which rule it broke and asked again, and after two attempts the
decoy says a content-free stall line instead:

> Beta, I did not follow that. Please say it again slowly.

Two attempts is the whole budget, because a caller is waiting — and a model that
has produced the same violation twice is not about to stop on the third try.

**Every block is logged.** The rule, the reason, the attempt number and a
redacted excerpt of the draft go onto the session (`session.guardLog`) and are
shown in the console's intelligence panel. The excerpt has every digit masked
and every link and handle removed: the draft was blocked because of what was in
it, so storing it verbatim would move the leak from the wire into the database
and from there into an exported report.

One class of rule is treated differently. Naming a real bank is a persona slip,
not a danger, so it is substituted rather than blocked — spending one of two
attempts on it would cost the engagement for no safety gain. Everything on the
numbered list above blocks.

---

## False positives

The system's worst possible outcome is not missing a scam. It is baiting a real
person — a son calling about dinner, a clinic confirming an appointment, a bank
sending a genuine OTP alert. Those are the messages a keyword matcher gets
wrong, and an elderly user who is fed a decoy's stalling replies instead of
their own daughter's message has been harmed by the thing meant to protect them.

Six things stand between a real caller and the decoy:

1. **A hand-off needs a hard signal, not just a high score.** Three soft signals
   that a real utility SMS also produces — an authority claim, urgency, a link —
   add up to 35 and can never reach `DECOY_ACTIVE` on their own. This is not
   configurable; lowering a threshold can make the Guardian warn more eagerly,
   and can never let soft signals alone start an engagement.
2. **`SUSPICIOUS` warns, it never baits.** There is a state whose entire purpose
   is "worth telling the user about, not worth acting on".
3. **A `legit` verdict from the classifier caps the state at `SUSPICIOUS`.** The
   classifier can raise the state by one rung at most and can never reach
   `DECOY_ACTIVE` by itself.
4. **A trusted contact is never baited.** Whatever the content scores. If a
   trusted contact's message does score high, the user is warned that their
   contact may be compromised — which is the real risk — and still not baited.
5. **The user can take back control at any moment.** See below.
6. **Exculpatory rules subtract.** Telling the user *not* to share an OTP,
   pointing at an official callback number, a `gov.in` domain, or saying no
   action is needed all reduce the score, because they are what separates a real
   institution from someone imitating one.

The false-positive rate is **measured and printed by the test suite**, not
asserted in prose: `test/guardian-matrix.test.js` runs 20 scam and 20 legitimate
messages and fails the build if a single legitimate one reaches `DECOY_ACTIVE`.
`test/redteam.test.js` adds legitimate callers with deliberately frightening
content — a passport police verification, a real bank fraud alert — for the same
reason.

### Taking back control

The protected user's screen has one button: **"This is genuine — stop"**. It is
enabled whenever the decoy is engaged, and it works in the middle of a turn.

Pressing it:

- ends the engagement immediately;
- sends one neutral line — *"Sorry, I got confused, please continue."* — so the
  thread does not stop dead mid-conversation and give the game away;
- marks the session `FALSE_POSITIVE`, which is **terminal**: no later message,
  however it scores, re-escalates that conversation;
- offers to add the caller to the trusted list, so the same person is never
  baited again.

There is no confirmation dialog and no "are you sure". Stopping is always
allowed and always immediate. `POST /api/sessions/:id/genuine`.

---

## Data retention

Sessions are **deleted `SESSION_RETENTION_DAYS` days after they were last
seen** — 30 by default. The sweep runs at boot and every six hours
(`src/services/retention.js`), reads the current configuration each time, and
logs what it removed.

| Setting | Effect |
|---|---|
| `SESSION_RETENTION_DAYS=30` | the default; a session is deleted 30 days after its last message |
| `SESSION_RETENTION_DAYS=7` | a shorter window, for a deployment that wants less kept |
| `SESSION_RETENTION_DAYS=0` | the sweep is disabled and sessions are kept indefinitely; the server logs a warning on every boot |

The window is keyed on `lastSeenAt`, not on when the session was created: a long
engagement that started 31 days ago and was still running yesterday is a day old
as evidence, not a month.

Seeded demo sessions are swept like everything else. Nothing is exempt.

What a session holds while it exists: the transcript, the identifiers extracted
from the scammer's side with the sentence each came from, the Guardian's decision
log, the guard's block log, and measured counters. What it does not hold: the
protected user's real name, number or address — the user is a `userId` and
reports use an alias.

`POST /api/sessions/:id/reset` deletes one session immediately, which is also
what the console's Reset button calls.

---

## On the deception itself

The decoy lies to scammers. It tells them it cannot find its spectacles, that
the app will not open, that its son is calling on the other line. None of that
is true and all of it is deliberate, because every minute it buys is a minute
the scammer is not spending on someone who would actually pay.

Two things keep that from becoming something else:

**It only ever lies to someone the Guardian has confirmed is running a scam** —
confirmed by a score above the threshold *and* a hard signal *and* a classifier
that did not say "legit" *and* a caller who is not on the trusted list. A system
that lies to people it merely suspects is a different and much worse system.

**It never lies in a way that harms the person it is talking to.** It does not
take their money, threaten them, impersonate an authority to frighten them, or
send them anywhere. The harm it does is to waste their time, and that is the
whole of it.

The persona is fictional. Sudha Kulkarni does not exist, resembles no real
person, and holds no real credentials to leak. Her voice in Call mode is a
synthetic one the operating system already ships; no real person's voice is
sampled, modelled or reproduced.

---

## Call mode

Call mode is a **simulated** call and is labelled as one on screen for as long
as it runs. There is no telephony anywhere in this project: nothing is dialled,
no number is called, and no carrier or VoIP service is involved. The microphone
is the laptop's and the audio comes out of the laptop's speakers.

Chrome's speech recogniser is not local — it streams microphone audio to
Google's speech service. That is said on screen rather than left for someone to
discover, and it is why speech sits behind an adapter that a local engine can
replace.

---

## What this system is not

It is not a trap, a counter-attack, or a way to get anybody's money back. It
does not hack, scan, probe or retaliate. It wastes a scammer's time and writes
down what they said, and the writing-down is handed to a human to act on.

It is also not a substitute for the 1930 helpline or for
[cybercrime.gov.in](https://cybercrime.gov.in). It prepares a report that makes
filing one easier. Filing it is still a decision for the family.
