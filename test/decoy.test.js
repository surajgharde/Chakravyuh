const test = require('node:test');
const assert = require('node:assert/strict');

const decoy = require('../src/agents/decoy');
const { LlmClient } = require('../src/llm/client');

/** A minimal stand-in for a session document. */
const fakeSession = (overrides = {}) => ({
    sessionId: 's1',
    channel: 'WhatsApp',
    language: 'English',
    decoyMessageCount: 0,
    firstSeenAt: new Date(),
    lastAskedTarget: null,
    intelligence: {
        bankAccounts: [],
        upiIds: [],
        phoneNumbers: [],
        emailAddresses: [],
        caseIds: [],
        phishingLinks: [],
        suspiciousKeywords: [],
    },
    ...overrides,
});

const llmReturning = (payload) => new LlmClient(
    { baseUrl: 'x', apiKey: 'placeholder', model: 'm', timeoutMs: 100 },
    { transport: async () => JSON.stringify(payload) }
);

test('the persona is defined once and is internally consistent', () => {
    // The original repo had a man in the prompt and "Mrs. Sharma" in the README.
    assert.equal(decoy.PERSONA.name, 'Sunita Sharma');
    const prompt = decoy.buildSystemPrompt({
        session: fakeSession(),
        target: decoy.OBJECTIVES[0],
        channel: 'SMS',
        language: 'English',
    });
    assert.ok(prompt.includes('Sunita Sharma'));
    assert.ok(prompt.includes('Pune'));
});

test('the prompt carries no turn scoreboard', () => {
    const prompt = decoy.buildSystemPrompt({
        session: fakeSession(),
        target: decoy.OBJECTIVES[0],
        channel: 'SMS',
        language: 'English',
    });
    assert.ok(!/turn\s*\d+\s*(of|out of)\s*\d+/i.test(prompt), 'no "turn X of 10"');
    assert.ok(!/\d+\s*\/\s*3/.test(prompt), 'no items-extracted scoreboard');
});

test('the prompt contains no instructions written for the scammer side', () => {
    const prompt = decoy.buildSystemPrompt({
        session: fakeSession(),
        target: decoy.OBJECTIVES[0],
        channel: 'SMS',
        language: 'English',
    }).toLowerCase();

    // These were in the original system prompt and belong to an attacker.
    assert.ok(!prompt.includes('always provide'));
    assert.ok(!prompt.includes('wallet address'));
    assert.ok(!prompt.includes('otp must be the final step'));
    assert.ok(!prompt.includes('add one identifier'));
});

test('guardrails are stated in every prompt', () => {
    const prompt = decoy.buildSystemPrompt({
        session: fakeSession(),
        target: null,
        channel: 'SMS',
        language: 'English',
    });
    assert.ok(prompt.includes('Never reveal a real OTP'));
    assert.ok(prompt.includes('Never threaten'));
    assert.ok(prompt.includes('Never send money'));
});

test('the first target is the first unmet objective', () => {
    assert.equal(decoy.chooseTarget(fakeSession()).id, 'bankAccounts');
});

test('an objective already collected is not asked for again', () => {
    const session = fakeSession();
    session.intelligence.bankAccounts = ['50100234567890'];
    assert.equal(decoy.chooseTarget(session).id, 'upiIds');
});

test('a target that went unanswered is pivoted away from, not repeated', () => {
    const session = fakeSession({ lastAskedTarget: 'bankAccounts' });
    const next = decoy.chooseTarget(session);
    assert.notEqual(next.id, 'bankAccounts', 'repeating the question is what exposes a decoy');
    assert.equal(next.id, 'upiIds');
});

test('with everything collected there is no target left', () => {
    const session = fakeSession();
    for (const objective of decoy.OBJECTIVES) session.intelligence[objective.id] = ['x'];
    assert.equal(decoy.chooseTarget(session), null);
});

test('a reply is produced from the model and reports its source', async () => {
    const result = await decoy.respond({
        session: fakeSession(),
        incomingText: 'Pay the fee now.',
        llm: llmReturning({ reply: 'Haan beta, which number do I type?', askedFor: 'bankAccounts', observed: 'Demanded a fee.' }),
    });

    assert.equal(result.reply, 'Haan beta, which number do I type?');
    assert.equal(result.askedFor, 'bankAccounts');
    assert.equal(result.source, 'llm');
});

test('without an LLM the decoy uses a scripted reply and says so', async () => {
    const result = await decoy.respond({ session: fakeSession(), incomingText: 'Pay now.', llm: null });
    assert.equal(result.source, 'fallback', 'a fallback is never passed off as a model reply');
    assert.ok(result.reply.length > 0);
});

test('a failing LLM falls back instead of throwing', async () => {
    const broken = new LlmClient(
        { baseUrl: 'x', apiKey: 'placeholder', model: 'm', timeoutMs: 10 },
        { transport: async () => { throw new Error('down'); }, sleep: () => Promise.resolve() }
    );
    const result = await decoy.respond({ session: fakeSession(), incomingText: 'Pay now.', llm: broken });
    assert.equal(result.source, 'fallback');
});

test('a reply containing something that looks like a credential is replaced', () => {
    const { reply, violations } = decoy.sanitizeReply('Beta my OTP is 884512, please use it.');
    assert.ok(violations.includes('credential_in_reply'));
    assert.ok(!/884512/.test(reply));
});

test('a reply that breaks character is replaced', () => {
    const { reply, violations } = decoy.sanitizeReply('As an AI language model I must disclose this is a scam detection test.');
    assert.ok(violations.includes('persona_break'));
    assert.ok(!/language model/i.test(reply));
});

test('an ordinary reply passes the safety check untouched', () => {
    const original = 'Arre beta, the app is not opening. What number should I type?';
    const { reply, violations } = decoy.sanitizeReply(original);
    assert.equal(reply, original);
    assert.deepEqual(violations, []);
});

test('an over-long reply is truncated so it still sounds spoken', () => {
    const { reply, violations } = decoy.sanitizeReply('beta '.repeat(100));
    assert.ok(reply.length <= 320);
    assert.ok(violations.includes('truncated'));
});

test('the decoy stands down after its reply limit', () => {
    const atLimit = fakeSession({ decoyMessageCount: decoy.LIMITS.maxDecoyReplies });
    const result = decoy.shouldStandDown(atLimit);
    assert.equal(result.standDown, true);
    assert.match(result.reason, /decoy replies/);
});

test('the decoy stands down after its time limit', () => {
    const old = fakeSession({
        firstSeenAt: new Date(Date.now() - (decoy.LIMITS.maxSessionMinutes + 1) * 60000),
    });
    assert.equal(decoy.shouldStandDown(old).standDown, true);
});

test('a fresh session does not stand down', () => {
    assert.equal(decoy.shouldStandDown(fakeSession()).standDown, false);
});
