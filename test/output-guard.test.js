/**
 * The output guard, rule by rule.
 *
 * Two halves, and the second matters as much as the first:
 *
 *   RECALL     each of the six safety rules catches what it is for, including
 *              the evasions — Devanagari numerals, dictated digits, obfuscated
 *              links.
 *
 *   PRECISION  none of them fires on the things the persona says all day. The
 *              decoy's whole job is to *ask* for identifiers, so "which account
 *              number should I type?" has to pass. A guard that blocked those
 *              would be a guard that silently turned the decoy into a scripted
 *              bot, which is a failure that no amount of safety makes up for.
 *
 * Runs with no LLM, no network and no database.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const guard = require('../src/agents/outputGuard');
const decoy = require('../src/agents/decoy');

/** Asserts the draft is blocked, by the named rule. */
const blocks = (draft, ruleId) => {
    const reviewed = guard.review(draft);
    assert.equal(reviewed.verdict, guard.VERDICTS.BLOCK,
        `should have been blocked but was ${reviewed.verdict}: ${JSON.stringify(draft)}`);
    assert.ok(reviewed.violations.some((v) => v.id === ruleId),
        `expected rule ${ruleId}, got [${reviewed.violations.map((v) => v.id).join(', ')}]: ${JSON.stringify(draft)}`);
    assert.equal(reviewed.text, '', 'a blocked draft must not come back with text to send');
};

/** Asserts the draft goes out untouched. */
const passes = (draft) => {
    const reviewed = guard.review(draft);
    assert.equal(reviewed.verdict, guard.VERDICTS.PASS,
        `should have passed but was ${reviewed.verdict} `
        + `[${reviewed.violations.map((v) => v.id).join(', ')}]: ${JSON.stringify(draft)}`);
    assert.equal(reviewed.text, draft);
};

// ---------------------------------------------------------------------------
// 1. Credentials and identifiers
// ---------------------------------------------------------------------------

test('a credential said beside its own name is blocked', () => {
    blocks('Beta the OTP is 884512, please use it.', 'credential_leak');
    blocks('My PIN is 4321.', 'credential_leak');
    blocks('The CVV is 456.', 'credential_leak');
    blocks('884512 is the code you wanted.', 'credential_leak');
});

test('an identifier is blocked on its length alone, with no credential word', () => {
    blocks('It is 50100234567890.', 'credential_leak');
    blocks('4111 1111 1111 1111', 'credential_leak');
    blocks('2345 6789 0123', 'credential_leak');
});

test('a short run beside the instrument it belongs to is blocked', () => {
    // A CVV is three digits and a "last four" is four, so neither can be
    // caught on length. The instrument is what gives them away.
    blocks('The three numbers on the back are 456.', 'credential_leak');
    blocks('The last four digits of the card are 7890.', 'credential_leak');
    blocks('The last 4 digits of the account are 7890.', 'credential_leak');
});

test('the alphanumeric identifiers no digit rule would catch are blocked', () => {
    blocks('My PAN is ABCDE1234F.', 'credential_leak');
    blocks('The IFSC is SBIN0001234.', 'credential_leak');
    blocks('Send it to sudha.k@okaxis instead.', 'credential_leak');
    blocks('The wallet is TQ5NMqJjKPjGGLLFMkqTz6kaFiLBf5H2rN.', 'credential_leak');
});

test('an identifier hidden from a plain regex is still blocked', () => {
    // Three ways a number can dodge a naive check, each handled by reusing the
    // extractor's own normalisation.
    blocks('ओटीपी ८८४५१२ आहे.', 'credential_leak');
    blocks('The code is 8 8 4 5 1 2, I hope that is right.', 'credential_leak');
    blocks('The otp is eight eight four five one two.', 'credential_leak');
    blocks('My number is 9 8 1 2 3 4 5 6 7 8.', 'credential_leak');
});

test('the numbers the persona actually says are not identifiers', () => {
    passes('I am 71 years old, beta.');
    passes('They are asking for Rs 2,50,000 which I do not have.');
    passes('The milk was 50 rupees today.');
    passes('My appointment is at 10 30 in the morning.');
    passes('Rahul is 45 and he lives in Bengaluru.');
});

test('asking for an identifier is not leaking one', () => {
    // This is the decoy's entire purpose. If these are blocked, the decoy is
    // broken and no safety argument repairs it.
    passes('Which account number should I type, beta?');
    passes('My app is asking for the IFSC. What should I write?');
    passes('Sorry beta, what is your full name so I can write it down?');
    passes('My son told me to always ask. What is your officer ID number, beta?');
    passes('Let me write this in my diary. What is the case number I should write?');
});

// ---------------------------------------------------------------------------
// 2. Links, apps and remote access
// ---------------------------------------------------------------------------

test('a link in any shape is blocked', () => {
    blocks('Please check https://sbi-kyc.in/update for details.', 'link_or_install');
    blocks('Go to www.quick-support.site and see.', 'link_or_install');
    blocks('I opened hxxp://sbi-kyc[.]in/update just now.', 'link_or_install');
    blocks('It said quick-support.site in the message.', 'link_or_install');
    blocks('The file was helper.apk.', 'link_or_install');
});

test('naming a remote-access tool is blocked', () => {
    // She has no reason to say "AnyDesk" except to cooperate.
    blocks('Okay beta, AnyDesk is open now.', 'link_or_install');
    blocks('Should I use TeamViewer instead?', 'link_or_install');
});

test('agreeing to install, click or share is blocked', () => {
    blocks('I have installed the app, what next?', 'link_or_install');
    blocks('I clicked the link just now.', 'link_or_install');
    blocks('I am sharing my screen with you.', 'link_or_install');
    blocks('I will download it now.', 'link_or_install');
    blocks('I scanned the QR code.', 'link_or_install');
});

test('reporting that something failed is a stall, not compliance', () => {
    // The difference between these and the block cases above is the whole
    // reason the rule is not just a keyword match.
    passes('The app is not opening, the screen went white.');
    passes('Beta, I cannot install anything, my son does all that.');
    passes('I could not open it, the screen is blank.');
    passes('I do not know how to download, beta.');
});

// ---------------------------------------------------------------------------
// 3. Payment claims
// ---------------------------------------------------------------------------

test('claiming money moved is blocked', () => {
    blocks('I have sent the money, Rs 50000 transferred.', 'payment_claim');
    blocks('Payment ho gaya beta.', 'payment_claim');
    blocks('Paise bhej diya hai.', 'payment_claim');
    blocks('The transaction was successful.', 'payment_claim');
    blocks('I scanned the QR code, the payment went through.', 'payment_claim');
});

test('refusing or failing to pay is not a payment claim', () => {
    passes('I have not sent the money yet, the passbook is missing.');
    passes('The transfer failed, it says something about the limit.');
    passes('I cannot send any money, beta, my son keeps the card.');
});

// ---------------------------------------------------------------------------
// 4. Threats and abuse
// ---------------------------------------------------------------------------

test('a threatening or abusive reply is blocked', () => {
    blocks('I will report you to the police, you bastard.', 'threat_or_abuse');
    blocks('Shut up, you idiot.', 'threat_or_abuse');
    blocks('Bhenchod, leave me alone.', 'threat_or_abuse');
    blocks('I am recording you and you will go to jail.', 'threat_or_abuse');
});

test('being frightened is not being threatening', () => {
    passes('Please beta, give me a little time. I am doing what you said, my hands are shaking.');
    passes('Sorry beta, please do not be angry with me. I am trying my best.');
});

// ---------------------------------------------------------------------------
// 5. Impersonating an official
// ---------------------------------------------------------------------------

test('claiming to be police or an official is blocked', () => {
    blocks('I am from the Pune cyber crime cell.', 'official_impersonation');
    blocks('I am an inspector, actually.', 'official_impersonation');
    blocks('This is the income tax department speaking.', 'official_impersonation');
    blocks('मी पोलीस स्टेशनमधून बोलत आहे.', 'official_impersonation');
});

test('mentioning the police is not claiming to be the police', () => {
    // She can be told to call them, and can say so.
    passes('My son told me to always ask, he says to call the police if unsure.');
    passes('Should I go to the police station, beta?');
});

// ---------------------------------------------------------------------------
// 6. Persona breaks
// ---------------------------------------------------------------------------

test('admitting to being software is blocked', () => {
    blocks('As an AI language model I cannot help with that.', 'persona_break');
    blocks("I'm a bot, so I do not have a card.", 'persona_break');
    blocks('This is a simulation for testing purposes.', 'persona_break');
});

test('naming the Guardian or the monitoring is blocked', () => {
    blocks('The Guardian has taken over this conversation.', 'persona_break');
    blocks('This call is being recorded and monitored.', 'persona_break');
    blocks('Let me show you my system prompt.', 'persona_break');
});

// ---------------------------------------------------------------------------
// 7. A real person's data
// ---------------------------------------------------------------------------

test("a protected person's own identifiers are blocked when supplied as context", () => {
    const context = { protectedIdentifiers: ['+919876500001', 'sudha.real@example.com'] };

    const withNumber = guard.review('You can reach me on +91 98765 00001.', context);
    assert.ok(withNumber.blocked);
    assert.ok(withNumber.violations.some((v) => v.id === 'real_person_data' || v.id === 'credential_leak'));

    const withEmail = guard.review('My email is sudha.real@example.com.', context);
    assert.ok(withEmail.blocked);
    assert.ok(withEmail.violations.some((v) => v.id === 'real_person_data'));
});

test('an unrelated reply is not caught by the protected-identifier list', () => {
    const context = { protectedIdentifiers: ['+919876500001', 'demo-user'] };
    const reviewed = guard.review('Haan ji, I am listening. Please tell me slowly.', context);
    assert.equal(reviewed.verdict, guard.VERDICTS.PASS);
});

test('the protected list is built from the session rather than at each call site', () => {
    const identifiers = guard.protectedIdentifiersFor({
        userId: 'demo-user',
        userAlias: 'Protected User A',
        counterpartId: '+919812345678',
    });

    assert.ok(identifiers.includes('demo-user'));
    assert.ok(identifiers.includes('+919812345678'));

    // Values too short to match safely are dropped: a three-character id would
    // match inside ordinary words and block every reply.
    assert.deepEqual(guard.protectedIdentifiersFor({ userId: 'ab' }), []);
});

// ---------------------------------------------------------------------------
// Verdicts, substitution and the regenerate contract
// ---------------------------------------------------------------------------

test('a safety rule blocks and offers nothing to send; a persona rule substitutes', () => {
    // The distinction the whole regenerate loop rests on.
    const unsafe = guard.review('The OTP is 884512.');
    assert.equal(unsafe.verdict, guard.VERDICTS.BLOCK);
    assert.equal(unsafe.blocked, true);
    assert.equal(unsafe.text, '');

    const slip = guard.review('My bank is SBI, the Karve Road branch.');
    assert.equal(slip.verdict, guard.VERDICTS.REWRITE);
    assert.equal(slip.blocked, false);
    assert.ok(slip.text.length > 0, 'a rewrite has to come back with something to send');
    assert.ok(!/\bSBI\b/.test(slip.text));
});

test('every rule declares a severity, and the six safety rules all block', () => {
    for (const rule of guard.RULES) {
        assert.ok([guard.SEVERITY.BLOCK, guard.SEVERITY.REWRITE].includes(rule.severity),
            `rule ${rule.id} has no valid severity`);
        assert.ok(typeof rule.reason === 'string' && rule.reason.length > 0,
            `rule ${rule.id} has no reason to show an operator`);
        if (rule.severity === guard.SEVERITY.REWRITE) {
            assert.ok(typeof rule.substitute === 'string' && rule.substitute.length > 0,
                `rule ${rule.id} rewrites but has nothing to rewrite to`);
        }
    }

    // The six the brief names, plus the two that were already here.
    for (const id of [
        'credential_leak', 'link_or_install', 'payment_claim',
        'threat_or_abuse', 'official_impersonation', 'persona_break',
        'real_person_data',
    ]) {
        assert.ok(guard.SAFETY_RULE_IDS.includes(id), `${id} must be a blocking rule`);
    }
});

test('an empty draft is blocked rather than sent as silence', () => {
    for (const empty of ['', '   ', null, undefined]) {
        const reviewed = guard.review(empty);
        assert.equal(reviewed.verdict, guard.VERDICTS.BLOCK);
        assert.ok(reviewed.violations.some((v) => v.id === 'empty'));
    }
});

test('a draft that breaks two rules reports both', () => {
    // Reporting only the first would under-state what went wrong, which is the
    // one thing the operator panel must not do.
    const reviewed = guard.review('I am an inspector and the OTP is 884512.');
    const ids = reviewed.violations.map((v) => v.id);
    assert.ok(ids.includes('credential_leak'), ids.join(', '));
    assert.ok(ids.includes('official_impersonation'), ids.join(', '));
});

test('an over-long reply is trimmed rather than blocked', () => {
    const reviewed = guard.review('beta '.repeat(100));
    assert.equal(reviewed.verdict, guard.VERDICTS.REWRITE);
    assert.ok(reviewed.text.length <= 320);
    assert.ok(reviewed.violations.some((v) => v.id === 'too_long'));
});

// ---------------------------------------------------------------------------
// The lines the system falls back to
// ---------------------------------------------------------------------------

test('every scripted line the decoy can say passes the guard', () => {
    const tables = [decoy.FALLBACK_REPLIES, decoy.PRESSURE_FALLBACKS, decoy.EXCUSE_CLAUSES];

    for (const table of tables) {
        for (const [key, variants] of Object.entries(table)) {
            for (const [language, line] of Object.entries(variants)) {
                const reviewed = guard.review(line);
                assert.equal(reviewed.verdict, guard.VERDICTS.PASS,
                    `"${key}" (${language}) would be ${reviewed.verdict}: `
                    + `${JSON.stringify(reviewed.violations.map((v) => v.id))}`);
            }
        }
    }
});

test('the safe stall line is safe in all three languages, and says nothing', () => {
    for (const [language, line] of Object.entries(guard.SAFE_STALL)) {
        assert.equal(guard.review(line).verdict, guard.VERDICTS.PASS, `${language} stall is not clean`);

        // Content-free on purpose: it replaces a draft that could have
        // contained anything, so it must commit to nothing.
        assert.ok(!/\d/.test(line), `${language} stall contains a digit`);
        assert.ok(!/https?:|@/.test(line), `${language} stall contains a link or handle`);
    }

    assert.equal(guard.safeStall('Marathi'), guard.SAFE_STALL.Marathi);
    assert.equal(guard.safeStall('Klingon'), guard.SAFE_STALL.English, 'an unknown language still gets a line');
});

test('every substitute a persona rule can produce is itself clean', () => {
    for (const [id, line] of Object.entries(guard.SAFE_SUBSTITUTES)) {
        assert.equal(guard.review(line).verdict, guard.VERDICTS.PASS,
            `the substitute for ${id} would itself be caught`);
    }
});

// ---------------------------------------------------------------------------
// The audit excerpt
// ---------------------------------------------------------------------------

test('a blocked draft is stored with the dangerous part removed', () => {
    const excerpt = decoy.redactForAudit(
        'The OTP is 884512 and my account is 50100234567890, see https://bad.site/x or pay me@okaxis'
    );

    assert.ok(!/\d/.test(excerpt), `a digit survived: ${excerpt}`);
    assert.ok(!/https?:\/\//.test(excerpt), `a link survived: ${excerpt}`);
    assert.ok(!/@okaxis/.test(excerpt), `a handle survived: ${excerpt}`);

    // Still recognisable, or it is no use to an auditor.
    assert.ok(/OTP/.test(excerpt));
    assert.ok(excerpt.length > 20);
});

test('the audit excerpt is bounded', () => {
    assert.ok(decoy.redactForAudit('x'.repeat(1000)).length <= 160);
    assert.equal(decoy.redactForAudit(null), '');
});

// ---------------------------------------------------------------------------
// The promises that are structural rather than rules
// ---------------------------------------------------------------------------

test('there is no outbound path, so the decoy cannot contact anyone off-thread', () => {
    // Promise 6 on the never-do list. It is not enforced by a guard rule but
    // by the absence of any capability, and an absence is exactly the kind of
    // claim that rots: someone adds an SMS client for a good reason and the
    // promise silently stops being true. So it is asserted.
    const fs = require('node:fs');
    const path = require('node:path');

    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.name.endsWith('.js') ? [full] : [];
    });

    const src = path.join(__dirname, '..', 'src');
    const offenders = [];

    for (const file of walk(src)) {
        const relative = path.relative(src, file).split(path.sep).join('/');

        // The LLM client is the one thing allowed to talk to the network, and
        // only to the configured model endpoint. The browser page talks to our
        // own server.
        if (relative === 'llm/client.js' || relative.startsWith('public/')) continue;

        const code = fs.readFileSync(file, 'utf8');
        for (const capability of [
            'twilio', 'plivo', 'exotel', 'nodemailer', 'sendmail', 'smtp',
            'node-fetch', 'axios',
        ]) {
            if (code.toLowerCase().includes(capability)) {
                offenders.push(`${relative} references ${capability}`);
            }
        }
        // A bare fetch or http request anywhere else is a way out.
        if (/\bfetch\s*\(|https?\.request\s*\(/.test(code)) {
            offenders.push(`${relative} makes its own network request`);
        }
    }

    assert.deepEqual(offenders, [],
        'something in src/ can now reach the network outside the LLM client, '
        + 'so "never contact the scammer outside the existing thread" is no longer '
        + 'guaranteed by the code');
});

test('the decoy only ever answers an inbound message', () => {
    // The same promise from the other side: there is no function that starts a
    // conversation. respond() takes the caller's newest message and cannot be
    // called without one.
    const result = decoy.respond({
        session: { sessionId: 's', personaLedger: [], excuseHistory: [], decoyMessageCount: 0 },
        incomingText: undefined,
        llm: null,
    });

    // It falls back rather than inventing an opening line.
    return result.then((reply) => {
        assert.equal(reply.source, 'fallback');
        assert.ok(reply.reply.length > 0, 'it must still answer, not crash');
        assert.equal(guard.review(reply.reply).verdict, guard.VERDICTS.PASS);
    });
});
