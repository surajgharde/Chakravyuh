const test = require('node:test');
const assert = require('node:assert/strict');

const guardian = require('../src/agents/guardian');
const intelligence = require('../src/services/intelligence');
const { LlmClient } = require('../src/llm/client');

const llmSaying = (verdict) => new LlmClient(
    { baseUrl: 'x', apiKey: 'placeholder', model: 'm', timeoutMs: 100 },
    { transport: async () => JSON.stringify(verdict) }
);

const assessText = (text, options = {}) => guardian.assess({
    incomingText: text,
    extracted: intelligence.extract(text),
    ...options,
});

test('nothing is hardcoded: an innocent message is not a scam', async () => {
    const result = await assessText('Hello sir, your parcel is at the gate, please come down.');
    assert.equal(result.isScam, false);
    assert.equal(result.stage, guardian.STAGES.PASS);
    assert.equal(result.confidence, 0);
    assert.deepEqual(result.signals, []);
});

test('a family message is not a scam', async () => {
    const result = await assessText('Beta, I am reaching home by 7, please keep the gate open.');
    assert.equal(result.stage, guardian.STAGES.PASS);
});

test('an OTP demand with a deadline hands off to the decoy', async () => {
    const result = await assessText('URGENT: Your SBI account will be blocked today. Share the OTP immediately.');
    assert.equal(result.stage, guardian.STAGES.ENGAGE);
    assert.equal(result.isScam, true);
    assert.ok(result.hasHardSignal);
    assert.ok(result.signalIds.includes('otp_or_pin_request'));
    assert.ok(result.confidence >= guardian.THRESHOLDS.engage);
});

test('a digital-arrest script hands off', async () => {
    const result = await assessText(
        'Madam this is CBI. A parcel in your name contained narcotics. Do not tell anyone and '
        + 'stay on the call. Transfer 50000 to account 50100234567890 for verification.'
    );
    assert.equal(result.stage, guardian.STAGES.ENGAGE);
    assert.ok(result.signalIds.includes('arrest_or_legal_threat'));
    assert.ok(result.signalIds.includes('secrecy_instruction'));
});

test('a genuine bank advisory scores negative and is never engaged', async () => {
    const result = await assessText(
        'This is a service message from your bank. We will never ask for your OTP or PIN. '
        + 'If you have a query, please call back on the number printed on your card.'
    );
    assert.equal(result.stage, guardian.STAGES.PASS);
    assert.equal(result.confidence, 0, 'a negative total clamps to zero, it does not go below');
    assert.ok(result.signalIds.includes('explicit_no_otp_advisory'));
});

test('soft signals alone never reach hand-off: a hard signal is required', async () => {
    // Urgency, an authority claim and an account threat together clear the score
    // threshold, but a worried real caller can produce all three.
    const soft = 'This is calling from the electricity board. Your connection will be '
        + 'disconnected today. Please act immediately, this is the last warning.';
    const result = await assessText(soft);

    assert.equal(result.hasHardSignal, false);
    assert.notEqual(result.stage, guardian.STAGES.ENGAGE);
    assert.equal(result.stage, guardian.STAGES.WATCH, 'suspicious, so watch - but do not bait');
});

test('confidence is the sum of the documented weights, not a model invention', async () => {
    const text = 'Your account will be blocked. Share the OTP immediately.';
    const { score, fired } = guardian.scoreSignals(text);

    const expected = fired.reduce((sum, signal) => sum + signal.weight, 0);
    assert.equal(Math.round(score * 100) / 100, Math.round(expected * 100) / 100);

    const result = await assessText(text);
    assert.equal(result.confidence, Math.round(Math.min(1, score) * 100) / 100);
});

test('confidence never starts from a floor', async () => {
    const result = await assessText('Good morning, how are you?');
    assert.equal(result.confidence, 0, 'the old code began every session at 0.80');
});

test('an LLM scam verdict raises confidence by its documented weight only', async () => {
    const text = 'Your account will be blocked. Share the OTP immediately.';
    const withoutLlm = await assessText(text);
    const withLlm = await assessText(text, { llm: llmSaying({ intent: 'scam', scamType: 'bank_fraud' }) });

    const expected = Math.min(1, withoutLlm.confidence + guardian.WEIGHTS.llmScam);
    assert.equal(withLlm.confidence, Math.round(expected * 100) / 100);
});

test('an LLM legitimate verdict withholds hand-off even when rules add up', async () => {
    const text = 'Your SBI account will be blocked today. Share the OTP immediately.';
    const result = await assessText(text, { llm: llmSaying({ intent: 'legitimate', scamType: 'unknown' }) });

    assert.notEqual(result.stage, guardian.STAGES.ENGAGE);
    assert.ok(result.signalIds.includes('handoff_blocked_by_classifier'));
});

test('a broken LLM does not stop detection', async () => {
    const broken = new LlmClient(
        { baseUrl: 'x', apiKey: 'placeholder', model: 'm', timeoutMs: 10 },
        { transport: async () => { throw new Error('provider exploded'); }, sleep: () => Promise.resolve() }
    );

    const result = await assessText('Share the OTP immediately or your account will be blocked today.', { llm: broken });
    assert.equal(result.stage, guardian.STAGES.ENGAGE, 'the rule layer still works');
    assert.equal(result.classifier.intent, 'unavailable');
});

test('signals accumulate across turns, not just the newest message', async () => {
    const result = await guardian.assess({
        incomingText: 'Now transfer 25000 to UPI id refund@okaxis.',
        priorScammerMessages: [
            { role: 'scammer', text: 'This is calling from the income tax department.' },
            { role: 'scammer', text: 'Do not tell anyone about this, stay on the call.' },
        ],
        extracted: intelligence.extract('Now transfer 25000 to UPI id refund@okaxis.'),
    });

    assert.ok(result.signalIds.includes('authority_claim'));
    assert.ok(result.signalIds.includes('secrecy_instruction'));
    assert.ok(result.signalIds.includes('payment_redirect'));
    assert.equal(result.stage, guardian.STAGES.ENGAGE);
});

test('every reported signal carries a human-readable reason', async () => {
    const result = await assessText('Share the OTP immediately, your account will be blocked.');
    assert.ok(result.signals.length > 0);
    for (const signal of result.signals) {
        assert.equal(typeof signal.id, 'string');
        assert.equal(typeof signal.description, 'string');
        assert.ok(signal.description.length > 0);
        assert.equal(typeof signal.weight, 'number');
    }
});
