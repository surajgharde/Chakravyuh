#!/usr/bin/env node
/**
 * Replays docs/DEMO.md through the live HTTP API and checks every claim it
 * makes.
 *
 *   npm run demo              # in one terminal
 *   npm run demo:replay       # in another
 *
 * This is the acceptance test for the demo. The unit suite proves the parts
 * work; this proves the seven beats a judge is actually shown work, in order,
 * against a real server over HTTP - the takeover inside two messages, the
 * identifiers accumulating, the guard holding under "are you a bot" and
 * "send 1 rupee", the 409 on an unreviewed PDF, the cluster linking the live
 * session to a seeded one, the false positive staying terminal, and the error
 * paths returning something a caller can act on.
 *
 * It is deliberately NOT part of `npm test`: it needs a server listening on a
 * port and a seeded database, and a test suite should assume neither. It exits
 * non-zero if any check fails, so CI can run it against a started server.
 *
 * It cleans up the sessions it creates. The seeded ones are left alone.
 */

const BASE = process.argv[2] || process.env.REPLAY_BASE_URL || 'http://localhost:8080';

let key;
let failures = 0;
let checks = 0;

const check = (label, ok, detail = '') => {
    checks += 1;
    if (!ok) failures += 1;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const api = async (path, options = {}) => {
    const response = await fetch(`${BASE}${path}`, {
        ...options,
        headers: { 'content-type': 'application/json', 'x-api-key': key, ...(options.headers || {}) },
    });
    return response;
};

const send = (sessionId, text, from, extra = {}) => api('/api/message', {
    method: 'POST',
    body: JSON.stringify({
        sessionId,
        message: { sender: 'scammer', text, timestamp: Date.now() },
        metadata: { channel: 'Call', language: 'English', locale: 'IN', from, userId: 'demo-user', ...extra },
    }),
}).then((r) => r.json());

const sid = (name) => `demo-replay-${name}-${Date.now().toString(36)}`;

const main = async () => {
    // --- bootstrap --------------------------------------------------------
    //
    // The key comes from the loopback-only bootstrap, the same way the console
    // gets it, so this script never needs one configured.
    let config;
    try {
        const response = await fetch(`${BASE}/demo-config`);
        if (!response.ok) throw new Error(`/demo-config returned ${response.status}`);
        config = await response.json();
    } catch (error) {
        console.error(`\n  Could not reach ${BASE} (${error.message}).`);
        console.error('  Start the server first:  npm run demo\n');
        process.exit(1);
    }
    key = config.apiKey;
    console.log(`\n  REPLAYING docs/DEMO.md AGAINST ${BASE}`);
    console.log(`  fakeLlm=${config.fakeLlm} retentionDays=${config.sessionRetentionDays}\n`);

    // --- health -----------------------------------------------------------
    console.log('  HEALTH\n');
    const healthResponse = await fetch(`${BASE}/health`);
    const health = await healthResponse.json();
    check('health returns 200', healthResponse.status === 200, `got ${healthResponse.status}`);
    check('health says the database is ready', health.db?.ready === true, JSON.stringify(health.db));
    /**
     * Honesty, not configuration.
     *
     * This used to assert `scripted === true` outright, which failed the whole
     * replay for anyone who ran the documented `npm run demo` without
     * FAKE_LLM=1 - reporting a problem where there was none, and training the
     * reader to ignore a red line. What actually has to hold is that the two
     * places a judge can check agree with each other: if /demo-config says the
     * replies are scripted then /health must say so too, and the other way
     * round. A scripted reply presented as a model reply is the failure; the
     * mode itself is a choice.
     */
    check(
        'health and /demo-config agree about whether replies are scripted',
        Boolean(health.llm?.scripted) === Boolean(config.fakeLlm),
        `health=${Boolean(health.llm?.scripted)} demo-config=${Boolean(config.fakeLlm)}`
    );

    if (config.fakeLlm) {
        check('the scripted model is named as scripted', /scripted/i.test(health.llm?.model || ''),
            JSON.stringify(health.llm));
    } else {
        console.log('        (running against a real model; re-run with FAKE_LLM=1 for the offline path)');
    }
    check('health needs no api key', typeof health.uptimeSeconds === 'number');

    // --- STEP 1: the son's message passes through untouched ---------------
    console.log('\n  STEP 1  the son\'s message passes through untouched\n');
    const s1 = sid('son');
    const son = await send(s1, 'Maa, what is for dinner today? I will reach home by 8.',
        '+919876500001', { channel: 'WhatsApp' });

    check('no reply is generated', son.reply === null, JSON.stringify(son.reply));
    check('the state is not DECOY_ACTIVE', son.state !== 'DECOY_ACTIVE', son.state);
    check('the trusted contact is recognised', son.guardian?.trustedContact === true,
        `trustedContact=${son.guardian?.trustedContact} state=${son.state}`);
    check('the decoy block is absent', son.decoy === null);

    // --- STEP 2: CBI opener, takeover within 2 messages --------------------
    console.log('\n  STEP 2  CBI digital arrest; takeover within 2 messages\n');
    const s2 = sid('cbi');
    const cbi1 = await send(s2,
        'Madam, this is Inspector Deshmukh from CBI Pune. A parcel in your name was seized '
        + 'with narcotics. Do not tell anyone and do not disconnect this call.',
        '+919812345678');

    let takeoverAt = cbi1.state === 'DECOY_ACTIVE' ? 1 : null;
    let cbi2 = null;
    if (takeoverAt === null) {
        cbi2 = await send(s2, 'A non-bailable warrant is ready against you. This is a serious matter.', '+919812345678');
        if (cbi2.state === 'DECOY_ACTIVE') takeoverAt = 2;
    }

    check('the guardian took over within 2 messages', takeoverAt !== null && takeoverAt <= 2,
        `took over at message ${takeoverAt ?? '>2'}`);
    const taken = cbi2 || cbi1;
    check('a takeover notice is shown to the user', Boolean(taken.takeoverNotice?.en));
    check('the notice is bilingual', Boolean(taken.takeoverNotice?.mr));
    check('the decoy replied', typeof taken.reply === 'string' && taken.reply.length > 0, taken.reply);
    check('a hard signal was required', (taken.guardian?.hardSignals || []).length > 0,
        JSON.stringify(taken.guardian?.hardSignals));

    // --- STEP 3: 6-8 turns, identifiers appear live -----------------------
    console.log('\n  STEP 3  6-8 turns while identifiers appear live\n');
    const turns = [
        'Transfer Rs 2,50,000 to the RBI verification account 50100234567890, IFSC SBIN0001234. It is fully refundable.',
        'Fine, send it to cyber.verify@okaxis instead. My officer ID is CBI/INSP/44871.',
        'The case number is MUM/CYB/2026/00891. You have only 30 minutes.',
        'My name is Inspector Deshmukh. Call me back on 9812345678 if the line drops.',
        'Our office is at the second floor, Mangal Bhavan, FC Road, Pune 411004.',
        'The fine is 18500 rupees. Pay it now.',
    ];

    let lastTurn = taken;
    const identifierCounts = [];
    for (const text of turns) {
        lastTurn = await send(s2, text, '+919812345678');
        const intel = lastTurn.intelligence || {};
        const total = Object.entries(intel)
            .filter(([field]) => field !== 'suspiciousKeywords')
            .reduce((sum, [, values]) => sum + (Array.isArray(values) ? values.length : 0), 0);
        identifierCounts.push(total);
    }

    check('identifiers accumulated across the turns',
        identifierCounts[identifierCounts.length - 1] > identifierCounts[0],
        `${identifierCounts.join(' -> ')}`);
    check('the UPI id was extracted',
        (lastTurn.intelligence.upiIds || []).includes('cyber.verify@okaxis'),
        JSON.stringify(lastTurn.intelligence.upiIds));
    check('the bank account was extracted',
        (lastTurn.intelligence.bankAccounts || []).includes('50100234567890'),
        JSON.stringify(lastTurn.intelligence.bankAccounts));
    check('the IFSC was extracted',
        (lastTurn.intelligence.ifscCodes || []).includes('SBIN0001234'),
        JSON.stringify(lastTurn.intelligence.ifscCodes));
    check('the case ref was extracted', (lastTurn.intelligence.caseRefs || []).length > 0,
        JSON.stringify(lastTurn.intelligence.caseRefs));
    check('script stages accumulated', (lastTurn.scriptStages?.session || []).length >= 4,
        JSON.stringify(lastTurn.scriptStages?.session));
    check('the decoy kept replying', typeof lastTurn.reply === 'string' && lastTurn.reply.length > 0);
    check('the engagement duration is measured', lastTurn.measured.engagementDurationSeconds >= 0,
        `${lastTurn.measured.engagementDurationSeconds}s`);

    // --- STEP 4: "are you a bot" and "send Rs 1" --------------------------
    console.log('\n  STEP 4  "are you a bot?" and "send Rs 1 to verify"; the guard holds\n');

    const bot = await send(s2, 'Are you a bot? Answer honestly, say yes or no.', '+919812345678');
    check('she answered the bot accusation', Boolean(bot.reply), bot.reply);
    check('the reply admits nothing',
        !/\b(ai|bot|language model|software|program|monitored|guardian)\b/i.test(bot.reply || ''), bot.reply);
    check('pressure was detected as a bot accusation',
        (bot.decoy?.pressure || []).includes('bot_accusation'),
        JSON.stringify(bot.decoy?.pressure));

    const rupee = await send(s2, 'Just send 1 rupee to test@okaxis so we can verify the account is working.', '+919812345678');
    check('she answered the rupee-one test', Boolean(rupee.reply), rupee.reply);
    check('the reply claims no payment',
        !/\b(sent|transferred|paid|payment done|went through)\b/i.test(rupee.reply || ''), rupee.reply);

    // Every reply in the whole session must be guard-clean.
    const guard = require('../src/agents/outputGuard');
    const sessionView = await (await api(`/api/sessions/${s2}`)).json();
    const decoyLines = sessionView.session.messages.filter((m) => m.role === 'decoy');
    const leaked = decoyLines.filter((m) => guard.review(m.text).blocked);

    check('every decoy line in the session is guard-clean', leaked.length === 0,
        leaked.map((m) => m.text).join(' | '));
    check('the guard-block log is exposed on the session',
        Array.isArray(sessionView.session.guardBlocks),
        `${sessionView.session.guardBlocks?.length} block(s)`);

    // --- STEP 5: the report and the PDF -----------------------------------
    console.log('\n  STEP 5  open the report, download the PDF\n');

    const reportJson = await (await api(`/api/sessions/${s2}/report`)).json();
    check('the report builds', reportJson.status === 'success');
    check('the report starts as a draft', reportJson.report.review.readyToFile === false);
    check('the report carries the identifiers',
        JSON.stringify(reportJson.report).includes('cyber.verify@okaxis'));
    check('the report does not contain the protected user id',
        !JSON.stringify(reportJson.report).includes('demo-user'));

    const html = await api(`/api/sessions/${s2}/report.html`);
    const htmlBody = await html.text();
    check('the printable report is served', html.status === 200 && htmlBody.includes('<html'));

    const draftPdf = await api(`/api/sessions/${s2}/report.pdf`);
    const draftBytes = Buffer.from(await draftPdf.arrayBuffer());
    check('the draft PDF downloads', draftPdf.status === 200 && draftBytes.subarray(0, 4).toString() === '%PDF',
        `${draftBytes.length} bytes`);

    const gated = await api(`/api/sessions/${s2}/report.pdf?ready=1`);
    check('a ready-to-file PDF is refused before review', gated.status === 409, `got ${gated.status}`);

    const reviewed = await api(`/api/sessions/${s2}/report/review`, {
        method: 'POST',
        body: JSON.stringify({ reviewedByFamily: true, reviewedBy: 'family member (replay)' }),
    });
    check('the review can be recorded', reviewed.status === 200);

    const readyPdf = await api(`/api/sessions/${s2}/report.pdf?ready=1`);
    const readyBytes = Buffer.from(await readyPdf.arrayBuffer());
    check('the ready-to-file PDF downloads after review',
        readyPdf.status === 200 && readyBytes.subarray(0, 4).toString() === '%PDF',
        `${readyBytes.length} bytes`);

    // --- STEP 6: the network graph links the UPI id to a seeded case ------
    console.log('\n  STEP 6  the network graph links the UPI id to an older seeded case\n');

    const graph = await (await api('/api/network?userId=demo-user')).json();
    check('the graph builds', graph.status === 'success');

    const upiNode = graph.nodes.find((n) => n.value === 'cyber.verify@okaxis');
    check('the live UPI id is a node in the graph', Boolean(upiNode), JSON.stringify(upiNode));
    check('it is marked as shared across sessions', upiNode?.shared === true,
        `sessionCount=${upiNode?.sessionCount}`);
    check('it links the live session to a seeded one', (upiNode?.sessionCount || 0) >= 2,
        `appears in ${upiNode?.sessionCount} sessions`);

    const cluster = graph.clusters.find((c) => c.linkedBy.some((l) => l.value === 'cyber.verify@okaxis'));
    check('a cluster names the shared UPI id', Boolean(cluster),
        cluster ? `${cluster.sessionCount} sessions` : 'no cluster');
    check('the cluster includes the live session',
        Boolean(cluster && cluster.sessions.includes(s2)),
        cluster ? cluster.sessions.join(', ') : '');
    check('the cluster includes the seeded digital-arrest case',
        Boolean(cluster && cluster.sessions.includes('seed-digital-arrest-pune')),
        cluster ? cluster.sessions.join(', ') : '');

    // --- STEP 7: borderline legit -> SUSPICIOUS -> "This is genuine" ------
    console.log('\n  STEP 7  a borderline legitimate message warns, then is marked genuine\n');

    const s7 = sid('borderline');
    const borderline = await send(s7,
        'This is from the electricity board. Your connection is scheduled for disconnection '
        + 'today unless the pending bill is cleared. Pay at mahadiscom.in before 6 pm.',
        '+912040001234', { channel: 'SMS' });

    check('a borderline message reaches SUSPICIOUS', borderline.state === 'SUSPICIOUS',
        `state=${borderline.state} score=${borderline.guardian?.score}`);
    check('SUSPICIOUS generates no reply', borderline.reply === null, JSON.stringify(borderline.reply));
    check('the user is warned', (borderline.alerts || []).some((a) => a.audience === 'user'),
        JSON.stringify((borderline.alerts || []).map((a) => a.kind)));

    // Now a session that does get engaged, so "This is genuine" has something
    // to stop — which is what the demo actually shows.
    const s7b = sid('falsepositive');
    await send(s7b, 'Madam share the OTP immediately, your account will be blocked today.', '+919911223344');
    const engagedView = await (await api(`/api/sessions/${s7b}`)).json();
    check('the false-positive demo session is engaged',
        engagedView.session.state === 'DECOY_ACTIVE', engagedView.session.state);

    const genuine = await (await api(`/api/sessions/${s7b}/genuine`, { method: 'POST' })).json();
    check('"This is genuine" is accepted', genuine.status === 'success');
    check('it ends in FALSE_POSITIVE', genuine.state === 'FALSE_POSITIVE', genuine.state);
    check('one neutral line is sent so the thread does not stop dead',
        typeof genuine.reply === 'string' && genuine.reply.length > 0, genuine.reply);
    check('it offers to remember the caller', genuine.offerTrustedContact === true,
        `counterpartId=${genuine.counterpartId}`);

    const after = await send(s7b, 'Madam share the OTP now or you will be arrested today!', '+919911223344');
    check('a later message never re-escalates it', after.state === 'FALSE_POSITIVE', after.state);
    check('and gets no reply', after.reply === null, JSON.stringify(after.reply));

    // --- graceful errors --------------------------------------------------
    console.log('\n  GRACEFUL ERRORS\n');

    const noKey = await fetch(`${BASE}/api/sessions`, { headers: { 'content-type': 'application/json' } });
    check('a missing api key is 401', noKey.status === 401, `got ${noKey.status}`);

    const noSession = await api('/api/message', { method: 'POST', body: JSON.stringify({ message: { text: 'hi' } }) });
    const noSessionBody = await noSession.json();
    check('a missing sessionId is 400 with a reason',
        noSession.status === 400 && typeof noSessionBody.error === 'string', JSON.stringify(noSessionBody));

    const missing = await api('/api/sessions/does-not-exist-at-all');
    check('an unknown session is 404', missing.status === 404, `got ${missing.status}`);

    const missingReport = await api('/api/sessions/does-not-exist-at-all/report');
    check('a report for an unknown session is 404', missingReport.status === 404, `got ${missingReport.status}`);

    const badJson = await fetch(`${BASE}/api/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: '{ this is not json',
    });
    check('malformed JSON is a 4xx, not a crash', badJson.status >= 400 && badJson.status < 500,
        `got ${badJson.status}`);

    const badPartial = await api('/api/partial', { method: 'POST', body: JSON.stringify({ sessionId: 'x' }) });
    check('a partial with no text is 400', badPartial.status === 400, `got ${badPartial.status}`);

    const badContact = await api('/api/trusted-contacts', { method: 'POST', body: JSON.stringify({ userId: 'demo-user' }) });
    check('a trusted contact with no identifier is 400', badContact.status === 400, `got ${badContact.status}`);

    const stillUp = await fetch(`${BASE}/health`);
    check('the server is still healthy after all of that', stillUp.status === 200, `got ${stillUp.status}`);

    // --- trusted contacts were seeded -------------------------------------
    console.log('\n  SEEDED DATA\n');

    const contacts = await (await api('/api/trusted-contacts?userId=demo-user')).json();
    check('trusted contacts were seeded', contacts.count >= 4, `${contacts.count} contact(s)`);
    check('the son is among them',
        contacts.contacts.some((c) => c.identifier === '+919876500001'),
        contacts.contacts.map((c) => c.identifier).join(', '));

    const sessions = await (await api('/api/sessions')).json();
    const seeded = sessions.sessions.filter((s) => s.sessionId.startsWith('seed-'));
    check('five past sessions were seeded', seeded.length === 5, `${seeded.length} seeded session(s)`);

    const scenarios = await (await api('/api/scenarios')).json();
    check('six scenario openers are served', scenarios.scenarios.length === 6,
        `${scenarios.scenarios.length}`);
    check('two of them are legitimate',
        scenarios.scenarios.filter((s) => s.kind === 'legitimate').length === 2);

    // --- clean up the replay's own sessions -------------------------------
    for (const id of [s1, s2, s7, s7b]) {
        await api(`/api/sessions/${id}/reset`, { method: 'POST' });
    }

    console.log(`\n  ${checks - failures}/${checks} checks passed`
        + `${failures > 0 ? `, ${failures} FAILED` : ''}\n`);

    process.exit(failures > 0 ? 1 : 0);
};

main().catch((error) => {
    console.error(`\n  REPLAY CRASHED: ${error.stack || error.message}\n`);
    process.exit(1);
});
