const test = require('node:test');
const assert = require('node:assert/strict');

const guardian = require('../src/agents/guardian');
const extractor = require('../src/services/extractor');
const stages = require('../src/services/stages');
const trustedContacts = require('../src/services/trustedContacts');
const { recordingEmitter, EVENTS } = require('../src/realtime/events');
const { LlmClient } = require('../src/llm/client');

const SCAM = 'URGENT: Your SBI account will be blocked today. Share the OTP immediately.';
const LEGIT = 'Maa, what is for dinner today? I will reach home by 8.';

const llmSaying = (payload) => new LlmClient(
    { baseUrl: 'x', apiKey: 'placeholder', model: 'm', timeoutMs: 200 },
    { transport: async () => JSON.stringify(payload) }
);

const fakeSession = (overrides = {}) => ({
    sessionId: 's1',
    userId: 'u1',
    guardianState: guardian.STATES.MONITORING,
    messageCount: 1,
    decoyMessageCount: 0,
    firstSeenAt: new Date(),
    counterpartId: null,
    ...overrides,
});

const run = (text, options = {}) => guardian.handleMessage({
    session: options.session ?? fakeSession(),
    text,
    entities: extractor.extractEntities(text, { sessionId: 's1', messageId: 'm1', timestamp: new Date() }),
    scriptStages: stages.tagWithRules(text).map((t) => t.stage),
    userId: 'u1',
    ...options,
});

// No database in this file, so every caller is simply unknown.
trustedContacts.invalidate();

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

test('the score is the sum of the weights that fired, and nothing else', () => {
    const scored = guardian.scoreMessage({ text: SCAM, entities: [], scriptStages: [] });
    const summed = scored.breakdown.reduce((total, line) => total + line.weight, 0);
    assert.equal(scored.rawScore, summed);
    assert.equal(scored.score, Math.min(guardian.MAX_SCORE, summed));
});

test('the score is capped at 100 and floored at 0', () => {
    const everything = 'This is CBI headquarters. A parcel with MDMA in your name was seized and a '
        + 'non-bailable warrant is ready. Do not tell anyone and do not disconnect. Transfer Rs 2 lakh '
        + 'to account 50100234567890 immediately, install AnyDesk, and share the OTP now. '
        + 'Click http://fake-cbi.in/verify. You have won a prize, pay the processing fee.';

    const scored = guardian.scoreMessage({ text: everything, entities: [], scriptStages: [] });
    assert.ok(scored.rawScore > 100, 'the weights really do exceed the cap here');
    assert.equal(scored.score, 100);

    const advisory = guardian.scoreMessage({
        text: 'Your bank will never ask for your OTP or PIN. Call back on the number printed on your card.',
        entities: [],
        scriptStages: [],
    });
    assert.ok(advisory.rawScore < 0, 'exculpatory rules can take it negative');
    assert.equal(advisory.score, 0, 'but the score itself never goes below zero');
});

test('each breakdown line names the rule, its weight and why it fired', () => {
    const scored = guardian.scoreMessage({ text: SCAM, entities: [], scriptStages: [] });
    assert.ok(scored.breakdown.length > 0);
    for (const line of scored.breakdown) {
        assert.equal(typeof line.id, 'string');
        assert.ok(line.label.length > 0);
        assert.equal(typeof line.weight, 'number');
        assert.ok(line.description.length > 0);
        assert.equal(typeof line.hard, 'boolean');
    }
});

test('an unknown number counts for almost nothing on its own', async () => {
    const verdict = await run('Hello? Is this Ramesh tailor shop?', { from: '+919999999999' });
    assert.ok(verdict.firedSignals.includes('unknown_number'));
    assert.equal(verdict.score, 5);
    assert.equal(verdict.state, guardian.STATES.MONITORING);
});

test('no probability is invented anywhere in the verdict', async () => {
    const verdict = await run(SCAM);
    // Confidence is the score, the breakdown and the label. Nothing else.
    assert.equal(typeof verdict.score, 'number');
    assert.ok(Array.isArray(verdict.breakdown));
    assert.equal(typeof verdict.classifier.label, 'string');
    assert.equal(verdict.confidence, undefined);
    assert.equal(verdict.probability, undefined);
});

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

test('the documented thresholds map a score to a state', () => {
    const hard = ['credential_request'];
    assert.equal(guardian.stateFromScore(60, hard, guardian.DEFAULT_THRESHOLDS), guardian.STATES.DECOY_ACTIVE);
    assert.equal(guardian.stateFromScore(59, hard, guardian.DEFAULT_THRESHOLDS), guardian.STATES.SUSPICIOUS);
    assert.equal(guardian.stateFromScore(30, hard, guardian.DEFAULT_THRESHOLDS), guardian.STATES.SUSPICIOUS);
    assert.equal(guardian.stateFromScore(29, hard, guardian.DEFAULT_THRESHOLDS), guardian.STATES.MONITORING);
});

test('a high score with no hard signal cannot reach DECOY_ACTIVE', () => {
    // Authority claim, threat, urgency and a link add up past 60, but a worried
    // real utility message can produce exactly that combination.
    assert.equal(guardian.stateFromScore(85, [], guardian.DEFAULT_THRESHOLDS), guardian.STATES.SUSPICIOUS);
});

test('thresholds are configurable', async () => {
    const strict = await run(SCAM, { thresholds: { decoy: 95 } });
    assert.equal(strict.state, guardian.STATES.SUSPICIOUS, 'a higher bar withholds the hand-off');
    assert.equal(strict.thresholds.decoy, 95, 'the thresholds in force are reported back');

    const loose = await run('Your parcel is delayed, please pay 50 rupees to courier@ybl.', { thresholds: { decoy: 20 } });
    assert.equal(loose.state, guardian.STATES.DECOY_ACTIVE);
});

// ---------------------------------------------------------------------------
// The classifier's limits
// ---------------------------------------------------------------------------

test('the classifier can raise the state by one level', async () => {
    const text = 'Sir, we need you to confirm a few details about your account today.';

    const rulesOnly = await run(text);
    const withLlm = await run(text, { llm: llmSaying({ label: 'scam', reasons: ['asks to confirm account details'] }) });

    const ladderIndex = (state) => guardian.LADDER.indexOf(state);
    assert.equal(ladderIndex(withLlm.state), ladderIndex(rulesOnly.state) + 1);
    assert.ok(withLlm.notes.some((n) => /raised the state/i.test(n)));
});

test('the classifier cannot raise by two levels', async () => {
    const quiet = 'Hello, good morning. Is this Mr Sharma speaking?';
    const verdict = await run(quiet, { llm: llmSaying({ label: 'scam', reasons: ['cold opening'] }) });
    assert.equal(verdict.state, guardian.STATES.SUSPICIOUS, 'MONITORING can only become SUSPICIOUS');
});

test('the classifier cannot reach DECOY_ACTIVE without two rule signals', async () => {
    // One rule signal only, but a hard one worth 35, so the rules alone put
    // this at SUSPICIOUS. One rung up would be DECOY_ACTIVE, and that is the
    // jump the two-signal gate exists to block.
    const oneSignal = 'Please install AnyDesk.';
    const scored = guardian.scoreMessage({ text: oneSignal, entities: [], scriptStages: [] });
    assert.equal(scored.fired.length, 1, 'exactly one rule fired');
    assert.equal(
        guardian.stateFromScore(scored.score, scored.hardSignals, guardian.DEFAULT_THRESHOLDS),
        guardian.STATES.SUSPICIOUS
    );

    const verdict = await run(oneSignal, { llm: llmSaying({ label: 'scam', reasons: ['asks to install remote access'] }) });
    assert.notEqual(verdict.state, guardian.STATES.DECOY_ACTIVE);
    assert.ok(verdict.notes.some((n) => /withheld/i.test(n)));
});

test('one rung up from MONITORING is SUSPICIOUS, which needs no gate', async () => {
    const oneSignal = 'Please stay on the line.';
    const verdict = await run(oneSignal, { llm: llmSaying({ label: 'scam', reasons: ['keeps the victim on the line'] }) });
    assert.equal(verdict.state, guardian.STATES.SUSPICIOUS);
});

test('the classifier cannot reach DECOY_ACTIVE without a hard signal either', () => {
    const decision = guardian.decideState(
        { score: 55, fired: ['authority_claim', 'urgency', 'link'], hardSignals: [], label: 'scam' },
        guardian.DEFAULT_THRESHOLDS
    );
    assert.notEqual(decision.state, guardian.STATES.DECOY_ACTIVE);
    assert.ok(decision.notes.some((n) => /withheld/i.test(n)));
});

test('the classifier reaches DECOY_ACTIVE only when the rules have done the work', () => {
    const decision = guardian.decideState(
        { score: 45, fired: ['credential_request', 'urgency'], hardSignals: ['credential_request'], label: 'scam' },
        guardian.DEFAULT_THRESHOLDS
    );
    assert.equal(decision.state, guardian.STATES.DECOY_ACTIVE);
    assert.equal(decision.ruleState, guardian.STATES.SUSPICIOUS, 'the rules alone said suspicious');
});

test('a legit label caps the state at SUSPICIOUS', async () => {
    const verdict = await run(SCAM, { llm: llmSaying({ label: 'legit', reasons: ['looks like a real bank SMS'] }) });
    assert.equal(verdict.state, guardian.STATES.SUSPICIOUS);
    assert.ok(verdict.notes.some((n) => /legitimate/i.test(n)));
});

test('the classifier returns its reasons, and they are kept', async () => {
    const verdict = await run(SCAM, {
        llm: llmSaying({ label: 'scam', reasons: ['demands an OTP', 'threatens to block the account'] }),
    });
    assert.deepEqual(verdict.classifier.reasons, ['demands an OTP', 'threatens to block the account']);
    assert.equal(verdict.classifier.available, true);
});

test('a malformed label falls back to suspicious rather than being trusted', async () => {
    const verdict = await run(LEGIT, { llm: llmSaying({ label: 'definitely-a-scam', reasons: [] }) });
    assert.equal(verdict.classifier.label, 'suspicious');
});

test('a broken classifier does not stop detection', async () => {
    const broken = new LlmClient(
        { baseUrl: 'x', apiKey: 'placeholder', model: 'm', timeoutMs: 50 },
        { transport: async () => { throw new Error('provider down'); }, sleep: () => Promise.resolve() }
    );

    const verdict = await run(SCAM, { llm: broken });
    assert.equal(verdict.state, guardian.STATES.DECOY_ACTIVE, 'the rule layer still works');
    assert.equal(verdict.classifier.label, 'unavailable');
    assert.equal(verdict.classifier.available, false);
});

test('with no LLM at all the rules decide alone', async () => {
    const verdict = await run(SCAM, { llm: null });
    assert.equal(verdict.state, guardian.STATES.DECOY_ACTIVE);
    assert.equal(verdict.classifier.label, 'unavailable');
});

// ---------------------------------------------------------------------------
// The decision budget
// ---------------------------------------------------------------------------

test('a rule-only decision is far inside the 1.5 second budget', async () => {
    const verdict = await run(SCAM);
    assert.ok(verdict.decisionMs < 100, `took ${verdict.decisionMs}ms`);
});

test('a slow classifier cannot push the decision past the budget', async () => {
    const slow = new LlmClient(
        { baseUrl: 'x', apiKey: 'placeholder', model: 'm', timeoutMs: 10000 },
        {
            // Slower than the budget allows, but it does settle eventually: an
            // abandoned promise that never resolves upsets the test runner.
            transport: () => new Promise((resolve) => {
                setTimeout(() => resolve(JSON.stringify({ label: 'scam', reasons: [] })), 1800);
            }),
        }
    );

    const startedAt = Date.now();
    const verdict = await run(SCAM, { llm: slow });
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < guardian.DECISION_BUDGET_MS, `the whole decision took ${elapsed}ms`);
    assert.equal(verdict.classifier.available, false, 'the classifier was abandoned, not awaited');
    assert.match(verdict.classifier.note, /exceeded/i);
    assert.equal(verdict.state, guardian.STATES.DECOY_ACTIVE, 'and the rules still decided');
});

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

test('a scam moves MONITORING -> DECOY_ACTIVE and reports the takeover', async () => {
    const session = fakeSession();
    const verdict = await run(SCAM, { session });

    assert.equal(verdict.previousState, guardian.STATES.MONITORING);
    assert.equal(verdict.state, guardian.STATES.DECOY_ACTIVE);
    assert.equal(verdict.changed, true);
    assert.equal(verdict.engagedNow, true);
    assert.equal(verdict.shouldEngageDecoy, true);
    assert.equal(session.guardianState, guardian.STATES.DECOY_ACTIVE);
    assert.equal(session.scamDetected, true);
    assert.ok(session.takeoverAt instanceof Date);
});

test('SUSPICIOUS never engages the decoy', async () => {
    const suspicious = 'This is TRAI. Your Aadhaar has been misused for 17 SIM cards. Verify now.';
    const verdict = await run(suspicious);

    assert.equal(verdict.state, guardian.STATES.SUSPICIOUS);
    assert.equal(verdict.shouldEngageDecoy, false, 'suspicious warns, it never baits');
});

test('once engaged, a quieter message does not hand the thread back', async () => {
    const session = fakeSession({ guardianState: guardian.STATES.DECOY_ACTIVE });
    const verdict = await run('Are you still there?', { session });
    assert.equal(verdict.state, guardian.STATES.DECOY_ACTIVE);
});

test('while engaged, a conversation that turns legitimate releases the decoy', async () => {
    const session = fakeSession({ guardianState: guardian.STATES.DECOY_ACTIVE });
    const events = recordingEmitter();

    const verdict = await run(
        'Sorry, wrong number. I was trying to reach the tailor shop.',
        { session, events, llm: llmSaying({ label: 'legit', reasons: ['says it is a wrong number'] }) }
    );

    assert.equal(verdict.state, guardian.STATES.LEGIT);
    assert.equal(verdict.released, true);
    assert.equal(verdict.shouldEngageDecoy, false);
    assert.equal(events.of(EVENTS.RELEASED).length, 1);
});

test('a settled session is not re-escalated by a later message', async () => {
    for (const settled of [guardian.STATES.LEGIT, guardian.STATES.FALSE_POSITIVE, guardian.STATES.ENDED]) {
        const session = fakeSession({ guardianState: settled });
        const verdict = await run(SCAM, { session });
        assert.equal(verdict.state, settled, `${settled} must stay put`);
        assert.equal(verdict.shouldEngageDecoy, false);
    }
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

test('every scored message emits guardian.score with the full breakdown', async () => {
    const events = recordingEmitter();
    await run(SCAM, { events });

    const [scoreEvent] = events.of(EVENTS.SCORE);
    assert.ok(scoreEvent);
    assert.equal(scoreEvent.payload.sessionId, 's1');
    assert.equal(typeof scoreEvent.payload.score, 'number');
    assert.ok(Array.isArray(scoreEvent.payload.breakdown));
    assert.ok(scoreEvent.payload.breakdown.length > 0);
    assert.ok(scoreEvent.payload.classifier);
    assert.ok(scoreEvent.payload.thresholds);
    assert.equal(typeof scoreEvent.payload.decisionMs, 'number');
});

test('a transition emits guardian.state_changed with its reasons', async () => {
    const events = recordingEmitter();
    await run(SCAM, { events });

    const [changed] = events.of(EVENTS.STATE_CHANGED);
    assert.ok(changed);
    assert.equal(changed.payload.from, guardian.STATES.MONITORING);
    assert.equal(changed.payload.to, guardian.STATES.DECOY_ACTIVE);
    assert.ok(Array.isArray(changed.payload.reasons));
});

test('a hand-off emits guardian.takeover with the bilingual notice', async () => {
    const events = recordingEmitter();
    await run(SCAM, { events });

    const [takeover] = events.of(EVENTS.TAKEOVER);
    assert.ok(takeover);
    assert.equal(
        takeover.payload.notice.en,
        "Guardian has taken over this conversation. You don't need to reply."
    );
    assert.ok(takeover.payload.notice.mr.includes('गार्डियन'), 'the notice is also in Marathi');
});

test('a message that changes nothing emits a score but no transition', async () => {
    const events = recordingEmitter();
    await run(LEGIT, { events });

    assert.equal(events.of(EVENTS.SCORE).length, 1);
    assert.equal(events.of(EVENTS.STATE_CHANGED).length, 0);
    assert.equal(events.of(EVENTS.TAKEOVER).length, 0);
});

test('the Guardian works with no event transport at all', async () => {
    const verdict = await run(SCAM, { events: null });
    assert.equal(verdict.state, guardian.STATES.DECOY_ACTIVE);
});

// ---------------------------------------------------------------------------
// Alerts shown to the user and the family contact
// ---------------------------------------------------------------------------

test('SUSPICIOUS warns the user, advises a callback, and alerts family', async () => {
    const verdict = await run('This is TRAI. Your Aadhaar has been misused for 17 SIM cards. Verify now.');

    const kinds = verdict.alerts.map((a) => a.kind);
    assert.ok(kinds.includes('suspicious_warning'));
    assert.ok(kinds.includes('callback_advice'));
    assert.ok(kinds.includes('family_alert'));

    const callback = verdict.alerts.find((a) => a.kind === 'callback_advice');
    assert.match(callback.text.en, /call back on the number printed/i);

    const family = verdict.alerts.find((a) => a.kind === 'family_alert');
    assert.equal(family.simulated, true, 'the family alert is simulated, never delivered');
});

test('every alert is bilingual', async () => {
    const verdicts = [
        await run('This is TRAI. Your Aadhaar has been misused for 17 SIM cards. Verify now.'),
        await run(SCAM),
    ];

    for (const verdict of verdicts) {
        for (const alert of verdict.alerts) {
            assert.ok(alert.text.en && alert.text.en.length > 0, alert.kind);
            assert.ok(alert.text.mr && alert.text.mr.length > 0, `${alert.kind} has no Marathi`);
        }
    }
});

test('a takeover shows the user the notice and nothing alarming', async () => {
    const verdict = await run(SCAM);
    const kinds = verdict.alerts.map((a) => a.kind);
    assert.deepEqual(kinds, ['takeover_notice']);
    assert.equal(verdict.takeoverNotice.en, guardian.TAKEOVER_NOTICE.en);
});

test('a quiet message produces no alerts', async () => {
    const verdict = await run(LEGIT);
    assert.deepEqual(verdict.alerts, []);
});

// ---------------------------------------------------------------------------
// "This is genuine"
// ---------------------------------------------------------------------------

test('marking a session genuine ends it, with one neutral line', async () => {
    const session = fakeSession({ guardianState: guardian.STATES.DECOY_ACTIVE, counterpartId: '+919876543210' });
    const events = recordingEmitter();

    const result = await guardian.markGenuine({ session, events });

    assert.equal(result.state, guardian.STATES.FALSE_POSITIVE);
    assert.equal(result.previousState, guardian.STATES.DECOY_ACTIVE);
    assert.equal(result.handbackLine, 'Sorry, I got confused, please continue.');
    assert.equal(session.guardianState, guardian.STATES.FALSE_POSITIVE);
    assert.equal(session.scamDetected, false, 'no longer counted as a detected scam');
    assert.equal(session.falsePositive.markedByUser, true);
    assert.equal(session.falsePositive.previousState, guardian.STATES.DECOY_ACTIVE);
    assert.ok(session.falsePositive.markedAt instanceof Date);
});

test('marking a session genuine offers to remember the caller', async () => {
    const withCaller = await guardian.markGenuine({
        session: fakeSession({ guardianState: guardian.STATES.DECOY_ACTIVE, counterpartId: '+919876543210' }),
    });
    assert.equal(withCaller.offerTrustedContact, true);
    assert.equal(withCaller.counterpartId, '+919876543210');

    const withoutCaller = await guardian.markGenuine({
        session: fakeSession({ guardianState: guardian.STATES.DECOY_ACTIVE, counterpartId: null }),
    });
    assert.equal(withoutCaller.offerTrustedContact, false, 'nothing to offer when the caller is unknown');
});

test('marking a session genuine emits the transition and the release', async () => {
    const events = recordingEmitter();
    await guardian.markGenuine({
        session: fakeSession({ guardianState: guardian.STATES.DECOY_ACTIVE }),
        events,
    });

    const [changed] = events.of(EVENTS.STATE_CHANGED);
    assert.equal(changed.payload.to, guardian.STATES.FALSE_POSITIVE);

    const [released] = events.of(EVENTS.RELEASED);
    assert.equal(released.payload.reason, 'user_marked_genuine');
    assert.equal(released.payload.handbackLine, guardian.HANDBACK_LINE);
});

// ---------------------------------------------------------------------------
// Ending a session
// ---------------------------------------------------------------------------

test('ending a session moves it to ENDED and releases', async () => {
    const events = recordingEmitter();
    const session = fakeSession({ guardianState: guardian.STATES.DECOY_ACTIVE });

    const result = await guardian.endSession({ session, events, reason: 'reached 30 decoy replies' });

    assert.equal(result.state, guardian.STATES.ENDED);
    assert.equal(session.guardianState, guardian.STATES.ENDED);
    assert.equal(events.of(EVENTS.RELEASED)[0].payload.reason, 'reached 30 decoy replies');
});

// ---------------------------------------------------------------------------
// Trusted contacts
// ---------------------------------------------------------------------------

test('a trusted contact is released without engagement', async () => {
    const original = trustedContacts.lookup;
    trustedContacts.lookup = async () => ({ trusted: true, identifier: '+919876543210', contact: {} });

    try {
        const verdict = await run('Maa, I need 5000 urgently, send it to my UPI rahul@okaxis now.', {
            from: '+919876543210',
        });

        assert.equal(verdict.state, guardian.STATES.LEGIT);
        assert.equal(verdict.trustedContact, true);
        assert.equal(verdict.shouldEngageDecoy, false);

        // The message did look like a scam, so the user is told their contact
        // may be compromised rather than being left with nothing.
        const warning = verdict.alerts.find((a) => a.kind === 'trusted_contact_warning');
        assert.ok(warning, 'the user is warned about a possibly hacked contact');
        assert.match(warning.text.en, /may have been hacked/i);
    } finally {
        trustedContacts.lookup = original;
    }
});

test('a trusted contact sending something ordinary produces no warning', async () => {
    const original = trustedContacts.lookup;
    trustedContacts.lookup = async () => ({ trusted: true, identifier: '+919876543210', contact: {} });

    try {
        const verdict = await run(LEGIT, { from: '+919876543210' });
        assert.equal(verdict.state, guardian.STATES.LEGIT);
        assert.deepEqual(verdict.alerts, []);
    } finally {
        trustedContacts.lookup = original;
    }
});

test('the caller identifier is normalised before it is matched', () => {
    assert.equal(trustedContacts.normalizeIdentifier('98765 43210'), '+919876543210');
    assert.equal(trustedContacts.normalizeIdentifier('+91-98765-43210'), '+919876543210');
    assert.equal(trustedContacts.normalizeIdentifier('0919876543210'), '+919876543210');
    assert.equal(trustedContacts.normalizeIdentifier('Dr.Kulkarni@clinic'), 'dr.kulkarni@clinic');
    assert.equal(trustedContacts.normalizeIdentifier(''), null);
    assert.equal(trustedContacts.normalizeIdentifier(null), null);
});

// ---------------------------------------------------------------------------
// Scam family
// ---------------------------------------------------------------------------

test('the scam family is classified from the conversation', () => {
    assert.equal(guardian.classifyScamType('This is CBI, there is a warrant against you.'), 'digital_arrest');
    assert.equal(guardian.classifyScamType('Send it on PhonePe UPI please.'), 'upi_fraud');
    assert.equal(guardian.classifyScamType('Install AnyDesk so I can fix the virus.'), 'tech_support_scam');
    assert.equal(guardian.classifyScamType('Good morning, how are you?'), 'unknown');
});

// ---------------------------------------------------------------------------
// The signal table itself
// ---------------------------------------------------------------------------

test('the nine specified signals are all present, each with a fixed weight', () => {
    const required = [
        'authority_claim', 'threat', 'isolation', 'payment_demand', 'credential_request',
        'unknown_number', 'link', 'urgency', 'remote_access_app',
    ];
    const ids = guardian.SIGNALS.map((s) => s.id);
    for (const id of required) assert.ok(ids.includes(id), `missing signal ${id}`);

    for (const signal of guardian.SIGNALS) {
        assert.equal(typeof signal.weight, 'number');
        assert.ok(signal.weight > 0, `${signal.id} must carry a positive weight`);
        assert.equal(typeof signal.test, 'function');
    }
});

test('exculpatory rules all subtract', () => {
    for (const signal of guardian.EXCULPATORY) {
        assert.ok(signal.weight < 0, `${signal.id} should subtract from the score`);
    }
});

test('no single soft signal can reach the hand-off threshold alone', () => {
    for (const signal of guardian.SIGNALS.filter((s) => !s.hard)) {
        assert.ok(
            signal.weight < guardian.DEFAULT_THRESHOLDS.decoy,
            `${signal.id} alone would be enough to engage, which is too much for a soft signal`
        );
    }
});
