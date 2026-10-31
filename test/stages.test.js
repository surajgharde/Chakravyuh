const test = require('node:test');
const assert = require('node:assert/strict');

const stages = require('../src/services/stages');
const { LlmClient } = require('../src/llm/client');

const stagesOf = (text) => stages.tagWithRules(text).map((t) => t.stage);

const llmReturning = (payload) => new LlmClient(
    { baseUrl: 'x', apiKey: 'placeholder', model: 'm', timeoutMs: 100 },
    { transport: async () => JSON.stringify(payload) }
);

// ---------------------------------------------------------------------------
// Each stage, from rules alone
// ---------------------------------------------------------------------------

test('CONTACT: an opening', () => {
    assert.ok(stagesOf('Hello sir, am I speaking to Mr Sharma?').includes('CONTACT'));
    assert.ok(stagesOf('Namaste, my name is Rajesh Kumar.').includes('CONTACT'));
});

test('AUTHORITY_CLAIM: claiming to be an institution', () => {
    assert.ok(stagesOf('Madam, this is Inspector Verma from the cyber crime branch.').includes('AUTHORITY_CLAIM'));
    assert.ok(stagesOf('I am calling from SBI bank security team.').includes('AUTHORITY_CLAIM'));
});

test('ACCUSATION: alleging a crime or misuse', () => {
    assert.ok(stagesOf('A parcel in your name was found with MDMA at Mumbai airport.').includes('ACCUSATION'));
    assert.ok(stagesOf('Your Aadhaar has been misused for money laundering.').includes('ACCUSATION'));
});

test('THREAT: arrest, warrant or service cut-off', () => {
    assert.ok(stagesOf('A non-bailable warrant will be issued against you.').includes('THREAT'));
    assert.ok(stagesOf('Police will reach your house in one hour.').includes('THREAT'));
    assert.ok(stagesOf('Your SIM card will be blocked permanently.').includes('THREAT'));
});

test('ISOLATION: keeping the target alone and on the line', () => {
    assert.ok(stagesOf('Do not tell anyone in your family about this case.').includes('ISOLATION'));
    assert.ok(stagesOf('Stay on the video call until the verification is finished.').includes('ISOLATION'));
});

test('URGENCY: an artificial deadline', () => {
    assert.ok(stagesOf('You must act immediately, this is the final warning.').includes('URGENCY'));
    assert.ok(stagesOf('Only 30 minutes left before the case is filed.').includes('URGENCY'));
});

test('PAYMENT_DEMAND: asking for money or a route to it', () => {
    assert.ok(stagesOf('Transfer 2 lakh to account 50100234567890 immediately.').includes('PAYMENT_DEMAND'));
    assert.ok(stagesOf('Scan this QR code and pay the penalty.').includes('PAYMENT_DEMAND'));
});

test('CREDENTIAL_REQUEST: OTP, PIN or remote access', () => {
    assert.ok(stagesOf('Share the OTP you just received on your phone.').includes('CREDENTIAL_REQUEST'));
    assert.ok(stagesOf('Please install AnyDesk so I can check your phone.').includes('CREDENTIAL_REQUEST'));
    assert.ok(stagesOf('Download the app from this link and open it.').includes('CREDENTIAL_REQUEST'));
});

test('VERIFICATION_LURE: framing the payment as safe', () => {
    assert.ok(stagesOf('The amount goes to an RBI safe account and is fully refundable.').includes('VERIFICATION_LURE'));
    assert.ok(stagesOf('This is only for verification, the money will be returned to you.').includes('VERIFICATION_LURE'));
});

// ---------------------------------------------------------------------------
// Precision
// ---------------------------------------------------------------------------

test('a message can carry several stages at once', () => {
    const tags = stagesOf(
        'This is CBI. Your Aadhaar was used for money laundering and a warrant is issued. '
        + 'Do not tell anyone. Transfer 2 lakh immediately to the RBI safe account, it is refundable.'
    );
    for (const expected of ['AUTHORITY_CLAIM', 'ACCUSATION', 'THREAT', 'ISOLATION', 'URGENCY', 'PAYMENT_DEMAND', 'VERIFICATION_LURE']) {
        assert.ok(tags.includes(expected), expected);
    }
});

test('an ordinary message gets no stage, or only CONTACT', () => {
    for (const text of [
        'Beta, I am reaching home by seven, keep the gate open.',
        'Your medicines are ready for pickup.',
    ]) {
        const tags = stagesOf(text);
        assert.ok(tags.every((t) => t === 'CONTACT'), `${text} -> ${tags.join(',')}`);
    }
});

test('"do not disconnect the call" is isolation, not a threat', () => {
    // The bare word "disconnect" is not enough: a threat needs a service to cut off.
    const tags = stagesOf('Do not disconnect the call, stay with me.');
    assert.ok(tags.includes('ISOLATION'));
    assert.ok(!tags.includes('THREAT'));
});

test('a service being cut off is a threat', () => {
    assert.ok(stagesOf('Your electricity connection will be disconnected tonight.').includes('THREAT'));
});

test('tags come back in taxonomy order, so a transcript reads as a script', () => {
    const tags = stagesOf('Pay 2 lakh now. This is CBI. A warrant is issued. Hello sir.');
    const order = tags.map((t) => stages.STAGES.indexOf(t));
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

// ---------------------------------------------------------------------------
// Devanagari and romanised Hindi/Marathi
// ---------------------------------------------------------------------------

test('stages are recognised in Marathi', () => {
    assert.ok(stagesOf('नमस्कार, मी महावितरण मधून बोलत आहे.').includes('CONTACT'));
    assert.ok(stagesOf('मी सायबर विभागातून बोलत आहे.').includes('AUTHORITY_CLAIM'));
    assert.ok(stagesOf('तुमच्या नावावर अवैध व्यवहार झाले आहेत.').includes('ACCUSATION'));
    assert.ok(stagesOf('तुम्हाला अटक होईल.').includes('THREAT'));
    assert.ok(stagesOf('कोणालाही सांगू नका.').includes('ISOLATION'));
    assert.ok(stagesOf('ताबडतोब करा.').includes('URGENCY'));
    assert.ok(stagesOf('पाच लाख रक्कम पाठवा.').includes('PAYMENT_DEMAND'));
    assert.ok(stagesOf('ओटीपी सांगा.').includes('CREDENTIAL_REQUEST'));
});

test('stages are recognised in Hindi', () => {
    assert.ok(stagesOf('आपका खाता बंद हो जाएगा, तुरंत ओटीपी बताओ.').includes('CREDENTIAL_REQUEST'));
    assert.ok(stagesOf('आपका खाता बंद हो जाएगा, तुरंत ओटीपी बताओ.').includes('URGENCY'));
    assert.ok(stagesOf('मैं पुलिस विभाग से बोल रहा हूं.').includes('AUTHORITY_CLAIM'));
});

// ---------------------------------------------------------------------------
// Method provenance and the LLM pass
// ---------------------------------------------------------------------------

test('a rule tag records the matched words as its evidence', () => {
    const [tag] = stages.tagWithRules('Share the OTP immediately.').filter((t) => t.stage === 'CREDENTIAL_REQUEST');
    assert.equal(tag.method, 'rules');
    assert.ok(tag.evidence.length > 0);
    assert.ok(/otp/i.test(tag.evidence));
});

test('the LLM is only asked about stages the rules missed', async () => {
    let asked = null;
    const llm = new LlmClient(
        { baseUrl: 'x', apiKey: 'placeholder', model: 'm', timeoutMs: 100 },
        {
            transport: async (request) => {
                asked = request.messages[0].content;
                return JSON.stringify({ stages: [] });
            },
        }
    );

    await stages.tag('Share the OTP immediately.', { llm });

    assert.ok(!asked.includes('CREDENTIAL_REQUEST'), 'the rules already found this one');
    assert.ok(!asked.includes('URGENCY'), 'the rules already found this one');
    assert.ok(asked.includes('ACCUSATION'), 'the rules did not find this one');
});

test('an LLM tag is recorded with method "llm"', async () => {
    const llm = llmReturning({
        stages: [{ stage: 'ACCUSATION', evidence: 'they say the money is not yours' }],
    });

    const tags = await stages.tag('The money in your account does not belong to you.', { llm });
    const accusation = tags.find((t) => t.stage === 'ACCUSATION');

    assert.ok(accusation, 'the LLM caught what the vocabulary missed');
    assert.equal(accusation.method, 'llm');
    assert.equal(accusation.evidence, 'they say the money is not yours');
});

test('the LLM cannot overrule a rule tag or duplicate it', async () => {
    const llm = llmReturning({
        stages: [{ stage: 'CREDENTIAL_REQUEST', evidence: 'invented' }],
    });

    const tags = await stages.tag('Share the OTP immediately.', { llm });
    const credential = tags.filter((t) => t.stage === 'CREDENTIAL_REQUEST');

    assert.equal(credential.length, 1);
    assert.equal(credential[0].method, 'rules', 'the matched phrase wins over the model');
});

test('the LLM cannot invent a stage outside the taxonomy', async () => {
    const llm = llmReturning({ stages: [{ stage: 'MIND_CONTROL', evidence: 'x' }] });
    const tags = await stages.tag('Hello sir.', { llm });
    assert.ok(tags.every((t) => stages.STAGES.includes(t.stage)));
});

test('a malformed LLM reply leaves the rule tags intact', async () => {
    const llm = llmReturning({ nonsense: true });
    const tags = await stages.tag('Share the OTP immediately.', { llm });
    assert.ok(tags.some((t) => t.stage === 'CREDENTIAL_REQUEST'));
});

test('a failing LLM leaves the rule tags intact', async () => {
    const broken = new LlmClient(
        { baseUrl: 'x', apiKey: 'placeholder', model: 'm', timeoutMs: 10 },
        { transport: async () => { throw new Error('down'); }, sleep: () => Promise.resolve() }
    );

    const tags = await stages.tag('Share the OTP immediately.', { llm: broken });
    assert.ok(tags.some((t) => t.stage === 'CREDENTIAL_REQUEST'));
    assert.ok(tags.every((t) => t.method === 'rules'));
});

test('with no LLM at all, tagging still works', async () => {
    const tags = await stages.tag('Share the OTP immediately.', { llm: null });
    assert.ok(tags.some((t) => t.stage === 'CREDENTIAL_REQUEST'));
});

test('every stage in the taxonomy has a description for the prompt', () => {
    for (const stage of stages.STAGES) {
        assert.ok(stages.STAGE_DESCRIPTIONS[stage], stage);
        assert.ok(stages.RULES[stage], `${stage} has no rules`);
    }
});
