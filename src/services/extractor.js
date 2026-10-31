/**
 * Entity extraction.
 *
 * Replaces the original repo's intelligenceService.js, which matched bare
 * patterns with no context and so recorded phone numbers as bank accounts,
 * email domains as UPI ids, and the word "ID" as a case reference.
 *
 * Two principles fix that class of bug:
 *
 *   1. CLAIMING. A digit run is examined by the specific detectors first
 *      (phone, Aadhaar, PAN, IFSC, OTP, amount, date, case reference). Each
 *      one that matches claims those characters. A bank account is only ever
 *      read from digits nothing more specific has claimed.
 *
 *   2. CONTEXT. The open-ended types need a nearby word to justify them. Nine
 *      to eighteen digits is a bank account only when "a/c", "account",
 *      "khata", "खाते", "IFSC" or "beneficiary" sits near it.
 *
 * Every entity carries where it came from: the session, the message, the
 * timestamp, and the exact sentence, so a report can be audited line by line.
 */

const {
    LETTER_CLASS,
    bounded,
    boundedWords,
    asciiDigits,
    findDictatedNumbers,
    expandDictatedNumbers,
    joinSpacedDigits,
    parseAmount,
    CURRENCY_MARKER,
    MULTIPLIER_WORDS,
} = require('./digits');

const logger = require('./logger');

const TYPES = [
    'phone',
    'bankAccount',
    'ifsc',
    'upiId',
    'email',
    'url',
    'apkLink',
    'cryptoWallet',
    'amount',
    'impersonatedAuthority',
    'caseRef',
    'aadhaar',
    'pan',
];

// ---------------------------------------------------------------------------
// Context vocabularies. English, Hindi and Marathi, Devanagari and romanised.
// ---------------------------------------------------------------------------

const ACCOUNT_WORDS = [
    'a/c', 'ac', 'acc', 'acct', 'account', 'accountno', 'beneficiary', 'benificiary',
    'ifsc', 'neft', 'imps', 'rtgs', 'transfer', 'deposit', 'credit', 'khata', 'khate',
    'khatyat', 'account number', 'खाता', 'खाते', 'खात्यात', 'खाता नंबर', 'अकाउंट',
    'बँक', 'बैंक', 'लाभार्थी',
];

const AADHAAR_WORDS = ['aadhaar', 'aadhar', 'adhaar', 'adhar', 'uidai', 'आधार'];
const OTP_WORDS = ['otp', 'o.t.p', 'one time password', 'pin', 'cvv', 'passcode', 'ओटीपी', 'पिन'];
const CASE_WORDS = [
    'fir', 'f.i.r', 'case', 'case no', 'case number', 'warrant', 'reference', 'ref',
    'ref no', 'complaint', 'acknowledgement', 'diary', 'एफआईआर', 'केस', 'वॉरंट',
    'वारंट', 'संदर्भ', 'तक्रार', 'गुन्हा',
];

/**
 * Who the sender claims to be. The label is the normalised value; the words are
 * what to look for. Romanised and Devanagari forms sit in the same entry.
 */
const AUTHORITIES = [
    { label: 'CBI', words: ['cbi', 'central bureau of investigation', 'सीबीआई'] },
    { label: 'ED', words: ['enforcement directorate', 'e.d.', 'ईडी', 'प्रवर्तन निदेशालय'] },
    { label: 'police', words: ['police', 'thana', 'thane', 'inspector', 'sub inspector', 'si', 'constable', 'पोलीस', 'पुलिस', 'थाना', 'ठाणे', 'इंस्पेक्टर'] },
    { label: 'cyber cell', words: ['cyber cell', 'cyber crime', 'cybercrime', 'cyber police', 'साइबर', 'सायबर'] },
    { label: 'customs', words: ['customs', 'custom department', 'कस्टम', 'सीमा शुल्क'] },
    { label: 'narcotics', words: ['narcotics', 'ncb', 'anti narcotics', 'एनसीबी'] },
    { label: 'TRAI', words: ['trai', 'telecom regulatory', 'ट्राई'] },
    { label: 'RBI', words: ['rbi', 'reserve bank', 'आरबीआई', 'रिझर्व्ह बँक', 'रिजर्व बैंक'] },
    { label: 'income tax', words: ['income tax', 'it department', 'आयकर', 'इन्कम टॅक्स'] },
    { label: 'courier', words: ['fedex', 'dhl', 'bluedart', 'blue dart', 'dtdc', 'courier', 'कुरिअर', 'कूरियर'] },
    { label: 'bank', words: ['sbi', 'state bank', 'hdfc', 'icici', 'axis bank', 'kotak', 'punjab national', 'pnb', 'bank of baroda', 'canara', 'union bank', 'bank', 'बँक', 'बैंक', 'स्टेट बँक'] },
    { label: 'electricity board', words: ['electricity board', 'mseb', 'bescom', 'mahavitaran', 'bijli', 'वीज', 'महावितरण', 'बिजली', 'विद्युत'] },
    { label: 'telecom', words: ['jio', 'airtel', 'vodafone', 'vi ', 'bsnl', 'idea', 'sim card department', 'जिओ', 'एअरटेल'] },
    { label: 'court', words: ['court', 'magistrate', 'tribunal', 'न्यायालय', 'कोर्ट', 'अदालत'] },
];

/** UPI payment service providers. Used to flag whether a handle is a known PSP. */
const KNOWN_PSPS = new Set([
    'okaxis', 'oksbi', 'okhdfcbank', 'okicici', 'okbizaxis',
    'ybl', 'ibl', 'axl', 'axisb', 'apl', 'yapl', 'ypl',
    'paytm', 'ptyes', 'ptaxis', 'ptsbi', 'pthdfc',
    'upi', 'airtel', 'freecharge', 'jio', 'jupiteraxis', 'fam', 'slice',
    'sliceaxis', 'naviaxis', 'timecosmos', 'abfspay', 'waaxis', 'waicici',
    'kotak', 'kmbl', 'indus', 'rbl', 'idfcbank', 'idfcfirst', 'federal', 'fbl',
    'barodampay', 'aubank', 'cnrb', 'dlb', 'sbi', 'hdfcbank', 'icici',
    'axisbank', 'yesbank', 'utib', 'hsbc', 'pockets', 'mahb', 'uboi', 'unionbank',
    'cboi', 'citi', 'citigold', 'dbs', 'equitas', 'ikwik', 'pingpay', 'postbank',
    'psb', 'purz', 'rapl', 'seyes', 'superyes', 'tapicici', 'yesg',
]);

const SHORTENER_HOSTS = [
    'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'cutt.ly', 'rb.gy',
    'shorturl.at', 'rebrand.ly', 'tiny.cc', 'ow.ly', 'buff.ly', 'wa.me',
];

// Common TLDs plus the ones that turn up in Indian phishing.
const TLDS = [
    'com', 'in', 'net', 'org', 'co', 'io', 'me', 'info', 'biz', 'xyz', 'top',
    'online', 'site', 'club', 'live', 'app', 'link', 'icu', 'shop', 'store',
    'work', 'fun', 'pro', 'cc', 'ly', 'gd', 'to', 'ru', 'cn', 'tk', 'ml', 'ga',
    'cf', 'gq', 'buzz', 'cyou', 'rest', 'bond', 'sbs', 'website', 'space',
];

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const PATTERNS = {
    // Any digit run, as the raw material for the claiming detectors.
    digitRun: /\d{4,20}/g,

    // Indian mobile: optional +91 / 91 / 0091 / 0, then 6-9 and nine more digits.
    mobile: /(?:(?:\+|00)?91[\s\-.]?|0)?[6-9]\d{9}(?!\d)/g,

    // Toll-free (1800 / 1860) and landline with an STD code, both only when
    // written in a recognisable form.
    tollFree: /\b1(?:800|860)[\s\-]?\d{2,4}[\s\-]?\d{3,6}\b/g,
    landline: /\b0\d{2,4}[\s\-]\d{6,8}\b/g,

    ifsc: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
    pan: /\b[A-Z]{5}\d{4}[A-Z]\b/g,

    // Aadhaar: twelve digits, usually grouped 4-4-4.
    aadhaarGrouped: /\b\d{4}[\s-]\d{4}[\s-]\d{4}\b/g,
    aadhaarPlain: /\b\d{12}\b/g,

    /**
     * UPI handle.
     *
     * The PSP must be letters only, must not be followed by a word character,
     * hyphen or another @, and must not be followed by a dot that itself leads
     * into more of a domain.
     *
     * Those two lookaheads are what stops "support@fake-sbi.com" from also
     * yielding the UPI id "support@fake" (a hyphen follows "fake") and
     * "x@sbi.co.in" from yielding "x@sbi" (".c" follows "sbi"), while still
     * accepting "refund@okaxis." at the end of a sentence.
     */
    upi: /\b([a-z0-9][a-z0-9._-]{1,48})@([a-z]{2,24})(?![\w\-@])(?!\.[a-z0-9])/gi,

    email: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+\b/g,

    // A URL with a scheme, including the "hxxp" obfuscation.
    schemeUrl: /\bh(?:tt|xx)ps?:\/\/[^\s<>"')]+/gi,

    // Bitcoin: legacy, P2SH and bech32.
    btc: /\b(?:[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-z0-9]{25,62})\b/g,
    eth: /\b0x[a-fA-F0-9]{40}\b/g,
    tron: /\bT[1-9A-HJ-NP-Za-km-z]{33}\b/g,

    // A date, so it is never read as an account number.
    date: /\b\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}\b/g,
};

/** A URL written without a scheme, ending in a known TLD. */
const bareUrlPattern = () => new RegExp(
    `\\b(?:www\\.)?[a-z0-9][a-z0-9-]{1,61}(?:\\.[a-z0-9][a-z0-9-]{1,61})*\\.(?:${TLDS.join('|')})\\b(?:\\/[^\\s<>"')]*)?`,
    'gi'
);

/**
 * A URL whose dots have been obfuscated: "sbi[.]verify[.]in",
 * "sbi(dot)verify(dot)in", "sbi verify dot in".
 *
 * Requires at least one obfuscated separator, so ordinary prose cannot match.
 */
const obfuscatedUrlPattern = () => new RegExp(
    '\\b(?:h(?:tt|xx)ps?\\s*:?\\s*\\/*\\s*)?'
    + '[a-z0-9][a-z0-9-]{1,61}'
    + '(?:\\s*(?:\\[\\s*(?:\\.|dot)\\s*\\]|\\(\\s*(?:\\.|dot)\\s*\\)|\\{\\s*(?:\\.|dot)\\s*\\}|\\s+dot\\s+|\\s+\\.\\s+)\\s*[a-z0-9][a-z0-9-]{1,61}){1,5}'
    + '(?:\\/[^\\s<>"\')]*)?',
    'gi'
);

const amountPattern = () => new RegExp(
    // Currency marker first: "Rs 50,000", "₹2 lakh"
    `(?:${CURRENCY_MARKER}\\s*\\d[\\d,]*(?:\\.\\d+)?\\s*(?:${MULTIPLIER_WORDS.join('|')})?)`
    // or a quantity followed by a multiplier: "2 lakh", "दो लाख", "50 हजार"
    + `|(?:\\d[\\d,]*(?:\\.\\d+)?\\s*(?:${MULTIPLIER_WORDS.join('|')}))`
    + `|(?:[${LETTER_CLASS}]{2,12}\\s*(?:${MULTIPLIER_WORDS.join('|')}))`
    // or a bare quantity followed by a currency word: "50000 rupees"
    + `|(?:\\d[\\d,]*(?:\\.\\d+)?\\s*${CURRENCY_MARKER})`,
    'giu'
);

const caseRefPattern = () => new RegExp(
    `(?:${CASE_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`
    + '\\s*(?:no\\.?|number|nmbr|क्रमांक|नंबर)?\\s*'
    // A copula is allowed between the label and the value: "the case number IS
    // MUM/CYB/2026/00891" is how a caller actually says it out loud.
    + '(?:is|was|are|hai|aahe|ahe|आहे|है)?\\s*'
    + '[:#\\-]?\\s*'
    + '([A-Z0-9][A-Z0-9/\\-]{3,24})',
    'giu'
);

// ---------------------------------------------------------------------------
// Sentence splitting
// ---------------------------------------------------------------------------

/**
 * Abbreviations whose full stop does not end a sentence. "Rs." matters most:
 * splitting there separates the currency marker from its amount, so
 * "Pay Rs. 50000" would stop being read as money at all.
 */
const ABBREVIATIONS = [
    'rs', 'inr', 'mr', 'mrs', 'ms', 'dr', 'smt', 'shri', 'sh', 'kum',
    'no', 'nos', 'a\\/c', 'ac', 'approx', 'etc', 'vs', 'pvt', 'ltd', 'inc',
    'st', 'rd', 'govt', 'dept', 'min', 'hrs', 'am', 'pm', 'i\\.e', 'e\\.g',
];

/** Sentence terminator, except after an abbreviation or a single initial. */
const SENTENCE_BREAK = new RegExp(
    `(?<!\\b(?:${ABBREVIATIONS.join('|')})\\.)(?<!\\b[A-Z]\\.)(?<=[.!?।॥])\\s+|\\n+`,
    'i'
);

/**
 * Splits into sentences, keeping the Devanagari danda and double danda as
 * terminators alongside the Latin ones. Entities quote the sentence they came
 * from, so this is what makes the evidence auditable.
 */
const splitSentences = (text) => String(text)
    .split(SENTENCE_BREAK)
    .filter((s) => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

// ---------------------------------------------------------------------------
// Claim tracking
// ---------------------------------------------------------------------------

/**
 * Records which digit strings have already been accounted for by a more
 * specific type, so the bank-account detector can refuse them.
 */
class Claims {
    constructor() {
        this.byDigits = new Map(); // digits -> type that claimed them
    }

    claim(value, type) {
        const digits = String(value).replace(/\D/g, '');
        if (digits.length >= 4 && !this.byDigits.has(digits)) this.byDigits.set(digits, type);
    }

    claimedBy(value) {
        const digits = String(value).replace(/\D/g, '');
        if (this.byDigits.has(digits)) return this.byDigits.get(digits);

        // A digit run that merely contains, or sits inside, something already
        // claimed is also spoken for: "919876543210" holds a claimed mobile.
        for (const [claimed, type] of this.byDigits) {
            if (claimed.length >= 8 && (digits.includes(claimed) || claimed.includes(digits))) return type;
        }
        return null;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True when any of `words` appears within `window` characters of [start,end). */
const hasNearbyWord = (text, start, end, words, window = 40) => {
    const from = Math.max(0, start - window);
    const to = Math.min(text.length, end + window);
    const context = text.slice(from, to);
    return boundedWords(words).test(context) || words.some((w) => w.includes('/') && context.toLowerCase().includes(w));
};

/**
 * Blanks a span while preserving length, so offsets stay valid for detectors
 * running over the same string afterwards.
 */
const mask = (text, start, length) => text.slice(0, start) + ' '.repeat(length) + text.slice(start + length);

/** Normalises an Indian phone number to +91XXXXXXXXXX. */
const normalizePhone = (raw) => {
    const digits = asciiDigits(raw).replace(/\D/g, '');

    // Strip the trunk zero or an international prefix first, THEN the country
    // code. Doing it in the other order left "0919876543210" as twelve digits
    // and returned null.
    let national = digits.replace(/^0+/, '');
    if (national.length > 10 && national.startsWith('91')) national = national.slice(2);

    if (national.length === 10 && /^[6-9]/.test(national)) return `+91${national}`;
    return null;
};

const deobfuscateUrl = (raw) => {
    let value = String(raw).trim().replace(/[.,;:)\]]+$/, '');
    value = value
        .replace(/\bh(?:xx)(ps?)\b/gi, 'htt$1')
        .replace(/\s*[[({]\s*(?:\.|dot)\s*[\])}]\s*/gi, '.')
        .replace(/\s+dot\s+/gi, '.')
        .replace(/\s+\.\s+/g, '.')
        .replace(/\s*:\s*\/*\s*\/\s*/g, '://')
        .replace(/\s+/g, '');
    if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
    return value.toLowerCase();
};

const isShortener = (url) => {
    try {
        const host = new URL(url).hostname.replace(/^www\./, '');
        return SHORTENER_HOSTS.includes(host);
    } catch {
        return false;
    }
};

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Extracts entities from one message.
 *
 * @param {string} text
 * @param {object} context  { sessionId, messageId, timestamp }
 * @returns {object[]} entity records
 */
const extractEntities = (text, context = {}) => {
    if (text === null || text === undefined) return [];

    const { sessionId = null, messageId = null, timestamp = null } = context;

    try {
        const original = String(text);
        if (original.trim() === '') return [];

        const entities = [];
        const seen = new Set();

        const push = (type, raw, normalized, sentence, meta = {}) => {
            if (normalized === null || normalized === undefined || normalized === '') return;
            const key = `${type}:${normalized}`;
            if (seen.has(key)) return;
            seen.add(key);
            entities.push({
                type,
                raw: String(raw).trim(),
                normalized: typeof normalized === 'number' ? normalized : String(normalized),
                sessionId,
                messageId,
                timestamp,
                sentence,
                method: 'rules',
                ...(Object.keys(meta).length > 0 ? { meta } : {}),
            });
        };

        for (const sentence of splitSentences(original)) {
            // Work on a digit-normalised copy: Devanagari digits to ASCII, words
            // read out as digits expanded, and digits split by single spaces or
            // hyphens joined up. `raw` still quotes the sentence as written.
            const dictated = findDictatedNumbers(asciiDigits(sentence));
            const expanded = expandDictatedNumbers(asciiDigits(sentence)).text;
            const scan = joinSpacedDigits(expanded);

            /** Recovers the phrase actually written for a normalised number. */
            const rawFor = (digits, fallback) => {
                const spoken = dictated.find((d) => d.digits === String(digits).replace(/\D/g, ''));
                return spoken ? spoken.raw : fallback;
            };

            const claims = new Claims();

            // --- IFSC and PAN first: they are unambiguous. ---
            for (const match of sentence.matchAll(PATTERNS.ifsc)) {
                push('ifsc', match[0], match[0].toUpperCase(), sentence);
            }
            for (const match of sentence.matchAll(PATTERNS.pan)) {
                claims.claim(match[0], 'pan');
                push('pan', match[0], match[0].toUpperCase(), sentence);
            }

            // --- Aadhaar: grouped form always, plain twelve digits only with
            // the word nearby, so an account number is not mislabelled. ---
            // Matched on the un-joined text so `raw` keeps the 4-4-4 grouping
            // exactly as it was written.
            for (const match of asciiDigits(sentence).matchAll(PATTERNS.aadhaarGrouped)) {
                claims.claim(match[0], 'aadhaar');
                push('aadhaar', match[0], match[0].replace(/\D/g, ''), sentence);
            }
            for (const match of scan.matchAll(PATTERNS.aadhaarPlain)) {
                // Claimed only when it is actually recorded as an Aadhaar.
                // Claiming every twelve-digit run would swallow "919876543210",
                // which is a mobile number carrying its country code.
                if (!hasNearbyWord(scan, match.index, match.index + match[0].length, AADHAAR_WORDS, 60)) continue;
                claims.claim(match[0], 'aadhaar');
                push('aadhaar', rawFor(match[0], match[0]), match[0], sentence);
            }

            // --- Amounts, before phones and accounts: "₹50000" is money. ---
            for (const match of scan.matchAll(amountPattern())) {
                const rupees = parseAmount(match[0]);
                if (rupees === null) continue;
                claims.claim(match[0], 'amount');
                push('amount', match[0].trim(), rupees, sentence, { currency: 'INR' });
            }

            // --- Dates and OTP values: claimed so they are never accounts. ---
            for (const match of scan.matchAll(PATTERNS.date)) claims.claim(match[0], 'date');
            for (const match of scan.matchAll(/\b\d{4,8}\b/g)) {
                if (hasNearbyWord(scan, match.index, match.index + match[0].length, OTP_WORDS, 30)) {
                    claims.claim(match[0], 'otp');
                }
            }

            // --- Case references, before generic digit runs. ---
            for (const match of sentence.matchAll(caseRefPattern())) {
                const value = match[1];
                // A bare number next to the word "UPI ID" is not a case number;
                // require the reference itself to look like one.
                if (!/\d/.test(value)) continue;
                claims.claim(value, 'caseRef');
                push('caseRef', match[0].trim(), value.toUpperCase(), sentence);
            }

            // --- Phones. ---
            // Toll-free and landline numbers are read from the un-joined text:
            // their separators are part of what identifies them, and
            // joinSpacedDigits would have removed them.
            const unjoined = asciiDigits(sentence);

            for (const match of unjoined.matchAll(PATTERNS.tollFree)) {
                const digits = match[0].replace(/\D/g, '');
                claims.claim(digits, 'phone');
                push('phone', match[0], digits, sentence, { kind: 'toll_free' });
            }
            for (const match of unjoined.matchAll(PATTERNS.landline)) {
                const digits = match[0].replace(/\D/g, '');
                claims.claim(digits, 'phone');
                push('phone', match[0], `+91${digits.replace(/^0/, '')}`, sentence, { kind: 'landline' });
            }
            for (const match of scan.matchAll(PATTERNS.mobile)) {
                const normalized = normalizePhone(match[0]);
                if (!normalized) continue;
                // Anything a more specific detector already accounted for is
                // skipped. Without this, the toll-free number 1800 123 4567
                // also yields the "mobile" 8001234567 sitting inside it, and a
                // twelve-digit Aadhaar yields the ten digits it ends with.
                if (claims.claimedBy(match[0])) continue;
                claims.claim(match[0], 'phone');
                claims.claim(normalized, 'phone');
                const asUpi = hasNearbyWord(scan, match.index, match.index + match[0].length, ['upi', 'vpa', 'gpay', 'phonepe', 'paytm'], 30);
                push('phone', rawFor(match[0], match[0]), normalized, sentence, {
                    kind: 'mobile',
                    ...(asUpi ? { offeredAsUpiHandle: true } : {}),
                });
            }

            // --- Bank accounts: context required, and nothing already claimed. ---
            for (const match of scan.matchAll(PATTERNS.digitRun)) {
                const digits = match[0];
                if (digits.length < 9 || digits.length > 18) continue;

                const claimedBy = claims.claimedBy(digits);
                if (claimedBy) continue;

                if (!hasNearbyWord(scan, match.index, match.index + digits.length, ACCOUNT_WORDS, 60)) continue;

                claims.claim(digits, 'bankAccount');
                push('bankAccount', rawFor(digits, digits), digits, sentence);
            }

            // --- Email before UPI, so an address is never read as a handle. ---
            const emails = [];
            // A blanked copy, same length, so later detectors cannot read an
            // email's domain as a link or its brand as an authority claim.
            let masked = sentence;
            for (const match of sentence.matchAll(PATTERNS.email)) {
                emails.push(match[0].toLowerCase());
                masked = mask(masked, match.index, match[0].length);
                push('email', match[0], match[0].toLowerCase(), sentence);
            }

            for (const match of sentence.matchAll(PATTERNS.upi)) {
                const value = match[0].toLowerCase();
                if (emails.includes(value)) continue;
                const psp = match[2].toLowerCase();
                push('upiId', match[0], value, sentence, {
                    psp,
                    knownPsp: KNOWN_PSPS.has(psp),
                });
            }

            // --- URLs: scheme-led, bare, and obfuscated. Run over the masked
            // copy, so "support@fake-sbi.com" does not also yield the link
            // "fake-sbi.com". ---
            const urlRaws = [];
            for (const pattern of [PATTERNS.schemeUrl, bareUrlPattern(), obfuscatedUrlPattern()]) {
                for (const match of masked.matchAll(pattern)) {
                    const raw = match[0];
                    // Skip a fragment of a URL already captured in full.
                    if (urlRaws.some((existing) => existing.includes(raw) && existing !== raw)) continue;
                    const normalized = deobfuscateUrl(raw);
                    urlRaws.push(raw);
                    masked = mask(masked, match.index, raw.length);

                    const isApk = /\.apk(?:$|[?#])/i.test(normalized)
                        || (/\.apk/i.test(normalized) && /download|install/i.test(sentence));

                    push(isApk ? 'apkLink' : 'url', raw, normalized, sentence, {
                        ...(isShortener(normalized) ? { shortener: true } : {}),
                        ...(/h(?:xx)ps?|[[({]\s*(?:\.|dot)|\sdot\s|\s\.\s/i.test(raw) ? { obfuscated: true } : {}),
                    });
                }
            }

            // --- Crypto wallets. ---
            for (const [type, pattern] of [['BTC', PATTERNS.btc], ['ETH', PATTERNS.eth], ['TRON', PATTERNS.tron]]) {
                for (const match of sentence.matchAll(pattern)) {
                    push('cryptoWallet', match[0], match[0], sentence, { chain: type });
                }
            }

            // --- Claimed authority, from the masked copy: the "sbi" inside
            // "support@fake-sbi.com" is part of an address, not a claim. ---
            for (const authority of AUTHORITIES) {
                const hit = masked.match(boundedWords(authority.words));
                if (hit) push('impersonatedAuthority', hit[0], authority.label, sentence);
            }
        }

        return entities;
    } catch (error) {
        logger.error(`Extractor failed: ${error.message}`);
        return [];
    }
};

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Maps entity types onto the flat report fields. */
const SUMMARY_FIELDS = {
    phone: 'phoneNumbers',
    bankAccount: 'bankAccounts',
    ifsc: 'ifscCodes',
    upiId: 'upiIds',
    email: 'emailAddresses',
    url: 'phishingLinks',
    apkLink: 'apkLinks',
    cryptoWallet: 'cryptoWallets',
    amount: 'amountsDemanded',
    impersonatedAuthority: 'impersonatedAuthorities',
    caseRef: 'caseRefs',
    aadhaar: 'aadhaarNumbers',
    pan: 'panNumbers',
};

/** Identifiers that count as hard evidence of a payment trail. */
const EVIDENCE_FIELDS = [
    'bankAccounts', 'upiIds', 'ifscCodes', 'phoneNumbers',
    'phishingLinks', 'apkLinks', 'emailAddresses', 'cryptoWallets',
];

const emptySummary = () => {
    const summary = {};
    for (const field of Object.values(SUMMARY_FIELDS)) summary[field] = [];
    return summary;
};

/** Collapses entity records into de-duplicated lists of normalised values. */
const summarize = (entities) => {
    const summary = emptySummary();
    for (const entity of entities) {
        const field = SUMMARY_FIELDS[entity.type];
        if (!field) continue;
        if (!summary[field].includes(entity.normalized)) summary[field].push(entity.normalized);
    }
    return summary;
};

/**
 * Merges entities into a session: appends the new records and refreshes the
 * flat summary. Identifiers and keywords are counted separately, since a
 * keyword is a tactic hint and not evidence.
 */
const mergeInto = (session, entities) => {
    const existing = new Set((session.entities || []).map((e) => `${e.type}:${e.normalized}`));
    const fresh = entities.filter((e) => !existing.has(`${e.type}:${e.normalized}`));

    if (fresh.length > 0) {
        session.entities.push(...fresh);
        session.markModified('entities');

        const summary = summarize(session.entities);
        for (const [field, values] of Object.entries(summary)) {
            session.intelligence[field] = values;
        }
        session.markModified('intelligence');
    }

    return { identifiers: fresh.length, types: [...new Set(fresh.map((e) => e.type))] };
};

/** True when the session holds at least one hard identifier. */
const hasHardEvidence = (session) => EVIDENCE_FIELDS.some(
    (field) => (session.intelligence?.[field] || []).length > 0
);

module.exports = {
    extractEntities,
    summarize,
    emptySummary,
    mergeInto,
    hasHardEvidence,
    splitSentences,
    normalizePhone,
    deobfuscateUrl,
    TYPES,
    SUMMARY_FIELDS,
    EVIDENCE_FIELDS,
    AUTHORITIES,
    KNOWN_PSPS,
    PATTERNS,
};
