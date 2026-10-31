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

/** An LLM that confirms a scam and plays the persona. */
const stubLlm = () => new LlmClient(
    { baseUrl: 'x', apiKey: 'placeholder', model: 'm', timeoutMs: 500 },
    {
        transport: async (request) => {
            const system = request.messages[0].content;
            if (system.includes('fraud analyst')) {
                return JSON.stringify({ intent: 'scam', scamType: 'bank_fraud', rationale: 'Demanded an OTP under threat.' });
            }
            return JSON.stringify({
                reply: 'Haan beta, which number should I type?',
                askedFor: 'bankAccounts',
                observed: 'Demanded an OTP.',
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

test.before(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());

    const config = build({ API_SECRET_KEY: API_KEY, MONGO_URI: mongoServer.getUri(), PORT: '0' });
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
    assert.equal(body.guardian.stage, 'pass');
    assert.equal(body.guardian.scamDetected, false);
    assert.equal(body.reply, null, 'a real caller is never baited');
    assert.equal(body.action, 'monitoring');
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
    assert.equal(body.guardian.stage, 'engage');
    assert.equal(body.guardian.handedOffThisTurn, true);
    assert.equal(body.action, 'decoy_engaged');
    assert.ok(body.reply && body.reply.length > 0);
    assert.equal(body.guardian.handedOffThisTurn, true);
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
    const sessionId = 'pivot-1';
    await post('/api/message', { sessionId, message: { text: 'Share the OTP immediately, account will be blocked today.' } });

    const first = await Session.findOne({ sessionId });
    assert.equal(first.lastAskedTarget, 'bankAccounts');

    await post('/api/message', { sessionId, message: { text: 'I cannot give that. Just pay the fee.' } });
    const second = await Session.findOne({ sessionId });
    assert.equal(second.lastAskedTarget, 'bankAccounts', 'the stub always reports bankAccounts');

    // The target chosen for the next turn must differ, since the first ask went unanswered.
    const decoy = require('../src/agents/decoy');
    assert.notEqual(decoy.chooseTarget(second).id, 'bankAccounts');
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
