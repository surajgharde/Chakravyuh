/**
 * End-to-end: a real Express app, a real in-process MongoDB, a stubbed LLM.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const { MongoMemoryServer } = require('mongodb-memory-server');
const { build } = require('../src/config/env');
const { createApp } = require('../src/app');
const { LlmClient } = require('../src/llm/client');
const Session = require('../src/models/Session');

const API_KEY = 'test-api-secret-key';

let mongoServer;
let server;
let baseUrl;

/**
 * A stand-in for the model.
 *
 * The classifier branch judges by content rather than answering "scam" to
 * everything: a stub that cries scam at a delivery message would make the
 * legitimate-caller tests pass for the wrong reason.
 */
const stubLlm = () => new LlmClient(
    { baseUrl: 'x', apiKey: 'placeholder', model: 'm', timeoutMs: 500 },
    {
        transport: async (request) => {
            const system = request.messages[0].content;
            const incoming = request.messages[request.messages.length - 1].content;

            if (system.includes('protect an elderly person')) {
                const looksLikeScam = /otp|blocked|transfer|upi|account\s*number|arrest|warrant/i.test(incoming);
                return JSON.stringify(looksLikeScam
                    ? { label: 'scam', reasons: ['demands an OTP', 'threatens to block the account'] }
                    : { label: 'legit', reasons: ['an ordinary delivery or family message'] });
            }
            if (system.includes('stages of the scam script')) {
                return JSON.stringify({ stages: [] });
            }
            // The decoy's own output schema.
            return JSON.stringify({
                reply: 'Haan beta, which number should I type?',
                language: 'English',
                targetAsked: 'bankAccount',
                excuseUsed: 'none',
                ledgerUpdates: [],
            });
        },
    }
);

const post = (path, body, headers = { 'x-api-key': API_KEY }) => fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
});

const get = (path, headers = { 'x-api-key': API_KEY }) => fetch(`${baseUrl}${path}`, { headers });

const decoyTargetIds = () => require('../src/agents/decoy').TARGETS.map((t) => t.id);

test.before(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());

    // DEMO_MODE keeps the decoy's typing delay out of the test run.
    const config = build({ API_SECRET_KEY: API_KEY, MONGO_URI: mongoServer.getUri(), PORT: '0', DEMO_MODE: '1' });
    const app = createApp(config, { llm: stubLlm() });

    await new Promise((resolve) => {
        server = app.listen(0, () => {
            baseUrl = `http://127.0.0.1:${server.address().port}`;
            resolve();
        });
    });
});

test.after(async () => {
    if (server) server.close();
    await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
});

test('health needs no key and reports what is wired up', async () => {
    const response = await get('/health', {});
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.llmConfigured, true);
});

test('the message endpoint rejects a request with no key', async () => {
    const response = await post('/api/message', { sessionId: 'x', message: { text: 'hi' } }, {});
    assert.equal(response.status, 401);
});

test('a missing sessionId is a 400, not a fake success', async () => {
    // The original controller answered 200 with {error: "Invalid Payload"}.
    const response = await post('/api/message', { message: { text: 'hi' } });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).status, 'error');
});

test('a legitimate message gets no decoy reply', async () => {
    const response = await post('/api/message', {
        sessionId: 'legit-1',
        message: { sender: 'scammer', text: 'Sir, your Amazon parcel is at the gate, please come down.', timestamp: Date.now() },
        conversationHistory: [],
        metadata: { channel: 'SMS', language: 'English', locale: 'IN' },
    });

    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.state, 'MONITORING');
    assert.equal(body.guardian.state, 'MONITORING');
    assert.equal(body.reply, null, 'a real caller is never baited');
    assert.deepEqual(body.alerts, [], 'nothing to warn the user about');
});

test('a scam message hands off and the decoy answers', async () => {
    const response = await post('/api/message', {
        sessionId: 'scam-1',
        message: {
            sender: 'scammer',
            text: 'URGENT: Your SBI account will be blocked today. Share the OTP immediately.',
            timestamp: Date.now(),
        },
        conversationHistory: [],
        metadata: { channel: 'WhatsApp', language: 'English', locale: 'IN' },
    });

    const body = await response.json();
    assert.equal(body.guardian.state, 'DECOY_ACTIVE');
    assert.equal(body.guardian.takeover, true);
    assert.equal(body.state, 'DECOY_ACTIVE');
    assert.ok(body.reply && body.reply.length > 0);

    // The user is told what happened, in both languages.
    assert.equal(body.takeoverNotice.en, "Guardian has taken over this conversation. You don't need to reply.");
    assert.ok(body.takeoverNotice.mr.length > 0);

    // The score is traceable: a number plus the rules that produced it.
    assert.ok(body.guardian.score >= 60);
    assert.ok(body.guardian.breakdown.length > 0);
    assert.ok(body.guardian.hardSignals.length > 0);
    assert.ok(body.guardian.decisionMs < 1500);
});

test('identifiers the scammer sends are extracted into the session', async () => {
    await post('/api/message', {
        sessionId: 'scam-2',
        message: { sender: 'scammer', text: 'Share the OTP now or your account will be blocked today.', timestamp: Date.now() },
        conversationHistory: [],
    });

    const response = await post('/api/message', {
        sessionId: 'scam-2',
        message: { sender: 'scammer', text: 'Transfer the amount to account 50100234567890 or UPI refund@okaxis.', timestamp: Date.now() },
        conversationHistory: [],
    });

    const body = await response.json();
    assert.ok(body.intelligence.bankAccounts.includes('50100234567890'));
    assert.ok(body.intelligence.upiIds.includes('refund@okaxis'));
    assert.ok(body.measured.newEntitiesThisTurn >= 2);
    assert.ok(body.measured.newEntityTypesThisTurn.includes('bankAccount'));
});

test('counts are measured, and the simulated delay is reported as zero and separate', async () => {
    const sessionId = 'scam-3';
    for (const text of [
        'Share the OTP immediately, your account will be blocked today.',
        'Why are you not sharing it?',
        'Transfer 5000 to UPI mule@okicici right now.',
    ]) {
        await post('/api/message', { sessionId, message: { sender: 'scammer', text, timestamp: Date.now() } });
    }

    const body = await (await get(`/api/sessions/${sessionId}`)).json();
    const session = body.session;

    assert.equal(session.measured.scammerMessageCount, 3);
    assert.equal(session.measured.decoyMessageCount, 3);
    assert.equal(session.measured.messageCount, 6, 'counted, not assigned');

    const duration = session.measured.engagementDurationSeconds;
    assert.ok(duration >= 0 && duration < 60, `a real short session, got ${duration}s`);
    assert.notEqual(duration, 185, 'the old code forced 185 seconds');
});

test('history in the platform shape is hydrated into the session', async () => {
    const t0 = Date.now() - 120000;
    await post('/api/message', {
        sessionId: 'hydrate-sender',
        message: { sender: 'scammer', text: 'Share your UPI ID to avoid suspension.', timestamp: Date.now() },
        conversationHistory: [
            { sender: 'scammer', text: 'Your bank account will be blocked today. Verify immediately.', timestamp: t0 },
            { sender: 'user', text: 'Why will my account be blocked?', timestamp: t0 + 1000 },
        ],
    });

    const session = await Session.findOne({ sessionId: 'hydrate-sender' });
    assert.equal(session.messages[0].text, 'Your bank account will be blocked today. Verify immediately.');
    assert.equal(session.messages[0].role, 'scammer');
    assert.equal(session.messages[1].role, 'user');
    assert.ok(session.engagementDurationSeconds() >= 110, 'duration spans the real transcript timestamps');
});

test('history in the chat shape is hydrated too', async () => {
    // The original code read only {sender,text} while the README documented
    // {role,content}, so a README-shaped history was silently dropped.
    await post('/api/message', {
        sessionId: 'hydrate-role',
        message: { text: 'Share the OTP now.' },
        conversationHistory: [
            { role: 'user', content: 'Your account will be blocked.' },
            { role: 'assistant', content: 'Beta, who is this?' },
        ],
    });

    const session = await Session.findOne({ sessionId: 'hydrate-role' });
    assert.equal(session.messages.length >= 3, true);
    assert.equal(session.messages[0].role, 'scammer');
    assert.equal(session.messages[1].role, 'decoy');
});

test('a session with no timestamps still reports a real duration', async () => {
    await post('/api/message', { sessionId: 'no-ts', message: { text: 'Share the OTP immediately.' } });
    const session = await Session.findOne({ sessionId: 'no-ts' });
    const duration = session.engagementDurationSeconds();
    assert.equal(duration, 0, 'one message means nothing has elapsed yet, and that is the honest number');
});

test('the decoy switches target instead of repeating an unanswered question', async () => {
    const decoy = require('../src/agents/decoy');
    const sessionId = 'pivot-1';

    await post('/api/message', { sessionId, message: { text: 'Share the OTP immediately, account will be blocked today.' } });

    const first = await Session.findOne({ sessionId });
    assert.ok(
        decoy.TARGETS.some((t) => t.id === first.lastAskedTarget),
        `asked for an unknown target: ${first.lastAskedTarget}`
    );

    await post('/api/message', { sessionId, message: { text: 'I cannot give that. Just pay the fee.' } });
    const second = await Session.findOne({ sessionId });

    // Nothing was handed over, so the target asked must have moved on.
    assert.notEqual(
        second.lastAskedTarget,
        first.lastAskedTarget,
        'the same question was asked twice in a row'
    );
});

test('the decoy records what it asked for, the excuse it used and the language', async () => {
    const sessionId = 'decoy-fields-1';
    const body = await (await post('/api/message', {
        sessionId,
        message: { sender: 'scammer', text: 'Share the OTP immediately, account will be blocked today.', timestamp: Date.now() },
    })).json();

    assert.equal(body.state, 'DECOY_ACTIVE');
    assert.ok(body.decoy, 'the decoy block is present once engaged');
    assert.ok(['English', 'Hindi', 'Marathi'].includes(body.decoy.language));
    assert.ok(decoyTargetIds().includes(body.decoy.targetAsked) || body.decoy.targetAsked === 'none');
    assert.ok(Array.isArray(body.decoy.ledgerUpdates));
    assert.equal(body.decoy.guard.verdict, 'pass');
    assert.equal(body.measured.simulatedTypingDelayMs, 0, 'the test config runs in demo mode');
});

test('the persona ledger is seeded and persisted on the session', async () => {
    const sessionId = 'ledger-1';
    await post('/api/message', {
        sessionId,
        message: { sender: 'scammer', text: 'Share the OTP immediately, account will be blocked today.', timestamp: Date.now() },
    });

    const session = await Session.findOne({ sessionId });
    const slots = session.personaLedger.map((e) => e.slot);
    for (const slot of ['son_name', 'son_city', 'husband_status', 'bank_reference']) {
        assert.ok(slots.includes(slot), `the ledger is missing ${slot}`);
    }
});

test('the session listing returns measured values only', async () => {
    const body = await (await get('/api/sessions')).json();
    assert.equal(body.status, 'success');
    assert.ok(body.sessions.length > 0);
    for (const session of body.sessions) {
        assert.equal(typeof session.engagementDurationSeconds, 'number');
        assert.ok(session.engagementDurationSeconds < 3600);
    }
});

test('an unknown session is a 404', async () => {
    assert.equal((await get('/api/sessions/does-not-exist')).status, 404);
});

// ---------------------------------------------------------------------------
// Entities and script stages, end to end
// ---------------------------------------------------------------------------

test('extracted entities reach the API with full provenance', async () => {
    const sessionId = 'entities-1';
    await post('/api/message', {
        sessionId,
        message: {
            sender: 'scammer',
            text: 'This is CBI. Transfer Rs 2,50,000 to a/c 50100234567890, IFSC SBIN0001234. Do not tell anyone.',
            timestamp: Date.now(),
        },
        metadata: { channel: 'Call', language: 'English', locale: 'IN' },
    });

    const { session } = await (await get(`/api/sessions/${sessionId}`)).json();

    const account = session.entities.find((e) => e.type === 'bankAccount');
    assert.ok(account, 'the account number was extracted');
    assert.equal(account.normalized, '50100234567890');
    assert.equal(account.sessionId, sessionId);
    assert.equal(account.messageId, 'm1', 'points back at the message it came from');
    assert.ok(account.timestamp, 'carries a timestamp');
    assert.ok(
        account.sentence.includes('50100234567890'),
        'quotes the sentence verbatim, so the report can be audited'
    );

    const types = session.entities.map((e) => e.type);
    for (const expected of ['bankAccount', 'ifsc', 'amount', 'impersonatedAuthority']) {
        assert.ok(types.includes(expected), expected);
    }

    const amount = session.entities.find((e) => e.type === 'amount');
    assert.equal(amount.normalized, 250000, 'rupees as an integer');
});

test('script stages are tagged per message and rolled up per session', async () => {
    const sessionId = 'stages-1';
    const first = await post('/api/message', {
        sessionId,
        message: {
            sender: 'scammer',
            text: 'Madam this is Inspector Shinde from cyber crime. A parcel in your name had MDMA.',
            timestamp: Date.now(),
        },
    });

    const firstBody = await first.json();
    const firstStages = firstBody.scriptStages.thisMessage.map((t) => t.stage);
    assert.ok(firstStages.includes('AUTHORITY_CLAIM'));
    assert.ok(firstStages.includes('ACCUSATION'));

    await post('/api/message', {
        sessionId,
        message: {
            sender: 'scammer',
            text: 'Transfer 2 lakh to the RBI safe account immediately, it is fully refundable.',
            timestamp: Date.now(),
        },
    });

    const { session } = await (await get(`/api/sessions/${sessionId}`)).json();

    // The session accumulates the whole script, in taxonomy order.
    for (const expected of ['AUTHORITY_CLAIM', 'ACCUSATION', 'URGENCY', 'PAYMENT_DEMAND', 'VERIFICATION_LURE']) {
        assert.ok(session.scriptStages.includes(expected), expected);
    }

    const scammerMessages = session.messages.filter((m) => m.role === 'scammer');
    assert.ok(scammerMessages.every((m) => Array.isArray(m.stages)));
    assert.ok(scammerMessages[0].stages.every((t) => ['rules', 'llm'].includes(t.method)));
});

test('each stage tag records which method produced it', async () => {
    const sessionId = 'stages-2';
    const response = await post('/api/message', {
        sessionId,
        message: { sender: 'scammer', text: 'Share the OTP immediately or your account will be blocked.', timestamp: Date.now() },
    });

    const body = await response.json();
    const credential = body.scriptStages.thisMessage.find((t) => t.stage === 'CREDENTIAL_REQUEST');
    assert.equal(credential.method, 'rules');
    assert.ok(credential.evidence.length > 0, 'a rule tag quotes what it matched');
});

test('the decoy side is never mined for entities', async () => {
    const sessionId = 'decoy-not-mined';
    await post('/api/message', {
        sessionId,
        message: { sender: 'scammer', text: 'Share the OTP now, account will be blocked today.', timestamp: Date.now() },
    });

    const session = await Session.findOne({ sessionId });
    const decoyMessages = session.messages.filter((m) => m.role === 'decoy');
    assert.ok(decoyMessages.length > 0);
    for (const entity of session.entities) {
        assert.ok(
            !decoyMessages.some((m) => m.messageId === entity.messageId),
            'evidence comes from the scammer, never from our own replies'
        );
    }
});

test('a Marathi scam message is handled end to end', async () => {
    const sessionId = 'marathi-1';
    const response = await post('/api/message', {
        sessionId,
        message: {
            sender: 'scammer',
            text: 'मी सायबर विभागातून बोलत आहे. दंडाची रक्कम पाच लाख खात्यात 50100234567890 जमा करा. कोणालाही सांगू नका.',
            timestamp: Date.now(),
        },
        metadata: { channel: 'Call', language: 'Marathi', locale: 'IN' },
    });

    const body = await response.json();
    assert.ok(body.intelligence.bankAccounts.includes('50100234567890'));
    assert.ok(body.intelligence.amountsDemanded.includes(500000));
    assert.ok(body.intelligence.impersonatedAuthorities.includes('cyber cell'));

    const tagged = body.scriptStages.thisMessage.map((t) => t.stage);
    assert.ok(tagged.includes('PAYMENT_DEMAND'));
    assert.ok(tagged.includes('ISOLATION'));
});

// ---------------------------------------------------------------------------
// Guardian state, alerts and the "This is genuine" button, end to end
// ---------------------------------------------------------------------------

test('a suspicious message warns the user and sends no reply', async () => {
    const response = await post('/api/message', {
        sessionId: 'suspicious-1',
        message: {
            sender: 'scammer',
            text: 'This is TRAI. Your Aadhaar has been misused for 17 SIM cards. Verify now.',
            timestamp: Date.now(),
        },
    });

    const body = await response.json();
    assert.equal(body.state, 'SUSPICIOUS');
    assert.equal(body.reply, null, 'suspicious warns, it never baits');

    const kinds = body.alerts.map((a) => a.kind);
    assert.ok(kinds.includes('suspicious_warning'));
    assert.ok(kinds.includes('callback_advice'));
    assert.ok(kinds.includes('family_alert'));
    assert.ok(body.alerts.find((a) => a.kind === 'family_alert').simulated);
});

test('the "This is genuine" button ends the engagement with one neutral line', async () => {
    const sessionId = 'genuine-1';

    const engaged = await (await post('/api/message', {
        sessionId,
        message: { sender: 'scammer', text: 'Share the OTP now, your account will be blocked today.', timestamp: Date.now() },
        metadata: { from: '+919812345678' },
    })).json();
    assert.equal(engaged.state, 'DECOY_ACTIVE');

    const response = await post(`/api/sessions/${sessionId}/genuine`, {});
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.state, 'FALSE_POSITIVE');
    assert.equal(body.previousState, 'DECOY_ACTIVE');
    assert.equal(body.reply, 'Sorry, I got confused, please continue.');
    assert.equal(body.offerTrustedContact, true, 'offers to remember the caller');
    assert.equal(body.counterpartId, '+919812345678');

    const session = await Session.findOne({ sessionId });
    assert.equal(session.guardianState, 'FALSE_POSITIVE');
    assert.equal(session.scamDetected, false);
    assert.equal(session.falsePositive.markedByUser, true);

    // The neutral line is in the transcript, so the report shows what was said.
    assert.equal(session.messages[session.messages.length - 1].text, 'Sorry, I got confused, please continue.');
});

test('a session marked genuine is never baited again', async () => {
    const sessionId = 'genuine-2';
    await post('/api/message', {
        sessionId,
        message: { sender: 'scammer', text: 'Share the OTP now, account will be blocked today.', timestamp: Date.now() },
    });
    await post(`/api/sessions/${sessionId}/genuine`, {});

    const again = await (await post('/api/message', {
        sessionId,
        message: { sender: 'scammer', text: 'Transfer 2 lakh to account 50100234567890 immediately or you will be arrested.', timestamp: Date.now() },
    })).json();

    assert.equal(again.state, 'FALSE_POSITIVE');
    assert.equal(again.reply, null);
});

test('marking a session genuine that does not exist is a 404', async () => {
    const response = await post('/api/sessions/no-such-session/genuine', {});
    assert.equal(response.status, 404);
});

test('an engagement can be ended explicitly', async () => {
    const sessionId = 'end-1';
    await post('/api/message', {
        sessionId,
        message: { sender: 'scammer', text: 'Share the OTP now, account will be blocked today.', timestamp: Date.now() },
    });

    const body = await (await post(`/api/sessions/${sessionId}/end`, { reason: 'operator stopped it' })).json();
    assert.equal(body.state, 'ENDED');

    const session = await Session.findOne({ sessionId });
    assert.equal(session.guardianState, 'ENDED');
});

test('the session view exposes the score, its breakdown and the label', async () => {
    const sessionId = 'view-1';
    await post('/api/message', {
        sessionId,
        message: { sender: 'scammer', text: 'Share the OTP now, your account will be blocked today.', timestamp: Date.now() },
    });

    const { session } = await (await get(`/api/sessions/${sessionId}`)).json();

    assert.equal(session.state, 'DECOY_ACTIVE');
    assert.ok(session.score >= 60);
    assert.ok(session.scoreBreakdown.length > 0);
    assert.ok(session.firedSignals.includes('credential_request'));
    assert.equal(session.classifier.label, 'scam');
    assert.ok(session.classifier.reasons.length > 0);
    assert.ok(session.takeoverAt);
    // No invented probability anywhere in the view.
    assert.equal(session.confidence, undefined);
});

// ---------------------------------------------------------------------------
// Trusted contacts
// ---------------------------------------------------------------------------

test('a trusted contact is never baited through the API', async () => {
    const add = await post('/api/trusted-contacts', {
        userId: 'trust-user',
        identifier: '98765 43210',
        label: 'my son Rahul',
        relationship: 'family',
    });
    assert.equal(add.status, 201);
    assert.equal((await add.json()).contact.identifier, '+919876543210', 'stored normalised');

    const body = await (await post('/api/message', {
        sessionId: 'trusted-1',
        message: {
            sender: 'scammer',
            text: 'Maa, I need 5000 urgently. Transfer it to account 50100234567890 right now, do not tell papa.',
            timestamp: Date.now(),
        },
        metadata: { userId: 'trust-user', from: '+91-98765-43210' },
    })).json();

    assert.equal(body.state, 'LEGIT');
    assert.equal(body.reply, null, 'a saved contact is never baited');
    assert.equal(body.guardian.trustedContact, true);

    // The message did look like a scam, so the user is warned about the contact.
    const warning = body.alerts.find((a) => a.kind === 'trusted_contact_warning');
    assert.ok(warning, 'warns that the contact may be compromised');
    assert.ok(warning.text.mr.length > 0);
});

test('trusted contacts can be listed and removed', async () => {
    await post('/api/trusted-contacts', { userId: 'list-user', identifier: '9123456780', label: 'Dr. Kulkarni', relationship: 'doctor' });

    const listed = await (await get('/api/trusted-contacts?userId=list-user')).json();
    assert.equal(listed.count, 1);
    assert.equal(listed.contacts[0].label, 'Dr. Kulkarni');

    const removed = await fetch(`${baseUrl}/api/trusted-contacts/9123456780?userId=list-user`, {
        method: 'DELETE',
        headers: { 'x-api-key': API_KEY },
    });
    assert.equal(removed.status, 200);

    const after = await (await get('/api/trusted-contacts?userId=list-user')).json();
    assert.equal(after.count, 0);
});

test('a trusted contact needs an identifier', async () => {
    const response = await post('/api/trusted-contacts', { userId: 'bad-user', label: 'nobody' });
    assert.equal(response.status, 400);
});

test('trusted contacts are scoped to one protected user', async () => {
    await post('/api/trusted-contacts', { userId: 'user-a', identifier: '9000000001', label: 'A' });
    const forB = await (await get('/api/trusted-contacts?userId=user-b')).json();
    assert.equal(forB.count, 0, 'contacts belong to one protected user only');
});


// ---------------------------------------------------------------------------
// Evidence report and network view, end to end
// ---------------------------------------------------------------------------

/** Runs a short scam conversation and returns the session id. */
const runScamSession = async (sessionId, lines, metadata = {}) => {
    for (const text of lines) {
        await post('/api/message', {
            sessionId,
            message: { sender: 'scammer', text, timestamp: Date.now() },
            metadata: { channel: 'Call', language: 'English', locale: 'IN', ...metadata },
        });
    }
    return sessionId;
};

test('the report JSON matches what is stored on the session', async () => {
    const sessionId = 'report-api-1';
    await runScamSession(sessionId, [
        'Madam this is CBI Pune. A parcel in your name was seized with narcotics. Do not tell anyone.',
        'Transfer Rs 2,50,000 to account 50100234567890, IFSC SBIN0001234, or you will be arrested today.',
        'Or send it to cyber.verify@okaxis. My number is 9876543210.',
    ]);

    const { report } = await (await get(`/api/sessions/${sessionId}/report`)).json();
    const session = await Session.findOne({ sessionId });

    assert.equal(report.session.sessionId, sessionId);
    assert.equal(report.session.messageCounts.total, session.messageCount);
    assert.equal(report.session.messageCounts.fromCaller, session.scammerMessageCount);
    assert.equal(report.session.messageCounts.fromDecoy, session.decoyMessageCount);
    assert.equal(report.session.durationSeconds, session.engagementDurationSeconds());
    assert.equal(report.transcript.length, session.messages.length);
    assert.equal(report.guardianDecisionLog.length, session.guardianLog.length);

    // Identifiers come back with the sentence they were found in.
    const upi = report.suspectIdentifiers.find((row) => row.value === 'cyber.verify@okaxis');
    assert.ok(upi);
    assert.ok(upi.excerpt.includes('cyber.verify@okaxis'));
    assert.equal(report.moneyDemanded.highestRupees, 250000);
});

test('the report never contains the protected user id', async () => {
    const sessionId = 'report-api-privacy';
    await runScamSession(
        sessionId,
        ['Share the OTP now or your account is blocked today.'],
        { userId: 'elderly-9988776655', from: '+919812345678' }
    );

    const body = await (await get(`/api/sessions/${sessionId}/report`)).text();
    assert.ok(!body.includes('elderly-9988776655'), 'the user id leaked into the report');
    assert.ok(JSON.parse(body).report.protectedUser.alias.startsWith('Protected User '));
});

test('the printable HTML report is served and is self-contained', async () => {
    const sessionId = 'report-api-html';
    await runScamSession(sessionId, [
        'Share the OTP now or your account is blocked today.',
        'Transfer 50000 to cyber.verify@okaxis immediately.',
    ]);

    const response = await get(`/api/sessions/${sessionId}/report.html`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);

    const html = await response.text();
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(html.includes('cyber.verify@okaxis'));
    assert.ok(html.includes('NOT READY TO FILE'), 'unreviewed reports are stamped as drafts');
    assert.ok(!/<script/i.test(html));
});

test('the PDF report is served as a real PDF download', async () => {
    const sessionId = 'report-api-pdf';
    await runScamSession(sessionId, ['Share the OTP now or your account is blocked today.']);

    const response = await get(`/api/sessions/${sessionId}/report.pdf`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.match(response.headers.get('content-disposition'), /attachment; filename="CHKV-.*DRAFT\.pdf"/);

    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
});

test('an unreviewed report cannot be exported as ready to file', async () => {
    const sessionId = 'report-api-gate';
    await runScamSession(sessionId, ['Share the OTP now or your account is blocked today.']);

    const refused = await get(`/api/sessions/${sessionId}/report.pdf?ready=1`);
    assert.equal(refused.status, 409);

    const body = await refused.json();
    assert.equal(body.readyToFile, false);
    assert.match(body.error, /not been reviewed/i);
});

test('ticking the review box unlocks the ready-to-file export', async () => {
    const sessionId = 'report-api-review';
    await runScamSession(sessionId, ['Share the OTP now or your account is blocked today.']);

    const bad = await post(`/api/sessions/${sessionId}/report/review`, {});
    assert.equal(bad.status, 400, 'the box has to actually be ticked');

    const review = await post(`/api/sessions/${sessionId}/report/review`, {
        reviewedByFamily: true,
        reviewedBy: 'son',
    });
    assert.equal(review.status, 200);
    assert.equal((await review.json()).review.readyToFile, true);

    const exported = await get(`/api/sessions/${sessionId}/report.pdf?ready=1`);
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-disposition'), /filename="CHKV-[^"]*\.pdf"/);
    assert.ok(!exported.headers.get('content-disposition').includes('DRAFT'));

    const html = await (await get(`/api/sessions/${sessionId}/report.html`)).text();
    assert.ok(html.includes('READY TO FILE'));
    assert.ok(html.includes('son'));
});

test('a report for a session that does not exist is a 404', async () => {
    for (const path of ['/report', '/report.html', '/report.pdf']) {
        const response = await get(`/api/sessions/no-such-session${path}`);
        assert.equal(response.status, 404, path);
    }
});

test('agentNotes on the session is the summary built from its own data', async () => {
    const sessionId = 'report-api-notes';
    await runScamSession(sessionId, [
        'Madam this is CBI. Transfer Rs 2,50,000 to cyber.verify@okaxis today or be arrested.',
    ]);

    const session = await Session.findOne({ sessionId });
    assert.ok(session.agentNotes.length > 0);
    assert.ok(session.agentNotes.includes('Rs 2,50,000'));

    // And it states nothing the session does not hold.
    const amounts = session.entities.filter((e) => e.type === 'amount').map((e) => Number(e.normalized));
    for (const match of session.agentNotes.matchAll(/Rs ([\d,]+)/g)) {
        assert.ok(amounts.includes(Number(match[1].replace(/,/g, ''))));
    }
});

test('the network view links two sessions that share a UPI id', async () => {
    const shared = 'network.mule@okaxis';

    await runScamSession('net-api-1', [
        `Transfer Rs 50,000 to ${shared} today or you will be arrested.`,
    ], { userId: 'net-user' });

    await runScamSession('net-api-2', [
        `Pay the clearance fee to ${shared} immediately, do not tell anyone.`,
    ], { userId: 'net-user' });

    const graph = await (await get('/api/network?userId=net-user')).json();

    assert.equal(graph.status, 'success');
    assert.equal(graph.stats.sessions, 2);

    const node = graph.nodes.find((n) => n.value === shared);
    assert.ok(node, 'the shared identifier is a node');
    assert.equal(node.shared, true);
    assert.equal(node.sessionCount, 2);

    assert.equal(graph.clusters.length, 1);
    assert.deepEqual([...graph.clusters[0].sessions].sort(), ['net-api-1', 'net-api-2']);
    assert.equal(graph.clusters[0].linkedBy[0].value, shared);
});

test('the network view is empty rather than broken when nothing matches', async () => {
    const graph = await (await get('/api/network?userId=nobody-at-all')).json();
    assert.equal(graph.status, 'success');
    assert.deepEqual(graph.nodes, []);
    assert.deepEqual(graph.clusters, []);
});
