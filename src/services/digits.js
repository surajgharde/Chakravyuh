/**
 * Number handling for English, Hindi and Marathi input.
 *
 * Three jobs:
 *   1. Devanagari digits to ASCII, one character for one character, so byte
 *      offsets into the original text stay valid.
 *   2. Numbers dictated as words ("nine eight seven...", "nau aath saat...",
 *      "नौ आठ सात...") expanded into digit strings, keeping the original phrase
 *      so an entity can still quote what was actually written.
 *   3. Money phrases ("2 lakh", "दो लाख", "Rs 50,000") to integer rupees.
 */

// ---------------------------------------------------------------------------
// Word boundaries that work outside ASCII
// ---------------------------------------------------------------------------

/**
 * JavaScript's \b is defined on [A-Za-z0-9_], so /\bलाख\b/ never matches
 * anything. These lookarounds use the Unicode letter, mark and number
 * categories instead, which works for Latin and Devanagari alike.
 */
const LETTER_CLASS = '\\p{L}\\p{M}\\p{N}';

/** Escapes a literal for use inside a regex. */
const escapeRe = (word) => String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Builds a boundary-anchored regex for one or more alternatives. */
const bounded = (body, flags = 'iu') => new RegExp(
    `(?<![${LETTER_CLASS}])(?:${body})(?![${LETTER_CLASS}])`,
    flags
);

/** Boundary-anchored regex over a list of literal words. */
const boundedWords = (words, flags = 'iu') => bounded(words.map(escapeRe).join('|'), flags);

// ---------------------------------------------------------------------------
// Devanagari digits
// ---------------------------------------------------------------------------

const DEVANAGARI_DIGITS = '०१२३४५६७८९';

/** Replaces Devanagari digits with ASCII ones. Length is preserved. */
const asciiDigits = (text) => String(text).replace(/[०-९]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d)));

// ---------------------------------------------------------------------------
// Digits dictated as words
// ---------------------------------------------------------------------------

/**
 * One entry per digit. Covers English, Hindi and Marathi, in Devanagari and in
 * the usual romanisations. Several spellings are shared between Hindi and
 * Marathi, which is fine: the mapping only has to be unambiguous per token.
 */
const DIGIT_WORDS = {
    0: ['zero', 'oh', 'o', 'shunya', 'shunnya', 'sunya', 'जीरो', 'शून्य', 'सुन्य'],
    1: ['one', 'ek', 'एक', 'वन'],
    2: ['two', 'do', 'don', 'दो', 'दोन', 'टू'],
    3: ['three', 'teen', 'tin', 'theen', 'तीन'],
    4: ['four', 'char', 'chaar', 'चार'],
    5: ['five', 'panch', 'paanch', 'pach', 'paach', 'पांच', 'पाँच', 'पाच'],
    6: ['six', 'chhe', 'che', 'chah', 'chha', 'cheh', 'sahaa', 'saha', 'छह', 'छः', 'सहा'],
    7: ['seven', 'saat', 'sat', 'सात'],
    8: ['eight', 'aath', 'ath', 'आठ'],
    9: ['nine', 'nau', 'nav', 'nou', 'नौ', 'नऊ'],
};

const WORD_TO_DIGIT = new Map();
for (const [digit, words] of Object.entries(DIGIT_WORDS)) {
    for (const word of words) WORD_TO_DIGIT.set(word, digit);
}

// Separators allowed between dictated digits: spaces, hyphens, commas, "dash".
const DICTATION_SEPARATOR = /^[\s,\-]*(?:dash[\s,\-]*)?/;

/**
 * Minimum run length before a sequence of words is read as a dictated number.
 *
 * Deliberately high. Several tokens above ("one", "do", "char", "o", "sat")
 * are ordinary words in English, Hindi and Marathi, so a short run would
 * produce nonsense. A phone or account number dictated aloud is always long,
 * which makes the length itself the signal.
 */
const MIN_DICTATED_RUN = 6;

/**
 * Tokenizes into words, preserving offsets.
 * \p{M} matters: without it "पांच" splits at its vowel mark.
 */
const tokenize = (text) => {
    const tokens = [];
    const pattern = /[\p{L}\p{M}\p{N}]+/gu;
    let match = pattern.exec(text);
    while (match !== null) {
        tokens.push({ word: match[0], start: match.index, end: match.index + match[0].length });
        match = pattern.exec(text);
    }
    return tokens;
};

/**
 * Finds numbers dictated as words.
 *
 * @returns {{raw: string, digits: string, start: number, end: number}[]}
 */
const findDictatedNumbers = (text) => {
    const source = String(text);
    const tokens = tokenize(source);
    const found = [];

    let index = 0;
    while (index < tokens.length) {
        const run = [];

        // Walk forward while each token is a digit word and the gap between it
        // and the previous one holds nothing but separators.
        let cursor = index;
        while (cursor < tokens.length) {
            const token = tokens[cursor];
            const key = token.word.toLowerCase();
            if (!WORD_TO_DIGIT.has(key)) break;

            if (run.length > 0) {
                const gap = source.slice(tokens[cursor - 1].end, token.start);
                if (gap.replace(DICTATION_SEPARATOR, '') !== '') break;
            }

            run.push(token);
            cursor += 1;
        }

        if (run.length >= MIN_DICTATED_RUN) {
            const start = run[0].start;
            const end = run[run.length - 1].end;
            found.push({
                raw: source.slice(start, end),
                digits: run.map((t) => WORD_TO_DIGIT.get(t.word.toLowerCase())).join(''),
                start,
                end,
            });
            index = cursor;
        } else {
            index += 1;
        }
    }

    return found;
};

/**
 * Returns the text with dictated numbers replaced by their digits, plus the
 * list of replacements so a caller can recover what was originally written.
 */
const expandDictatedNumbers = (text) => {
    const source = String(text);
    const spans = findDictatedNumbers(source);
    if (spans.length === 0) return { text: source, spans: [] };

    let out = '';
    let cursor = 0;
    for (const span of spans) {
        out += source.slice(cursor, span.start) + span.digits;
        cursor = span.end;
    }
    out += source.slice(cursor);

    return { text: out, spans };
};

/**
 * Collapses digits written with separators inside them, so "98765 43210" and
 * "98765-43210" read as one number. Only single-space or single-hyphen
 * separators are joined, and only when the result is 6-18 digits long, which
 * is the range every identifier we care about falls into.
 */
const joinSpacedDigits = (text) => String(text).replace(
    /\d[\d\s\-]{4,22}\d/g,
    (match) => {
        const digitsOnly = match.replace(/[\s-]/g, '');
        if (digitsOnly.length < 6 || digitsOnly.length > 18) return match;
        // Anything with a doubled separator is two numbers, not one.
        if (/[\s-]{2,}/.test(match)) return match;
        return digitsOnly;
    }
);

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

const MULTIPLIERS = [
    { words: ['crore', 'cr', 'crores', 'करोड़', 'करोड', 'कोटी'], factor: 10000000 },
    { words: ['lakh', 'lac', 'lakhs', 'lacs', 'लाख'], factor: 100000 },
    { words: ['thousand', 'hazar', 'hazaar', 'hajar', 'हजार', 'हज़ार'], factor: 1000 },
];

/** Small cardinals that can precede a multiplier ("two lakh", "दोन लाख"). */
const CARDINALS = {
    1: ['one', 'ek', 'एक'],
    2: ['two', 'do', 'don', 'दो', 'दोन'],
    3: ['three', 'teen', 'tin', 'तीन'],
    4: ['four', 'char', 'chaar', 'चार'],
    5: ['five', 'panch', 'paanch', 'paach', 'पांच', 'पाच'],
    10: ['ten', 'das', 'dus', 'दस', 'दहा'],
    20: ['twenty', 'bees', 'बीस'],
    25: ['twentyfive', 'pachees', 'पच्चीस'],
    50: ['fifty', 'pachas', 'pachaas', 'पचास', 'पन्नास'],
    100: ['hundred', 'sau', 'सौ', 'शंभर'],
};

const CARDINAL_TO_VALUE = new Map();
for (const [value, words] of Object.entries(CARDINALS)) {
    for (const word of words) CARDINAL_TO_VALUE.set(word, Number(value));
}

const CURRENCY_MARKER = '(?:₹|रु\\.?|रुपये|रुपए|रूपये|रुपया|rs\\.?|inr|rupees?|rupaye)';
const MULTIPLIER_WORDS = MULTIPLIERS.flatMap((m) => m.words);

const multiplierFor = (word) => {
    if (!word) return 1;
    const key = String(word).toLowerCase();
    const entry = MULTIPLIERS.find((m) => m.words.includes(key));
    return entry ? entry.factor : 1;
};

/**
 * Parses a money phrase into whole rupees.
 * Returns null when the phrase carries no usable number.
 */
const parseAmount = (phrase) => {
    const text = asciiDigits(String(phrase)).toLowerCase();

    const multiplierMatch = text.match(boundedWords(MULTIPLIER_WORDS));
    const multiplier = multiplierFor(multiplierMatch ? multiplierMatch[0] : null);

    // A digit quantity, with Indian or Western grouping, optionally decimal.
    const numberMatch = text.match(/\d[\d,]*(?:\.\d+)?/);
    if (numberMatch) {
        const value = Number.parseFloat(numberMatch[0].replace(/,/g, ''));
        if (!Number.isFinite(value)) return null;
        return Math.round(value * multiplier);
    }

    // Otherwise a cardinal word in front of the multiplier ("two lakh").
    for (const [word, value] of CARDINAL_TO_VALUE) {
        if (bounded(escapeRe(word)).test(text)) return Math.round(value * multiplier);
    }

    return null;
};

module.exports = {
    LETTER_CLASS,
    escapeRe,
    bounded,
    boundedWords,
    asciiDigits,
    findDictatedNumbers,
    expandDictatedNumbers,
    joinSpacedDigits,
    parseAmount,
    CURRENCY_MARKER,
    MULTIPLIER_WORDS,
    MIN_DICTATED_RUN,
    DIGIT_WORDS,
};
