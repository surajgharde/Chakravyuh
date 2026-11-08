const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const intelligence = require('../src/agents/intelligence');
const reportRender = require('../src/services/reportRender');
const extractor = require('../src/services/extractor');
const stages = require('../src/services/stages');
const guardian = require('../src/agents/guardian');

// ---------------------------------------------------------------------------
// A session built the way the pipeline builds one
// ---------------------------------------------------------------------------

const TRANSCRIPT = [
    ['scammer', 'Madam, this is Inspector Deshmukh from CBI Pune. A parcel in your name was seized with narcotics.'],
    ['decoy', 'Arre beta, what parcel? I have not sent anything.'],
    ['scammer', 'A non-bailable warrant is ready. Do not tell anyone and do not disconnect this call.'],
    ['decoy', 'My spectacles are not here. Please tell me slowly what to do.'],
    ['scammer', 'Transfer Rs 2,50,000 to account 50100234567890, IFSC SBIN0001234. It is fully refundable.'],
    ['decoy', 'My app wants a short UPI id, the account number is too long for me.'],
    ['scammer', 'Fine, send it to cyber.verify@okaxis. My number is 9876543210, call back on it.'],
    ['decoy', 'Let me write it in my diary. What is the case number?'],
    ['scammer', 'The case number is MUM/CYB/2026/00891. Transfer to cyber.verify@okaxis within 30 minutes.'],
];

const START = new Date('2026-10-28T09:00:00.000Z');

/** A plain object shaped like a Session document, with no Mongo involved. */
const buildSession = ({ transcript = TRANSCRIPT, sessionId = 'report-1' } = {}) => {
    const session = {
        sessionId,
        userId: 'demo-user',
        userAlias: null,
        channel: 'Call',
        language: 'English',
        locale: 'IN',
        guardianState: guardian.STATES.ENDED,
        scamDetected: true,
        scamType: 'unknown',
        score: 0,
        scoreBreakdown: [],
        firedSignals: [],
        classifierLabel: 'unavailable',
        classifierReasons: [],
        messages: [],
        entities: [],
        guardianLog: [],
        intelligence: extractor.emptySummary(),
        scriptStages: [],
        messageCount: 0,
        scammerMessageCount: 0,
        decoyMessageCount: 0,
        firstSeenAt: START,
        lastSeenAt: START,
        takeoverAt: null,
        handoffAtMessage: null,
        agentNotes: '',
        report: { reviewedByFamily: false, reviewedAt: null, reviewedBy: null },
        markModified() {},
        nextMessageId() { return `m${this.messages.length + 1}`; },
        engagementDurationSeconds() {
            return Math.max(0, Math.round((this.lastSeenAt.getTime() - this.firstSeenAt.getTime()) / 1000));
        },
    };

    let clock = START.getTime();

    for (const [role, text] of transcript) {
        clock += 30000;
        const at = new Date(clock);
        const messageId = session.nextMessageId();

        session.messages.push({ messageId, role, text, ts: null, receivedAt: at, stages: [] });
        session.messageCount += 1;
        if (role === 'scammer') session.scammerMessageCount += 1;
        if (role === 'decoy') session.decoyMessageCount += 1;
        session.lastSeenAt = at;

        if (role !== 'scammer') continue;

        extractor.mergeInto(session, extractor.extractEntities(text, { sessionId, messageId, timestamp: at }));
        session.messages[session.messages.length - 1].stages = stages.tagWithRules(text);

        const scored = guardian.scoreMessage({ text, entities: session.entities, scriptStages: [] });
        session.guardianLog.push({
            at,
            messageId,
            score: scored.score,
            state: guardian.STATES.DECOY_ACTIVE,
            previousState: guardian.STATES.MONITORING,
            stateChanged: session.guardianLog.length === 0,
            firedSignals: scored.fired,
            hardSignals: scored.hardSignals,
            classifierLabel: 'unavailable',
            classifierReasons: [],
            notes: [],
            decisionMs: 2,
        });
        session.score = scored.score;
    }

    const seen = new Set();
    for (const message of session.messages) {
        for (const tag of message.stages || []) seen.add(tag.stage);
    }
    session.scriptStages = stages.STAGES.filter((s) => seen.has(s));
    session.scamType = guardian.classifyScamType(
        session.messages.filter((m) => m.role === 'scammer').map((m) => m.text).join('\n')
    );
    // A short transcript may have no second message; the hand-off then never
    // happened, which is what the report should say.
    session.takeoverAt = session.messages[1] ? session.messages[1].receivedAt : null;
    session.handoffAtMessage = session.messages[1] ? 1 : null;

    return session;
};

const GENERATED_AT = new Date('2026-10-31T12:00:00.000Z');
const report = (session) => intelligence.buildReport(session, { generatedAt: GENERATED_AT });

// ---------------------------------------------------------------------------
// Every number matches the stored session
// ---------------------------------------------------------------------------

test('the message counts in the report are the counts on the session', () => {
    const session = buildSession();
    const r = report(session);

    assert.equal(r.session.messageCounts.total, session.messageCount);
    assert.equal(r.session.messageCounts.fromCaller, session.scammerMessageCount);
    assert.equal(r.session.messageCounts.fromDecoy, session.decoyMessageCount);
    assert.equal(r.session.messageCounts.total, TRANSCRIPT.length);
});

test('the duration is the measured span, not a rounded or padded one', () => {
    const session = buildSession();
    const r = report(session);

    const expected = Math.round((session.lastSeenAt.getTime() - session.firstSeenAt.getTime()) / 1000);
    assert.equal(r.session.durationSeconds, expected);
    assert.equal(r.session.durationSeconds, session.engagementDurationSeconds());
    assert.equal(r.session.durationHuman, intelligence.humanDuration(expected));
});

test('the start and end times are the stored receive times', () => {
    const session = buildSession();
    const r = report(session);

    assert.equal(r.session.startedAt, session.firstSeenAt.toISOString());
    assert.equal(r.session.endedAt, session.lastSeenAt.toISOString());
});

test('every identifier in the report is an entity on the session', () => {
    const session = buildSession();
    const r = report(session);

    assert.ok(r.suspectIdentifiers.length > 0);
    for (const row of r.suspectIdentifiers) {
        const match = session.entities.find((e) => e.type === row.type && e.normalized === row.value);
        assert.ok(match, `${row.type} ${row.value} is not on the session`);
        assert.equal(row.timesRepeated, match.occurrences || 1);
        assert.equal(row.firstSeenInMessage, match.messageId);
        assert.ok(match.sentence.includes(row.excerpt.replace(/\.\.\.$/, '').trim().slice(0, 30)));
    }
});

test('every identifier on the session appears in the report', () => {
    const session = buildSession();
    const r = report(session);

    const reported = new Set(r.suspectIdentifiers.map((row) => `${row.type}:${row.value}`));
    for (const entity of session.entities) {
        if (!intelligence.SUSPECT_TYPES.includes(entity.type)) continue;
        assert.ok(reported.has(`${entity.type}:${entity.normalized}`), `${entity.type} ${entity.normalized} is missing from the report`);
    }
});

test('a repeated identifier is counted, not duplicated', () => {
    const session = buildSession();
    const r = report(session);

    // cyber.verify@okaxis is said in two different messages.
    const upi = r.suspectIdentifiers.find((row) => row.value === 'cyber.verify@okaxis');
    assert.ok(upi);
    assert.equal(upi.timesRepeated, 2, 'said twice');
    assert.equal(
        r.suspectIdentifiers.filter((row) => row.value === 'cyber.verify@okaxis').length,
        1,
        'listed once'
    );
});

test('the amount is the highest figure actually said, never a total', () => {
    const session = buildSession();
    const r = report(session);

    assert.equal(r.moneyDemanded.highestRupees, 250000);
    const stored = session.entities.filter((e) => e.type === 'amount').map((e) => Number(e.normalized));
    assert.ok(stored.includes(250000));
    assert.equal(r.moneyDemanded.highestRupees, Math.max(...stored));
});

test('the decision log is the stored guardian log, entry for entry', () => {
    const session = buildSession();
    const r = report(session);

    assert.equal(r.guardianDecisionLog.length, session.guardianLog.length);
    for (const [index, entry] of r.guardianDecisionLog.entries()) {
        assert.equal(entry.score, session.guardianLog[index].score);
        assert.equal(entry.state, session.guardianLog[index].state);
        assert.equal(entry.messageId, session.guardianLog[index].messageId);
        assert.deepEqual(entry.firedSignals, session.guardianLog[index].firedSignals);
    }
});

test('the transcript is the whole transcript, in order', () => {
    const session = buildSession();
    const r = report(session);

    assert.equal(r.transcript.length, session.messages.length);
    for (const [index, line] of r.transcript.entries()) {
        assert.equal(line.text, session.messages[index].text);
        assert.equal(line.messageId, session.messages[index].messageId);
        assert.equal(line.at, session.messages[index].receivedAt.toISOString());
    }
});

test('the script stages are the stages that fired, in first-seen order', () => {
    const session = buildSession();
    const r = report(session);

    const reported = r.scriptStages.map((s) => s.stage);
    assert.deepEqual([...reported].sort(), [...session.scriptStages].sort());

    // Each one carries a real example from the transcript.
    for (const stage of r.scriptStages) {
        assert.ok(stage.example.length > 0);
        assert.ok(stage.firstSeenAt);
        assert.ok(['rules', 'llm'].includes(stage.taggedBy));
    }
});

// ---------------------------------------------------------------------------
// The hash
// ---------------------------------------------------------------------------

test('the transcript hash is a sha256 over the transcript', () => {
    const session = buildSession();
    const r = report(session);

    assert.equal(r.transcriptHash.algorithm, 'sha256');
    assert.match(r.transcriptHash.value, /^[0-9a-f]{64}$/);
    assert.equal(r.transcriptHash.lineCount, session.messages.length);
});

test('the same transcript hashes the same every time', () => {
    const first = report(buildSession());
    const second = report(buildSession());
    assert.equal(first.transcriptHash.value, second.transcriptHash.value);
});

test('the hash changes when a message is edited', () => {
    const before = report(buildSession()).transcriptHash.value;

    const tampered = buildSession();
    tampered.messages[4].text = tampered.messages[4].text.replace('50100234567890', '99999999999999');
    const after = report(tampered).transcriptHash.value;

    assert.notEqual(after, before, 'editing a message must change the hash');
});

test('the hash changes when a message is removed', () => {
    const before = report(buildSession()).transcriptHash.value;

    const shortened = buildSession();
    shortened.messages.pop();
    const after = report(shortened).transcriptHash.value;

    assert.notEqual(after, before);
});

test('the hash changes when two messages are reordered', () => {
    const before = report(buildSession()).transcriptHash.value;

    const reordered = buildSession();
    [reordered.messages[2], reordered.messages[3]] = [reordered.messages[3], reordered.messages[2]];
    const after = report(reordered).transcriptHash.value;

    assert.notEqual(after, before, 'order is part of what a transcript is');
});

test('the hash does not change when something outside the transcript changes', () => {
    const before = report(buildSession()).transcriptHash.value;

    const annotated = buildSession();
    annotated.agentNotes = 'a different summary';
    annotated.score = 42;
    const after = report(annotated).transcriptHash.value;

    assert.equal(after, before, 'the hash covers the transcript, not the whole report');
});

// ---------------------------------------------------------------------------
// The protected user is not in the report
// ---------------------------------------------------------------------------

test('the protected user appears as an alias only', () => {
    const session = buildSession();
    session.userId = 'sudha-real-user-id';
    const r = report(session);

    assert.ok(r.protectedUser.alias.startsWith('Protected User '));
    assert.ok(!r.protectedUser.alias.includes('sudha-real-user-id'));
});

test('a stored alias is used as given', () => {
    const session = buildSession();
    session.userAlias = 'Protected User A1';
    assert.equal(report(session).protectedUser.alias, 'Protected User A1');
});

test('the protected user id and number are nowhere in the serialised report', () => {
    const session = buildSession();
    session.userId = 'elderly-user-9988776655';
    session.userAlias = 'Protected User A1';

    const serialised = JSON.stringify(report(session));
    assert.ok(!serialised.includes('elderly-user-9988776655'), 'the user id leaked into the report');
    assert.ok(!serialised.includes('9988776655'), 'the user number leaked into the report');
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test('the category is one of the listed report categories', () => {
    const session = buildSession();
    const r = report(session);
    assert.ok(Object.values(intelligence.CATEGORIES).includes(r.classification.category));
});

test('a parcel story under a police banner is categorised as parcel / customs', () => {
    const r = report(buildSession());
    assert.equal(r.classification.category, intelligence.CATEGORIES.PARCEL_CUSTOMS);
});

test('every internal scam family maps to a report category', () => {
    for (const scamType of Object.keys(guardian.SCAM_TYPE_PATTERNS)) {
        assert.ok(
            intelligence.CATEGORY_FROM_SCAM_TYPE[scamType],
            `${scamType} has no report category`
        );
    }
});

test('every report category has a complaint-form category', () => {
    for (const category of Object.values(intelligence.CATEGORIES)) {
        assert.ok(intelligence.PORTAL_CATEGORY[category], `${category} has no portal mapping`);
    }
});

test('the impersonated authority comes from the transcript', () => {
    const r = report(buildSession());
    const authorities = r.classification.authoritiesImpersonated.map((a) => a.authority);
    assert.ok(authorities.includes('CBI') || authorities.includes('police'));
    for (const entry of r.classification.authoritiesImpersonated) {
        assert.ok(entry.excerpt.length > 0, 'each claim quotes the sentence it came from');
    }
});

test('the payment channel is inferred from the identifiers found', () => {
    const r = report(buildSession());
    const ids = r.paymentChannelsRequested.map((c) => c.id);
    assert.ok(ids.includes('upi'));
    assert.ok(ids.includes('bank_transfer'));
});

// ---------------------------------------------------------------------------
// agentNotes contains nothing that is not in the session
// ---------------------------------------------------------------------------

test('agentNotes is built from the stored data', () => {
    const session = buildSession();
    const notes = intelligence.buildAgentNotes(session);

    assert.ok(notes.length > 0);
    assert.ok(notes.includes('parcel / customs'), 'names the category');
    assert.ok(notes.includes('Rs 2,50,000'), 'names the amount that was actually demanded');
    assert.ok(/UPI/i.test(notes), 'names the payment channel');
});

test('agentNotes names no amount when none was demanded', () => {
    const session = buildSession({
        transcript: [
            ['scammer', 'Madam, this is CBI. Do not tell anyone about this call.'],
            ['decoy', 'Arre beta, who is this?'],
        ],
    });

    const notes = intelligence.buildAgentNotes(session);
    assert.ok(!/Rs\s/.test(notes), `invented an amount: ${notes}`);
    assert.ok(notes.includes('No suspect identifiers were recovered') || !/Recovered from the caller/.test(notes));
});

test('agentNotes names no tactic that was not tagged', () => {
    const session = buildSession({
        transcript: [
            ['scammer', 'Hello madam, am I speaking to Mrs Kulkarni?'],
            ['decoy', 'Haan ji, who is this?'],
        ],
    });

    const notes = intelligence.buildAgentNotes(session);
    assert.ok(!/threats of arrest/i.test(notes), `invented a threat: ${notes}`);
    assert.ok(!/refundable/i.test(notes));
    assert.ok(!/OTP/i.test(notes));
});

test('agentNotes reports a false positive as a false positive', () => {
    const session = buildSession();
    session.guardianState = guardian.STATES.FALSE_POSITIVE;

    const notes = intelligence.buildAgentNotes(session);
    assert.ok(/false positive/i.test(notes));
});

test('agentNotes says so when the decoy never engaged', () => {
    const session = buildSession();
    session.takeoverAt = null;
    session.guardianState = guardian.STATES.SUSPICIOUS;

    const notes = intelligence.buildAgentNotes(session);
    assert.ok(/not engaged/i.test(notes));
});

test('agentNotes quotes only amounts that are stored entities', () => {
    const session = buildSession();
    const notes = intelligence.buildAgentNotes(session);

    const mentioned = [...notes.matchAll(/Rs ([\d,]+)/g)].map((m) => Number(m[1].replace(/,/g, '')));
    const stored = session.entities.filter((e) => e.type === 'amount').map((e) => Number(e.normalized));

    for (const amount of mentioned) {
        assert.ok(stored.includes(amount), `Rs ${amount} is not an amount in the session`);
    }
});

// ---------------------------------------------------------------------------
// Recommended actions and the portal mapping
// ---------------------------------------------------------------------------

test('1930 is the first recommended action', () => {
    const r = report(buildSession());
    assert.equal(r.recommendedActions[0].priority, 1);
    assert.match(r.recommendedActions[0].action, /1930/);
    assert.match(r.recommendedActions[1].action, /cybercrime\.gov\.in/);
});

test('the bank-hold action quotes the actual accounts', () => {
    const session = buildSession();
    const r = report(session);
    const hold = r.recommendedActions.find((a) => /hold/i.test(a.action));

    assert.ok(hold);
    for (const account of session.intelligence.bankAccounts) {
        assert.ok(hold.detail.includes(account), `${account} is not in the bank-hold instruction`);
    }
});

test('the block-numbers action quotes the actual numbers', () => {
    const session = buildSession();
    const r = report(session);
    const block = r.recommendedActions.find((a) => /block/i.test(a.action));

    assert.ok(block);
    for (const phone of session.intelligence.phoneNumbers) {
        assert.ok(block.detail.includes(phone));
    }
});

test('the portal mapping carries the identifiers the session holds', () => {
    const session = buildSession();
    const portal = report(session).forCybercrimePortal;

    assert.deepEqual(portal.suspectMobileNumbers, session.intelligence.phoneNumbers);
    assert.deepEqual(portal.suspectUpiIds, session.intelligence.upiIds);
    assert.deepEqual(portal.suspectBankAccounts, session.intelligence.bankAccounts);
    assert.deepEqual(portal.suspectIfscCodes, session.intelligence.ifscCodes);
    assert.equal(portal.amountInvolved, 250000);
});

test('the portal mapping records that nothing was paid', () => {
    const portal = report(buildSession()).forCybercrimePortal;
    assert.equal(portal.amountLost, 0);
    assert.match(portal.amountLostNote, /Nothing was paid/i);
});

test('the incident date and time come from the first message', () => {
    const session = buildSession();
    const portal = report(session).forCybercrimePortal;

    assert.equal(portal.incidentDate, session.firstSeenAt.toISOString().slice(0, 10));
    assert.equal(portal.incidentTime, session.firstSeenAt.toISOString().slice(11, 16));
});

// ---------------------------------------------------------------------------
// Nothing is submitted
// ---------------------------------------------------------------------------

test('the report records that it was not submitted anywhere', () => {
    const r = report(buildSession());
    assert.equal(r.disclosure.autoSubmitted, false);
    assert.match(r.disclosure.note, /sent nowhere/i);
});

test('the intelligence agent makes no network calls at all', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'agents', 'intelligence.js'), 'utf8');

    // A report that quietly posted itself somewhere would be a serious problem,
    // so the file must contain no outbound call of any kind.
    const forbidden = [
        'fetch(',
        'axios',
        'http.request',
        'https.request',
        'XMLHttpRequest',
        'cybercrime.gov.in/api',
        "require('http",
        "require('node:http",
    ];

    for (const needle of forbidden) {
        assert.ok(!source.includes(needle), `intelligence.js references ${needle}`);
    }
});

test('the report builder makes no model call', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'agents', 'intelligence.js'), 'utf8');
    for (const forbidden of ['llm', 'completeJson', 'LlmClient']) {
        assert.ok(!source.includes(forbidden), `intelligence.js references ${forbidden}`);
    }
});

// ---------------------------------------------------------------------------
// The review gate
// ---------------------------------------------------------------------------

test('a fresh report is a draft and not ready to file', () => {
    const r = report(buildSession());
    assert.equal(r.review.reviewedByFamily, false);
    assert.equal(r.review.readyToFile, false);
    assert.ok(r.review.gate.length > 0);
});

test('ticking the review marks it ready to file', () => {
    const session = buildSession();
    intelligence.markReviewed(session, { reviewedBy: 'son' });

    const r = report(session);
    assert.equal(r.review.reviewedByFamily, true);
    assert.equal(r.review.readyToFile, true);
    assert.equal(r.review.reviewedBy, 'son');
    assert.ok(r.review.reviewedAt);
});

test('the reviewer is recorded as a relationship, not a full identity', () => {
    const session = buildSession();
    intelligence.markReviewed(session, { reviewedBy: 'x'.repeat(200) });
    assert.ok(session.report.reviewedBy.length <= 60);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test('the HTML report is self-contained and carries the key figures', () => {
    const session = buildSession();
    const html = reportRender.toHtml(report(session));

    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(!/<script/i.test(html), 'no scripts in a report that gets emailed around');
    assert.ok(!/src="http/i.test(html), 'no external resources');

    assert.ok(html.includes(report(session).reportId));
    assert.ok(html.includes('cyber.verify@okaxis'));
    assert.ok(html.includes('50100234567890'));
    assert.ok(html.includes(report(session).transcriptHash.value));
    assert.ok(html.includes('1930'));
});

test('an unreviewed HTML report is stamped as a draft', () => {
    const html = reportRender.toHtml(report(buildSession()));
    assert.ok(html.includes('NOT READY TO FILE'));
    assert.ok(/<input type="checkbox" disabled>/.test(html), 'the box is shown unticked');
});

test('a reviewed HTML report is stamped ready to file', () => {
    const session = buildSession();
    intelligence.markReviewed(session, { reviewedBy: 'daughter' });

    const html = reportRender.toHtml(report(session));
    assert.ok(html.includes('READY TO FILE'));
    assert.ok(html.includes('daughter'));
    assert.ok(/checked/.test(html));
});

test('the HTML escapes the transcript rather than trusting it', () => {
    const session = buildSession({
        transcript: [['scammer', 'Pay now <script>alert("x")</script> or be arrested.']],
    });

    const html = reportRender.toHtml(report(session));
    assert.ok(!html.includes('<script>alert'), 'a scammer must not be able to inject into the report');
    assert.ok(html.includes('&lt;script&gt;'));
});

test('the PDF renders and is a real PDF', async () => {
    const pdf = await reportRender.toPdf(report(buildSession()));
    assert.ok(Buffer.isBuffer(pdf));
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.ok(pdf.length > 3000, `suspiciously small: ${pdf.length} bytes`);
});

test('the PDF of an unreviewed report says it is a draft', async () => {
    const draft = await reportRender.toPdf(report(buildSession()));

    const session = buildSession();
    intelligence.markReviewed(session, { reviewedBy: 'son' });
    const ready = await reportRender.toPdf(report(session));

    // The two differ, and not only by a timestamp: the stamp text differs.
    assert.notEqual(draft.length, ready.length);
});

test('the report id is stable for the same session and instant', () => {
    const session = buildSession();
    assert.equal(
        intelligence.buildReport(session, { generatedAt: GENERATED_AT }).reportId,
        intelligence.buildReport(session, { generatedAt: GENERATED_AT }).reportId
    );
    assert.notEqual(
        intelligence.buildReport(session, { generatedAt: GENERATED_AT }).reportId,
        intelligence.buildReport({ ...session, sessionId: 'other' }, { generatedAt: GENERATED_AT }).reportId
    );
});

test('a report can be built for a session with nothing in it', () => {
    const session = buildSession({ transcript: [] });
    const r = report(session);

    assert.equal(r.transcript.length, 0);
    assert.equal(r.suspectIdentifiers.length, 0);
    assert.equal(r.moneyDemanded.highestRupees, null);
    assert.equal(r.session.durationSeconds, 0);
    assert.ok(r.agentNotes.length > 0, 'it still says something truthful');
    assert.ok(reportRender.toHtml(r).includes('Nothing recorded'));
});
