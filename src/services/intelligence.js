/**
 * Deterministic identifier extractor.
 *
 * Carried over from the original repo as a starting point. The known false
 * positives are documented below and covered by `todo` tests in
 * test/intelligence.test.js; they are fixed in the extraction phase, not here.
 *
 * KNOWN BUGS (not yet fixed):
 *   - "support@fake-sbi.com" is also captured as the UPI id "support@fake"
 *   - "919876543210" (a phone with country code) is captured as a bank account
 *   - a 12-digit Aadhaar number is captured as a bank account
 *   - "UPI ID: 9876543210" is captured as a case id, because of the bare "ID" prefix
 */

const logger = require('./logger');

const PATTERNS = {
    bankAccount: /\b\d{9,18}\b/g,
    email: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
    upiId: /[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}/g,
    phone: /(?<!\d)(?:\+91|91)?[\-\s]?[6-9]\d{9}\b/g,
    url: /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)/g,
    caseId: /\b(?:CASE|REF|TICKET|COMPLAINT|POLICY|POL|ORDER|ORD|ID)\s*[\-#:]?\s*[A-Z0-9]*\d[A-Z0-9]*\b/gi,
    keywords: /\b(otp|cvv|verif|block|kyc|refund|winner|lottery|expir|urgent|suspend|apk|download|upi|cashback|claim|arrest|warrant|penalty)\w*/gi,
};

const TYPE_PATTERNS = {
    bank_fraud: /\b(sbi|hdfc|icici|axis|bank|account|blocked|debit|credit|card|statement)\b/i,
    upi_fraud: /\b(upi|paytm|gpay|phonepe|cashback|reward|wallet|vpa|scan|collect request)\b/i,
    digital_arrest: /\b(cbi|police|arrest|warrant|customs|narcotics|court|fir)\b/i,
    phishing: /\b(click|link|http|offer|expire|free|lottery|winner|spin)\b/i,
};

const EMPTY = () => ({
    bankAccounts: [],
    upiIds: [],
    emailAddresses: [],
    phoneNumbers: [],
    phishingLinks: [],
    caseIds: [],
    suspiciousKeywords: [],
    scamType: 'unknown',
});

const EVIDENCE_FIELDS = [
    'bankAccounts',
    'upiIds',
    'emailAddresses',
    'phoneNumbers',
    'phishingLinks',
    'caseIds',
];

/**
 * Captured values are trimmed before use. The phone pattern's optional
 * country-code group can swallow the preceding space, which otherwise stored
 * identifiers as " 9876543210" and broke de-duplication.
 */
const matchAll = (text, pattern) => (text.match(pattern) || []).map((m) => m.trim()).filter(Boolean);

const extract = (text) => {
    if (text === null || text === undefined) return EMPTY();

    try {
        const clean = String(text).trim();
        if (clean === '') return EMPTY();

        const emails = matchAll(clean, PATTERNS.email);
        const phoneNumbers = matchAll(clean, PATTERNS.phone);

        // Drop anything that is really a mobile number.
        const bankAccounts = matchAll(clean, PATTERNS.bankAccount)
            .filter((acc) => !/^[6-9]\d{9}$/.test(acc.replace(/\D/g, '')));

        // An email address matches the UPI pattern too; prefer the email reading.
        const upiIds = matchAll(clean, PATTERNS.upiId).filter((u) => !emails.includes(u));

        let scamType = 'unknown';
        for (const [type, pattern] of Object.entries(TYPE_PATTERNS)) {
            if (pattern.test(clean)) {
                scamType = type;
                break;
            }
        }

        return {
            bankAccounts,
            upiIds,
            emailAddresses: emails,
            phoneNumbers,
            phishingLinks: matchAll(clean, PATTERNS.url),
            caseIds: matchAll(clean, PATTERNS.caseId),
            suspiciousKeywords: matchAll(clean, PATTERNS.keywords),
            scamType,
        };
    } catch (error) {
        logger.error(`Extractor failed: ${error.message}`);
        return EMPTY();
    }
};

/**
 * Merges freshly extracted values into a session, de-duplicated.
 *
 * Identifiers and keywords are counted separately: a keyword is a tactic hint,
 * not a piece of evidence, and reporting the two as one number overstates what
 * was actually learned.
 *
 * @returns {{identifiers: number, keywords: number}} how many values were new
 */
const mergeInto = (session, found) => {
    const counts = { identifiers: 0, keywords: 0 };

    for (const field of [...EVIDENCE_FIELDS, 'suspiciousKeywords']) {
        const incoming = found[field] || [];
        if (incoming.length === 0) continue;

        const existing = session.intelligence[field] || [];
        const merged = [...new Set([...existing, ...incoming])];
        const added = merged.length - existing.length;

        if (field === 'suspiciousKeywords') counts.keywords += added;
        else counts.identifiers += added;

        session.intelligence[field] = merged;
    }

    if (counts.identifiers > 0 || counts.keywords > 0) session.markModified('intelligence');
    return counts;
};

/** True when the session holds at least one hard identifier (keywords don't count). */
const hasHardEvidence = (session) =>
    EVIDENCE_FIELDS.some((field) => (session.intelligence[field] || []).length > 0);

module.exports = { extract, mergeInto, hasHardEvidence, EVIDENCE_FIELDS, PATTERNS };
