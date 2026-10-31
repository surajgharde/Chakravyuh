const test = require('node:test');
const assert = require('node:assert/strict');

const extractor = require('../src/services/extractor');

const CTX = {
    sessionId: 'sess-1',
    messageId: 'm3',
    timestamp: new Date('2026-10-31T09:15:00.000Z'),
};

const get = (text, type) => extractor.extractEntities(text, CTX).filter((e) => e.type === type);
const norms = (text, type) => get(text, type).map((e) => e.normalized);
const types = (text) => extractor.extractEntities(text, CTX).map((e) => e.type);

// ---------------------------------------------------------------------------
// The record contract
// ---------------------------------------------------------------------------

test('every entity carries type, raw, normalized, provenance and its sentence', () => {
    const text = 'Good morning. Transfer to a/c 50100234567890 today.';
    const [entity] = get(text, 'bankAccount');

    assert.equal(entity.type, 'bankAccount');
    assert.equal(entity.raw, '50100234567890');
    assert.equal(entity.normalized, '50100234567890');
    assert.equal(entity.sessionId, 'sess-1');
    assert.equal(entity.messageId, 'm3');
    assert.equal(entity.timestamp, CTX.timestamp);
    assert.equal(entity.sentence, 'Transfer to a/c 50100234567890 today.', 'the sentence, not the whole message');
    assert.equal(entity.method, 'rules');
});

test('the sentence quoted is the one the entity appeared in', () => {
    const text = 'I am from the bank. Pay to refund@okaxis now. Do not tell anyone.';
    assert.equal(get(text, 'upiId')[0].sentence, 'Pay to refund@okaxis now.');
});

test('a Devanagari danda ends a sentence', () => {
    const sentences = extractor.splitSentences('मी पोलीस आहे। पैसे पाठवा।');
    assert.equal(sentences.length, 2);
    assert.equal(sentences[0], 'मी पोलीस आहे।');
});

test('malformed input is handled without throwing', () => {
    for (const value of [null, undefined, '', '   ', 42, {}, []]) {
        assert.ok(Array.isArray(extractor.extractEntities(value, CTX)));
    }
});

test('entities are de-duplicated within a message', () => {
    assert.equal(norms('Pay refund@okaxis, I repeat refund@okaxis.', 'upiId').length, 1);
});

// ---------------------------------------------------------------------------
// The four bugs named in the brief
// ---------------------------------------------------------------------------

test('BUG: "support@fake-sbi.com" is not also a UPI id', () => {
    const text = 'Write to support@fake-sbi.com now.';
    assert.deepEqual(norms(text, 'upiId'), [], 'the PSP must not be read as "fake"');
    assert.deepEqual(norms(text, 'email'), ['support@fake-sbi.com']);
});

test('BUG: an email is not also reported as a phishing link', () => {
    assert.deepEqual(norms('Write to support@fake-sbi.com now.', 'url'), []);
});

test('BUG: a brand inside an email address is not an authority claim', () => {
    assert.deepEqual(norms('Write to support@fake-sbi.com now.', 'impersonatedAuthority'), []);
});

test('BUG: "919876543210" is a phone, not a bank account', () => {
    const text = 'Call 919876543210 now.';
    assert.deepEqual(norms(text, 'bankAccount'), []);
    assert.deepEqual(norms(text, 'phone'), ['+919876543210']);
});

test('BUG: a 12-digit Aadhaar is not a bank account', () => {
    for (const text of ['My Aadhaar is 234567890124.', 'My Aadhaar is 2345 6789 0124.', 'आधार क्रमांक 234567890124']) {
        assert.deepEqual(norms(text, 'bankAccount'), [], text);
        assert.deepEqual(norms(text, 'aadhaar'), ['234567890124'], text);
    }
});

test('BUG: an Aadhaar is not also reported as a phone number', () => {
    assert.deepEqual(norms('My Aadhaar is 234567890124.', 'phone'), []);
});

test('BUG: "UPI ID: 9876543210" is not a case reference', () => {
    const text = 'UPI ID: 9876543210';
    assert.deepEqual(norms(text, 'caseRef'), [], 'the bare word "ID" must not create a case number');
    assert.deepEqual(norms(text, 'phone'), ['+919876543210']);
    assert.equal(get(text, 'phone')[0].meta.offeredAsUpiHandle, true, 'worth recording why it was given');
});

test('BUG: a long TLD is no longer missed', () => {
    assert.deepEqual(norms('Go to http://sbi-verify.example/kyc', 'url'), ['http://sbi-verify.example/kyc']);
});

test('BUG: a captured value carries no surrounding whitespace', () => {
    for (const entity of extractor.extractEntities('Please call 9876543210 or 9123456780 today.', CTX)) {
        assert.equal(entity.raw, entity.raw.trim());
    }
});

// ---------------------------------------------------------------------------
// phone
// ---------------------------------------------------------------------------

test('Indian mobiles normalise to +91XXXXXXXXXX from any written form', () => {
    const forms = {
        '9876543210': '+919876543210',
        '+91 98765 43210': '+919876543210',
        '+919876543210': '+919876543210',
        '91-9876543210': '+919876543210',
        '0919876543210': '+919876543210',
        '098765 43210': '+919876543210',
        '98765-43210': '+919876543210',
        '+91.9876543210': '+919876543210',
        '0091 9876543210': '+919876543210',
    };

    for (const [written, expected] of Object.entries(forms)) {
        assert.deepEqual(norms(`Call me on ${written} please.`, 'phone'), [expected], written);
    }
});

test('a number that cannot be an Indian mobile is not reported as one', () => {
    // Indian mobiles start 6-9; 1234567890 does not.
    assert.deepEqual(norms('Reference 1234567890 noted.', 'phone'), []);
});

test('a toll-free number is kept, and marked as such', () => {
    const [entity] = get('Call our toll free 1800 123 4567 for help.', 'phone');
    assert.equal(entity.normalized, '18001234567');
    assert.equal(entity.meta.kind, 'toll_free');
});

test('a toll-free number does not also yield a phantom mobile', () => {
    // "1800 123 4567" collapses to 18001234567, which contains 8001234567.
    assert.deepEqual(norms('Call toll free 1800 123 4567.', 'phone'), ['18001234567']);
});

test('a landline with an STD code is kept, and marked as such', () => {
    const [entity] = get('Our office line is 020-27654321.', 'phone');
    assert.equal(entity.normalized, '+912027654321');
    assert.equal(entity.meta.kind, 'landline');
});

// ---------------------------------------------------------------------------
// bankAccount and ifsc
// ---------------------------------------------------------------------------

test('digits become a bank account only with a nearby account word', () => {
    for (const word of ['a/c', 'account', 'beneficiary', 'IFSC', 'khata', 'NEFT']) {
        assert.deepEqual(
            norms(`Send to ${word} 50100234567890 today.`, 'bankAccount'),
            ['50100234567890'],
            word
        );
    }
});

test('खाते and खात्यात qualify a bank account in Marathi', () => {
    assert.deepEqual(norms('या खात्यात 50100234567890 जमा करा.', 'bankAccount'), ['50100234567890']);
    assert.deepEqual(norms('खाते क्रमांक 50100234567890', 'bankAccount'), ['50100234567890']);
});

test('खाता qualifies a bank account in Hindi', () => {
    assert.deepEqual(norms('इस खाता नंबर 50100234567890 में भेजो', 'bankAccount'), ['50100234567890']);
});

test('a bare digit run with no account context is not an account', () => {
    assert.deepEqual(norms('The order total was 50100234567890 units.', 'bankAccount'), []);
});

test('an amount near an account word is not read as the account number', () => {
    const text = 'Deposit Rs 50000 into a/c 50100234567890.';
    assert.deepEqual(norms(text, 'bankAccount'), ['50100234567890']);
    assert.deepEqual(norms(text, 'amount'), [50000]);
});

test('an OTP value is never read as an account number', () => {
    assert.deepEqual(norms('Your account OTP is 849321, share it.', 'bankAccount'), []);
});

test('a date is never read as an account number', () => {
    assert.deepEqual(norms('Your account statement of 12/04/2026 is ready.', 'bankAccount'), []);
});

test('a PAN is recognised and never read as an account', () => {
    const text = 'Your PAN ABCDE1234F is linked to this account.';
    assert.deepEqual(norms(text, 'pan'), ['ABCDE1234F']);
    assert.deepEqual(norms(text, 'bankAccount'), []);
});

test('IFSC codes are matched on their exact shape', () => {
    assert.deepEqual(norms('IFSC SBIN0001234 branch Pune.', 'ifsc'), ['SBIN0001234']);
    assert.deepEqual(norms('Code SBIN1001234 is wrong.', 'ifsc'), [], 'the fifth character must be 0');
});

// ---------------------------------------------------------------------------
// upiId
// ---------------------------------------------------------------------------

test('UPI handles are captured, and known PSPs flagged', () => {
    for (const handle of ['refund@okaxis', 'mule.account@ybl', 'help-desk@paytm', 'x_y@oksbi', 'abc@upi', 'test@ibl']) {
        const [entity] = get(`Pay to ${handle} now.`, 'upiId');
        assert.equal(entity.normalized, handle.toLowerCase(), handle);
        assert.equal(entity.meta.knownPsp, true, handle);
    }
});

test('an unknown PSP is still captured, but flagged as unknown', () => {
    const [entity] = get('Pay to victim@notarealpsp now.', 'upiId');
    assert.equal(entity.normalized, 'victim@notarealpsp');
    assert.equal(entity.meta.knownPsp, false);
});

test('anything with a dot after the @ is an email, never a UPI id', () => {
    for (const address of ['a@b.com', 'fraud@gmail.com', 'x@sbi.co.in', 'noreply@fake-bank.org']) {
        assert.deepEqual(norms(`Mail ${address} please.`, 'upiId'), [], address);
        assert.deepEqual(norms(`Mail ${address} please.`, 'email'), [address], address);
    }
});

// ---------------------------------------------------------------------------
// url, apkLink
// ---------------------------------------------------------------------------

test('plain and scheme-less URLs are captured', () => {
    assert.deepEqual(norms('Open https://sbi-kyc.in/verify now', 'url'), ['https://sbi-kyc.in/verify']);
    assert.deepEqual(norms('Open sbi-kyc.in/verify now', 'url'), ['http://sbi-kyc.in/verify']);
    assert.deepEqual(norms('Open www.sbi-kyc.in now', 'url'), ['http://www.sbi-kyc.in']);
});

test('a short link is captured and flagged', () => {
    const [entity] = get('Tap bit.ly/3xKyc to continue', 'url');
    assert.equal(entity.normalized, 'http://bit.ly/3xkyc');
    assert.equal(entity.meta.shortener, true);
});

test('hxxp obfuscation is normalised back to a usable URL', () => {
    const [entity] = get('Open hxxp://sbi-verify.co.in/kyc', 'url');
    assert.equal(entity.normalized, 'http://sbi-verify.co.in/kyc');
    assert.equal(entity.meta.obfuscated, true);
});

test('bracketed and spaced dots are normalised', () => {
    assert.deepEqual(norms('Visit sbi-verify[.]co[.]in/kyc', 'url'), ['http://sbi-verify.co.in/kyc']);
    assert.deepEqual(norms('Visit sbi-verify(dot)co(dot)in', 'url'), ['http://sbi-verify.co.in']);
    assert.deepEqual(norms('Visit sbi-verify dot co dot in', 'url'), ['http://sbi-verify.co.in']);
});

test('the raw value keeps the obfuscation exactly as written', () => {
    assert.equal(get('Visit sbi-verify[.]co[.]in/kyc', 'url')[0].raw, 'sbi-verify[.]co[.]in/kyc');
});

test('an apk link is its own type, not a plain URL', () => {
    assert.deepEqual(norms('Install http://evil.site/sbi-secure.apk', 'apkLink'), ['http://evil.site/sbi-secure.apk']);
    assert.deepEqual(norms('Install http://evil.site/sbi-secure.apk', 'url'), []);
});

test('ordinary prose does not produce a URL', () => {
    for (const text of ['Please pay Rs. 5000 today.', 'I will do it. Thank you.', 'Call me at 5 pm.']) {
        assert.deepEqual(norms(text, 'url'), [], text);
    }
});

// ---------------------------------------------------------------------------
// cryptoWallet
// ---------------------------------------------------------------------------

test('BTC, ETH and TRON addresses are captured with their chain', () => {
    const wallets = {
        '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa': 'BTC',
        'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq': 'BTC',
        '0x742d35Cc6634C0532925a3b844Bc454e4438f44e': 'ETH',
        'TQ5NMqJjKPjGGLLFMkqTz6kaFiLBf5H2rN': 'TRON',
    };

    for (const [address, chain] of Object.entries(wallets)) {
        const [entity] = get(`Send it to ${address} now.`, 'cryptoWallet');
        assert.ok(entity, address);
        assert.equal(entity.normalized, address);
        assert.equal(entity.meta.chain, chain);
    }
});

// ---------------------------------------------------------------------------
// amount
// ---------------------------------------------------------------------------

test('amounts convert to whole rupees', () => {
    const cases = {
        'Pay ₹50,000 now': 50000,
        'Pay Rs. 50000 now': 50000,
        'Pay Rs 2 lakh now': 200000,
        'Pay 2 lakh now': 200000,
        'Pay 1.5 crore now': 15000000,
        'Pay 50000 rupees now': 50000,
        'Pay INR 9,999 now': 9999,
        'दो लाख भेजो': 200000,
        '50 हजार जमा करा': 50000,
        'पाच लाख पाठवा': 500000,
    };

    for (const [text, expected] of Object.entries(cases)) {
        assert.deepEqual(norms(text, 'amount'), [expected], text);
    }
});

test('an amount is stored as a number, not a string', () => {
    assert.equal(typeof get('Pay ₹50,000 now', 'amount')[0].normalized, 'number');
});

test('the raw amount keeps what was written', () => {
    assert.equal(get('Pay ₹50,000 now', 'amount')[0].raw, '₹50,000');
});

// ---------------------------------------------------------------------------
// impersonatedAuthority
// ---------------------------------------------------------------------------

test('claimed authorities are normalised to a canonical label', () => {
    const cases = {
        'This is CBI headquarters.': 'CBI',
        'I am from the Enforcement Directorate.': 'ED',
        'Mumbai police speaking.': 'police',
        'This is the cyber crime cell.': 'cyber cell',
        'Your parcel is held at customs.': 'customs',
        'Calling from TRAI.': 'TRAI',
        'RBI has flagged your account.': 'RBI',
        'Income tax department here.': 'income tax',
        'This is FedEx courier service.': 'courier',
        'I am calling from SBI bank.': 'bank',
        'This is the electricity board.': 'electricity board',
        'Calling from Jio.': 'telecom',
    };

    for (const [text, label] of Object.entries(cases)) {
        assert.ok(norms(text, 'impersonatedAuthority').includes(label), `${text} -> ${label}`);
    }
});

test('authorities are recognised in Devanagari', () => {
    assert.ok(norms('मी पोलीस स्टेशन मधून बोलत आहे.', 'impersonatedAuthority').includes('police'));
    assert.ok(norms('महावितरण कडून कॉल आहे.', 'impersonatedAuthority').includes('electricity board'));
    assert.ok(norms('सायबर विभाग बोल रहा है.', 'impersonatedAuthority').includes('cyber cell'));
});

// ---------------------------------------------------------------------------
// caseRef
// ---------------------------------------------------------------------------

test('a case reference is captured only behind a qualifying word', () => {
    assert.deepEqual(norms('FIR number DL/2026/00891 is registered.', 'caseRef'), ['DL/2026/00891']);
    assert.deepEqual(norms('Case no CYB-4471 against you.', 'caseRef'), ['CYB-4471']);
    assert.deepEqual(norms('Warrant 99881 has been issued.', 'caseRef'), ['99881']);
    assert.deepEqual(norms('Reference: ABC123 noted.', 'caseRef'), ['ABC123']);
});

test('a bare number with no qualifying word is not a case reference', () => {
    assert.deepEqual(norms('Your number is 4471.', 'caseRef'), []);
    assert.deepEqual(norms('Pay 50000 today.', 'caseRef'), []);
});

// ---------------------------------------------------------------------------
// Numbers written as words or in Devanagari digits
// ---------------------------------------------------------------------------

test('Devanagari digits are read as numbers', () => {
    assert.deepEqual(norms('माझा नंबर ९८७६५४३२१० आहे', 'phone'), ['+919876543210']);
    assert.deepEqual(norms('खात्यात ५०१००२३४५६७८९० जमा करा', 'bankAccount'), ['50100234567890']);
});

test('a number dictated in English words is read, and the raw keeps the words', () => {
    const [entity] = get('Note it down: nine eight seven six five four three two one zero', 'phone');
    assert.equal(entity.normalized, '+919876543210');
    assert.equal(entity.raw, 'nine eight seven six five four three two one zero');
});

test('a number dictated in Hindi or Marathi words is read', () => {
    assert.deepEqual(
        norms('नंबर लिहा: नऊ आठ सात सहा पाच चार तीन दोन एक शून्य', 'phone'),
        ['+919876543210']
    );
    assert.deepEqual(
        norms('नंबर लिखो: नौ आठ सात छह पांच चार तीन दो एक शून्य', 'phone'),
        ['+919876543210']
    );
});

test('a number dictated in romanised Hindi is read', () => {
    assert.deepEqual(
        norms('number likho: nau aath saat chhe paanch char teen do ek zero', 'phone'),
        ['+919876543210']
    );
});

test('ordinary sentences containing digit words are not read as numbers', () => {
    // "do", "one", "char", "sat" are ordinary words, so a short run is ignored.
    for (const text of ['I will do one thing for you.', 'Sat down and did four tasks.', 'Give me two or three days.']) {
        assert.deepEqual(norms(text, 'phone'), [], text);
        assert.deepEqual(norms(text, 'bankAccount'), [], text);
    }
});

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

test('summarize collapses entities into de-duplicated per-type lists', () => {
    const entities = [
        ...extractor.extractEntities('Pay to refund@okaxis from a/c 50100234567890.', CTX),
        ...extractor.extractEntities('Again, refund@okaxis please.', CTX),
    ];

    const summary = extractor.summarize(entities);
    assert.deepEqual(summary.upiIds, ['refund@okaxis']);
    assert.deepEqual(summary.bankAccounts, ['50100234567890']);
});

test('merging into a session appends entities and refreshes the summary', () => {
    const session = {
        entities: [],
        intelligence: extractor.emptySummary(),
        markModified() {},
    };

    const first = extractor.mergeInto(session, extractor.extractEntities('Pay refund@okaxis', CTX));
    assert.equal(first.identifiers, 1);
    assert.deepEqual(session.intelligence.upiIds, ['refund@okaxis']);

    const repeat = extractor.mergeInto(session, extractor.extractEntities('Pay refund@okaxis', CTX));
    assert.equal(repeat.identifiers, 0, 'already known');

    const second = extractor.mergeInto(session, extractor.extractEntities('Or mule@ybl', CTX));
    assert.equal(second.identifiers, 1);
    assert.deepEqual(session.intelligence.upiIds, ['refund@okaxis', 'mule@ybl']);
});

test('hard evidence means a payment route, not an authority claim', () => {
    const base = () => ({ entities: [], intelligence: extractor.emptySummary(), markModified() {} });

    const claimOnly = base();
    extractor.mergeInto(claimOnly, extractor.extractEntities('This is CBI calling.', CTX));
    assert.equal(extractor.hasHardEvidence(claimOnly), false);

    const withRoute = base();
    extractor.mergeInto(withRoute, extractor.extractEntities('Pay to refund@okaxis.', CTX));
    assert.equal(extractor.hasHardEvidence(withRoute), true);
});

test('every entity type has a reporting field', () => {
    for (const type of extractor.TYPES) {
        assert.ok(extractor.SUMMARY_FIELDS[type], `${type} has no summary field`);
    }
});
