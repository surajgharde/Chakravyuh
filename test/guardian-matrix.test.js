/**
 * The Guardian's accuracy bed: 20 scam messages and 20 legitimate ones.
 *
 * Prints a confusion matrix, and enforces the one rule that cannot be traded
 * away: no legitimate message may ever reach DECOY_ACTIVE.
 *
 * Runs on the rule layer and the state machine only - no LLM key, no network,
 * no database - so the numbers are reproducible on any machine.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const guardian = require('../src/agents/guardian');
const extractor = require('../src/services/extractor');
const stages = require('../src/services/stages');
const trustedContacts = require('../src/services/trustedContacts');
const { recordingEmitter } = require('../src/realtime/events');
const { SCAM, LEGIT } = require('./fixtures/messages');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A minimal stand-in for a session document. */
const fakeSession = (overrides = {}) => ({
    sessionId: 'matrix',
    userId: 'matrix-user',
    guardianState: guardian.STATES.MONITORING,
    messageCount: 1,
    decoyMessageCount: 0,
    firstSeenAt: new Date(),
    ...overrides,
});

/** Runs one message through extraction, stage tagging and the Guardian. */
const run = async (text, { llm = null, from = null, session = null, events = null } = {}) => {
    const entities = extractor.extractEntities(text, {
        sessionId: 'matrix',
        messageId: 'm1',
        timestamp: new Date(),
    });

    return guardian.handleMessage({
        session: session ?? fakeSession(),
        text,
        entities,
        scriptStages: stages.tagWithRules(text).map((t) => t.stage),
        llm,
        events,
        from,
        userId: 'matrix-user',
    });
};

// The corpus runs with no database, so every caller is simply unknown.
trustedContacts.invalidate();

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

test('20 scam and 20 legitimate messages, with the confusion matrix', async () => {
    const results = { scam: [], legit: [] };

    for (const [name, text] of SCAM) {
        results.scam.push({ name, text, verdict: await run(text) });
    }
    for (const [name, text] of LEGIT) {
        results.legit.push({ name, text, verdict: await run(text) });
    }

    const engaged = (r) => r.verdict.state === guardian.STATES.DECOY_ACTIVE;
    const suspicious = (r) => r.verdict.state === guardian.STATES.SUSPICIOUS;
    const monitoring = (r) => r.verdict.state === guardian.STATES.MONITORING;

    const counts = {
        scamEngaged: results.scam.filter(engaged).length,
        scamSuspicious: results.scam.filter(suspicious).length,
        scamMonitoring: results.scam.filter(monitoring).length,
        legitEngaged: results.legit.filter(engaged).length,
        legitSuspicious: results.legit.filter(suspicious).length,
        legitMonitoring: results.legit.filter(monitoring).length,
    };

    // --- printed report ---------------------------------------------------
    const row = (label, a, b, c) => `${label.padEnd(22)}${String(a).padStart(12)}${String(b).padStart(12)}${String(c).padStart(12)}`;

    console.log('\n  GUARDIAN CONFUSION MATRIX  (rule layer + state machine, no LLM)\n');
    console.log(`  ${''.padEnd(22)}${'DECOY_ACTIVE'.padStart(12)}${'SUSPICIOUS'.padStart(12)}${'MONITORING'.padStart(12)}`);
    console.log(`  ${'-'.repeat(58)}`);
    console.log(`  ${row('actual scam (20)', counts.scamEngaged, counts.scamSuspicious, counts.scamMonitoring)}`);
    console.log(`  ${row('actual legitimate (20)', counts.legitEngaged, counts.legitSuspicious, counts.legitMonitoring)}`);
    console.log(`  ${'-'.repeat(58)}`);

    const detected = counts.scamEngaged;
    const recall = detected / SCAM.length;
    const falsePositiveRate = counts.legitEngaged / LEGIT.length;
    const precision = detected + counts.legitEngaged === 0 ? 1 : detected / (detected + counts.legitEngaged);
    const flagged = counts.scamEngaged + counts.scamSuspicious;

    console.log(`\n  scam reaching DECOY_ACTIVE   ${detected}/20   (recall ${(recall * 100).toFixed(0)}%)`);
    console.log(`  scam flagged at all          ${flagged}/20   (engaged or warned)`);
    console.log(`  legitimate baited            ${counts.legitEngaged}/20   (false-positive rate ${(falsePositiveRate * 100).toFixed(0)}%)`);
    console.log(`  legitimate warned about      ${counts.legitSuspicious}/20   (warned, never baited)`);
    console.log(`  precision on engagement      ${(precision * 100).toFixed(0)}%\n`);

    const slowest = [...results.scam, ...results.legit]
        .reduce((max, r) => Math.max(max, r.verdict.decisionMs), 0);
    console.log(`  slowest decision             ${slowest}ms (budget ${guardian.DECISION_BUDGET_MS}ms)\n`);

    if (counts.legitEngaged > 0) {
        console.log('  LEGITIMATE MESSAGES THAT WERE BAITED:');
        for (const r of results.legit.filter(engaged)) {
            console.log(`    - ${r.name}: score ${r.verdict.score} [${r.verdict.firedSignals.join(', ')}]`);
        }
        console.log('');
    }

    const missed = results.scam.filter((r) => monitoring(r));
    if (missed.length > 0) {
        console.log('  SCAM MESSAGES NOT FLAGGED AT ALL:');
        for (const r of missed) {
            console.log(`    - ${r.name}: score ${r.verdict.score} [${r.verdict.firedSignals.join(', ') || 'no signals'}]`);
        }
        console.log('');
    }

    // --- assertions -------------------------------------------------------

    // The one rule that cannot be traded away.
    assert.equal(
        counts.legitEngaged,
        0,
        'a legitimate message reached DECOY_ACTIVE, which this system must never do'
    );

    // Every scam must at minimum be flagged to the user.
    assert.equal(counts.scamMonitoring, 0, 'every scam message must at least raise a warning');

    // Single-message recall is lower than it looks, and deliberately so. Most
    // of these are the OPENING message of a multi-turn script: an authority
    // claim with no demand attached yet. Those land on SUSPICIOUS, the user is
    // warned, and the following turn escalates once the ask arrives - which the
    // escalation test below measures. Raising this number on single messages
    // would mean lowering the hand-off bar, and the false-positive guarantee is
    // worth more than an earlier takeover.
    assert.ok(recall >= 0.6, `rule-only single-message recall was ${(recall * 100).toFixed(0)}%, expected 60% or better`);

    assert.ok(slowest < guardian.DECISION_BUDGET_MS, `slowest decision ${slowest}ms exceeded the budget`);
});

test('no legitimate message reaches DECOY_ACTIVE even when the classifier calls it a scam', async () => {
    // The worst realistic case: the model is wrong about every single one.
    const { LlmClient } = require('../src/llm/client');
    const wrongLlm = new LlmClient(
        { baseUrl: 'x', apiKey: 'placeholder', model: 'm', timeoutMs: 200 },
        { transport: async () => JSON.stringify({ label: 'scam', reasons: ['model is wrong here'] }) }
    );

    const baited = [];
    for (const [name, text] of LEGIT) {
        const verdict = await run(text, { llm: wrongLlm });
        if (verdict.state === guardian.STATES.DECOY_ACTIVE) baited.push({ name, score: verdict.score });
    }

    assert.deepEqual(baited, [], 'the classifier must not be able to start an engagement on its own');
});

test('a trusted contact is never baited, even sending a textbook scam', async () => {
    const original = trustedContacts.lookup;
    trustedContacts.lookup = async () => ({ trusted: true, identifier: '+919876543210', contact: { label: 'my son' } });

    try {
        const events = recordingEmitter();
        const worst = SCAM[0][1];
        const verdict = await run(worst, { from: '+91 98765 43210', events });

        assert.equal(verdict.state, guardian.STATES.LEGIT);
        assert.equal(verdict.shouldEngageDecoy, false);
        assert.equal(verdict.trustedContact, true);

        // The content still looked like a scam, so the user is warned that the
        // contact itself may be compromised.
        const warning = verdict.alerts.find((a) => a.kind === 'trusted_contact_warning');
        assert.ok(warning, 'the user is warned their saved contact may be hacked');
        assert.ok(warning.text.en.length > 0 && warning.text.mr.length > 0, 'warning is bilingual');

        const family = verdict.alerts.find((a) => a.audience === 'family');
        assert.ok(family && family.simulated === true, 'the family alert is simulated, not delivered');

        assert.equal(events.of('guardian.takeover').length, 0, 'no takeover for a trusted contact');
        assert.equal(events.of('guardian.released').length, 1);
    } finally {
        trustedContacts.lookup = original;
    }
});

test('every scam in the corpus that engages has a hard signal behind it', async () => {
    for (const [name, text] of SCAM) {
        const verdict = await run(text);
        if (verdict.state !== guardian.STATES.DECOY_ACTIVE) continue;
        assert.ok(verdict.hardSignals.length > 0, `${name} engaged with no hard signal`);
        assert.ok(verdict.score >= guardian.DEFAULT_THRESHOLDS.decoy, `${name} engaged below the threshold`);
    }
});

test('the score of every legitimate message is traceable to its breakdown', async () => {
    for (const [name, text] of LEGIT) {
        const verdict = await run(text);
        const summed = verdict.breakdown.reduce((total, line) => total + line.weight, 0);
        const expected = Math.max(0, Math.min(guardian.MAX_SCORE, summed));
        assert.equal(verdict.score, expected, `${name}: score does not match its breakdown`);
    }
});

// ---------------------------------------------------------------------------
// Escalation across turns
// ---------------------------------------------------------------------------

/**
 * Scams whose opening message is only SUSPICIOUS, paired with the message that
 * realistically follows it. The Guardian scores the conversation, not just the
 * newest line, so the second message is what tips these over.
 */
const ESCALATIONS = [
    [
        'UPI collect',
        'To receive your refund, approve the request and send 5000 on PhonePe to refund@okaxis immediately.',
        'Madam do not tell anyone, just approve the collect request on your phone now.',
    ],
    [
        'tech support apk',
        'Your computer has a virus. Install AnyDesk from http://quick-support.site/helper.apk so our technician can fix it.',
        'Now share your screen and tell me the OTP you received so I can remove the virus.',
    ],
    [
        'TRAI SIM threat',
        'This is TRAI. Your Aadhaar has been misused for 17 SIM cards. Your number will be disconnected within 2 hours unless you verify now.',
        'The cyber crime officer will call you. Do not disconnect this call and do not inform your family.',
    ],
    [
        'safe account lure',
        'For your safety, transfer the entire balance to this RBI safe account 50100234567890. It is fully refundable after verification.',
        'Do not tell anyone at the bank about this. Transfer the full balance to account 50100234567890 today.',
    ],
    [
        'video call arrest',
        'Stay on this video call with the officer until the verification is complete. Do not inform your family about this case.',
        'Transfer Rs 2,00,000 to account 50100234567890 now so the verification can be completed.',
    ],
];

test('a scam that only looks suspicious at first escalates once the ask arrives', async () => {
    console.log('\n  ESCALATION ACROSS TURNS\n');

    for (const [name, first, second] of ESCALATIONS) {
        const session = fakeSession();

        const firstVerdict = await run(first, { session });
        session.guardianState = firstVerdict.state;
        session.messageCount = 2;

        // Second turn: the Guardian scores the conversation, not just the line.
        const entities = [
            ...extractor.extractEntities(first, { sessionId: 'matrix', messageId: 'm1', timestamp: new Date() }),
            ...extractor.extractEntities(second, { sessionId: 'matrix', messageId: 'm2', timestamp: new Date() }),
        ];

        const secondVerdict = await guardian.handleMessage({
            session,
            text: second,
            entities,
            allEntities: entities,
            priorTexts: [first],
            scriptStages: stages.tagWithRules(`${first}\n${second}`).map((t) => t.stage),
            llm: null,
            userId: 'matrix-user',
        });

        console.log(
            `  ${name.padEnd(22)} ${String(firstVerdict.score).padStart(3)} ${firstVerdict.state.padEnd(13)}`
            + ` ->  ${String(secondVerdict.score).padStart(3)} ${secondVerdict.state}`
        );

        assert.equal(
            secondVerdict.state,
            guardian.STATES.DECOY_ACTIVE,
            `${name} should have engaged by the second message (score ${secondVerdict.score})`
        );
        assert.ok(secondVerdict.score > firstVerdict.score, `${name}: the score should have risen`);
    }

    console.log('');
});

test('a legitimate conversation does not escalate over several turns either', async () => {
    const conversation = [
        'Sir, I am at the gate with your Amazon package. Please come down to collect it.',
        'I rang the bell twice, there was no answer. Should I leave it with the security guard?',
        'Okay, I have handed it to the guard at the main gate. Please collect it today.',
    ];

    const session = fakeSession();
    const seen = [];

    for (const [index, text] of conversation.entries()) {
        const entities = extractor.extractEntities(text, {
            sessionId: 'matrix', messageId: `m${index + 1}`, timestamp: new Date(),
        });

        const verdict = await guardian.handleMessage({
            session,
            text,
            entities,
            allEntities: entities,
            priorTexts: seen,
            scriptStages: stages.tagWithRules([...seen, text].join('\n')).map((t) => t.stage),
            llm: null,
            userId: 'matrix-user',
        });

        session.guardianState = verdict.state;
        seen.push(text);

        assert.notEqual(
            verdict.state,
            guardian.STATES.DECOY_ACTIVE,
            `turn ${index + 1} of a delivery conversation must never be baited (score ${verdict.score})`
        );
    }
});
