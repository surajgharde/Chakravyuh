const test = require('node:test');
const assert = require('node:assert/strict');

const intelligence = require('../src/services/intelligence');

const extract = (text) => intelligence.extract(text);

test('extracts a UPI id', () => {
    assert.deepEqual(extract('Send it to refund@okaxis please.').upiIds, ['refund@okaxis']);
});

test('extracts an email address', () => {
    assert.deepEqual(extract('Write to support@fake-sbi.com now.').emailAddresses, ['support@fake-sbi.com']);
});

test('extracts an Indian mobile number with and without a country code', () => {
    assert.deepEqual(extract('Call 9876543210.').phoneNumbers, ['9876543210']);
    assert.deepEqual(extract('Call +91-9876543210.').phoneNumbers, ['+91-9876543210']);
});

test('extracts a URL', () => {
    assert.equal(
        extract('Verify at http://sbi-verify.co.in/kyc now.').phishingLinks[0],
        'http://sbi-verify.co.in/kyc'
    );
});

test('extracts a bank account number', () => {
    assert.deepEqual(extract('Transfer to account 50100234567890.').bankAccounts, ['50100234567890']);
});

test('a mobile number is not also recorded as a bank account', () => {
    assert.deepEqual(extract('My number is 9876543210.').bankAccounts, []);
});

test('suspicious keywords are collected', () => {
    const keywords = extract('URGENT: your KYC is expired, share the OTP.').suspiciousKeywords;
    assert.ok(keywords.some((k) => /urgent/i.test(k)));
    assert.ok(keywords.some((k) => /otp/i.test(k)));
});

test('classifies the scam family from the text', () => {
    assert.equal(extract('Your SBI account is blocked.').scamType, 'bank_fraud');
    assert.equal(extract('Send it on PhonePe UPI.').scamType, 'upi_fraud');
    assert.equal(extract('This is CBI, there is a warrant.').scamType, 'digital_arrest');
});

test('empty and malformed input is handled without throwing', () => {
    for (const value of [null, undefined, '', '   ', 42, {}, []]) {
        const result = extract(value);
        assert.equal(typeof result, 'object');
        assert.ok(Array.isArray(result.upiIds));
    }
});

test('merging into a session de-duplicates and reports how many are new', () => {
    const session = {
        intelligence: { upiIds: ['mule1@okaxis'], bankAccounts: [], phoneNumbers: [], emailAddresses: [], phishingLinks: [], caseIds: [], suspiciousKeywords: [] },
        markModified() {},
    };

    const first = intelligence.mergeInto(session, extract('Pay to mule1@okaxis'));
    assert.equal(first.identifiers, 0, 'already known');

    const second = intelligence.mergeInto(session, extract('Or use mule2@okicici instead'));
    assert.equal(second.identifiers, 1);
    assert.deepEqual(session.intelligence.upiIds, ['mule1@okaxis', 'mule2@okicici']);
});

test('keywords are counted apart from identifiers', () => {
    const session = {
        intelligence: { upiIds: [], bankAccounts: [], phoneNumbers: [], emailAddresses: [], phishingLinks: [], caseIds: [], suspiciousKeywords: [] },
        markModified() {},
    };

    // One identifier, several keywords. Reporting 6 "identifiers" would overstate it.
    const counts = intelligence.mergeInto(session, extract('URGENT: your account is blocked, send the OTP and pay to mule@okaxis'));
    assert.equal(counts.identifiers, 1);
    assert.ok(counts.keywords > 1);
});

test('a captured identifier carries no surrounding whitespace', () => {
    // The phone pattern's optional country-code group used to swallow the
    // preceding space, so the same number stored twice as two values.
    for (const value of extract('Please call 9876543210 or 9123456780 today.').phoneNumbers) {
        assert.equal(value, value.trim());
    }
});

test('a long TLD is currently missed by the URL pattern', { todo: 'fixed in the extraction phase' }, () => {
    assert.equal(extract('Go to http://sbi-verify.example/kyc').phishingLinks.length, 1);
});

test('hard evidence means an identifier, not a keyword', () => {
    const base = () => ({
        intelligence: { upiIds: [], bankAccounts: [], phoneNumbers: [], emailAddresses: [], phishingLinks: [], caseIds: [], suspiciousKeywords: [] },
        markModified() {},
    });

    const keywordsOnly = base();
    intelligence.mergeInto(keywordsOnly, extract('This is urgent, your KYC is expired.'));
    assert.equal(intelligence.hasHardEvidence(keywordsOnly), false);

    const withIdentifier = base();
    intelligence.mergeInto(withIdentifier, extract('Pay to refund@okaxis.'));
    assert.equal(intelligence.hasHardEvidence(withIdentifier), true);
});

// ---------------------------------------------------------------------------
// Known false positives carried over from the original extractor.
// Marked `todo` so they are visible and counted, and flip to passing when the
// extraction phase replaces these patterns with validated ones.
// ---------------------------------------------------------------------------

test('an email domain is not also captured as a UPI id', { todo: 'fixed in the extraction phase' }, () => {
    assert.deepEqual(extract('Write to support@fake-sbi.com now.').upiIds, []);
});

test('a phone number with a country code is not captured as a bank account', { todo: 'fixed in the extraction phase' }, () => {
    assert.deepEqual(extract('Call 919876543210 now.').bankAccounts, []);
});

test('a 12-digit Aadhaar number is not captured as a bank account', { todo: 'fixed in the extraction phase' }, () => {
    // 234567890124 is a valid Verhoeff-checksummed test Aadhaar.
    assert.deepEqual(extract('My Aadhaar is 234567890124.').bankAccounts, []);
});

test('"UPI ID: 9876543210" is not captured as a case id', { todo: 'fixed in the extraction phase' }, () => {
    assert.deepEqual(extract('UPI ID: 9876543210').caseIds, []);
});
