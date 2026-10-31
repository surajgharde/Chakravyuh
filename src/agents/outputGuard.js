/**
 * Output guard: the last thing every decoy draft passes through before it is
 * sent.
 *
 * Nothing reaches the other party without clearing this. The decoy's prompt
 * asks for all of these things too, but a prompt is a request and this is a
 * check — a model that ignores an instruction once must still not be able to
 * put a credential, a link or a threat on the wire.
 *
 * TWO KINDS OF RULE
 *
 * Safety rules BLOCK. The draft is thrown away and the decoy writes another
 * one, up to two attempts, after which it falls back to a scripted stall line.
 * There is no "softened" version of a reply that leaked an account number.
 *
 * Persona rules REWRITE. A named bank is a consistency slip, not a danger, and
 * a safe substitute keeps the conversation alive rather than spending an
 * attempt on it.
 *
 * A verdict is one of:
 *   pass     - send it as is
 *   rewrite  - send `text` instead (a safe substitute), and record why
 *   block    - do not send; the caller regenerates, then falls back
 *
 * WHAT IS DELIBERATELY NOT BLOCKED
 *
 * The decoy's whole job is to *ask* for identifiers, so "what is your account
 * number?" and "which IFSC should I type?" must pass. Every rule here keys on
 * the reply *supplying* something, not on it mentioning the subject. The same
 * goes for "the app is not opening" — reporting that an app failed is a
 * stalling excuse; agreeing to install one is not.
 */

const logger = require('../services/logger');
const { asciiDigits, expandDictatedNumbers, joinSpacedDigits } = require('../services/digits');

const VERDICTS = { PASS: 'pass', REWRITE: 'rewrite', BLOCK: 'block' };

/** A rule either blocks the draft or substitutes a safe line for it. */
const SEVERITY = { BLOCK: 'block', REWRITE: 'rewrite' };

/** Said instead of a reply that broke a persona rule. */
const SAFE_SUBSTITUTES = {
    bank_named: 'Sorry, I do not remember the name. It is the branch near Karve Road.',
};

/**
 * The stall line used when a draft was blocked twice.
 *
 * Deliberately content-free: it carries no number, no link, no claim and no
 * commitment, so it is safe whatever the draft it is replacing contained.
 */
const SAFE_STALL = {
    English: 'Beta, I did not follow that. Please say it again slowly.',
    Hindi: 'Beta, mujhe samajh nahin aaya. Phir se dheere batayiye.',
    Marathi: 'Bala, mala kalale nahi. Punha halu sanga.',
};

// ---------------------------------------------------------------------------
// Digit shapes
// ---------------------------------------------------------------------------

/**
 * Puts a draft into the one form the digit rules are written against.
 *
 * A number can be hidden from a plain regex three ways, and the extractor
 * already has a tested helper for each: Devanagari numerals (`asciiDigits`),
 * dictation in words — "eight eight four five one two" —
 * (`expandDictatedNumbers`), and numerals spaced out one at a time — "8 8 4 5
 * 1 2" — (`joinSpacedDigits`). Reusing those means the guard reads a number
 * exactly the way the extractor does, so a shape the extractor would file as
 * evidence cannot slip out of a reply.
 */
const normalise = (text) => {
    const ascii = asciiDigits(String(text || ''));
    return joinSpacedDigits(expandDictatedNumbers(ascii).text);
};

/**
 * Collapses a run of digits written with separators into bare digits.
 *
 * Only separators *between* digits go: the run has to start and end with a
 * digit, so "at 10 am and 4 pm" is two short numbers and never one long one.
 */
const digitRuns = (text) => {
    const ascii = normalise(text);
    const runs = [];
    const pattern = /\d(?:[\s.\-–—]?\d)*/g;
    let match = pattern.exec(ascii);
    while (match !== null) {
        runs.push(match[0].replace(/[^\d]/g, ''));
        match = pattern.exec(ascii);
    }
    return runs;
};

/** The longest unbroken digit run in the draft. */
const longestRun = (text) => digitRuns(text).reduce((max, run) => Math.max(max, run.length), 0);

/**
 * Where the line between a number and an identifier sits.
 *
 * Nine digits is the shortest thing on the list the brief names: an account
 * number can be nine. Below that a run is an amount, an age, a time or a
 * quantity, all of which the persona says constantly ("I am 71", "Rs 18500",
 * "2,50,000" — which is six digits once the commas go).
 *
 * The one thing shorter that still has to be caught is a credential said next
 * to its own name, which the credential-word rule below handles separately.
 */
const IDENTIFIER_DIGITS = 9;

/** A word that names a secret, so even four digits beside it is a leak. */
const CREDENTIAL_WORD = /(?:otp|o\.?t\.?p|one[\s-]?time[\s-]?password|pin|cvv|cvc|passcode|password|code|ओटीपी|पिन|पासवर्ड|कोड)/i;

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const RULES = [
    // --- the six safety rules the brief names ----------------------------
    {
        id: 'credential_leak',
        severity: SEVERITY.BLOCK,
        reason: 'The reply contained a digit string shaped like an OTP, PIN, CVV, card, '
            + 'account, Aadhaar, PAN or phone number.',
        test: (text) => {
            // Read the way the extractor reads: Devanagari folded, dictated
            // words expanded, spaced-out numerals joined.
            const ascii = normalise(text);

            // A secret said beside its own name. Three digits is enough here:
            // a CVV is three.
            if (new RegExp(`${CREDENTIAL_WORD.source}[^.?!]{0,30}\\d(?:[\\s.-]?\\d){2,}`, 'i').test(ascii)) return true;
            if (new RegExp(`\\d(?:[\\s.-]?\\d){2,}[^.?!]{0,30}${CREDENTIAL_WORD.source}`, 'i').test(ascii)) return true;

            // Any run long enough to be an identifier rather than a quantity.
            if (longestRun(text) >= IDENTIFIER_DIGITS) return true;

            // An Indian mobile number is ten digits starting 6-9, and is
            // already covered by the run length; this catches it written with a
            // country code and odd spacing.
            if (/(?:\+?\s?91|\b0)[\s-]?[6-9](?:[\s.-]?\d){9}/.test(ascii)) return true;

            // PAN and IFSC are alphanumeric, so no digit run catches them.
            if (/\b[A-Z]{5}\d{4}[A-Z]\b/.test(text)) return true;
            if (/\b[A-Z]{4}0[A-Z0-9]{6}\b/.test(text)) return true;

            // A UPI handle is an identifier too, and the persona has none.
            if (/\b[\w.-]{2,}@(?:ok\w+|ybl|paytm|apl|axl|upi|sbi|hdfcbank|icici|ibl|airtel|fbl|jio)\b/i.test(text)) return true;

            // A crypto address.
            if (/\b(?:0x[a-fA-F0-9]{40}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|T[a-zA-Z0-9]{33})\b/.test(text)) return true;

            return false;
        },
    },
    {
        id: 'link_or_install',
        severity: SEVERITY.BLOCK,
        reason: 'The reply contained a link, or agreed to open, download or install something.',
        test: (text) => {
            // A link in any of the shapes a scam uses, including the obfuscated
            // ones. The persona never has a URL to give.
            if (/\b(?:https?|hxxps?|ftp):\/\//i.test(text)) return true;
            if (/\bwww\.[a-z0-9-]/i.test(text)) return true;
            if (/\[\s*\.\s*\]|\(\s*dot\s*\)/i.test(text)) return true;
            if (/\b[a-z0-9-]{2,}\.(?:com|in|net|org|co|io|site|xyz|info|link|app|me|ru|tk|ml|cf|gq|top|online|biz)\b(?:\/\S*)?/i.test(text)) return true;
            if (/\.apk\b/i.test(text)) return true;

            // Agreeing to run a remote-access tool. Naming one at all is enough:
            // the persona has no reason to say "AnyDesk" except to cooperate.
            if (/\b(?:anydesk|teamviewer|quicksupport|airdroid|rustdesk|ammyy|screen\s*connect)\b/i.test(text)) return true;

            // Compliance, as opposed to asking a question or reporting that
            // something failed. Three things have to line up: a first-person
            // subject directly before the verb, a thing that can be opened or
            // installed, and no negation.
            //
            // The lookbehind is what keeps the decoy's own stock questions out.
            // "Which numbers should I type?" and "What should I click?" put a
            // pronoun next to a verb exactly like "I will click" does; the
            // difference is the modal or interrogative in front of it, and she
            // asks those constantly.
            const agreed = /(?<!\b(?:should|shall|can|could|would|do|did|must|may|which|what|where|how|why|if|whether)\s)\b(?:i|main|mi)\s*(?:have|has|had|will|am|was|'ve|'ll|'m)?\s*(?:now|already|just)?\s*(?:install|download|click|open|tap|press|scan|allow|accept|approve|sideload|run)(?:ed|ing|s)?\b/i;
            const shared = /\b(?:i|main|mi)\s*(?:have|will|am|'ve|'ll|'m)?\s*(?:now|already)?\s*shar(?:e|ed|ing)\s+(?:my\s+)?screen\b/i;
            const subject = /\b(?:app|apk|application|software|link|url|website|site|qr|screen|anydesk|teamviewer|request|permission|file|attachment|it|that)\b/i;
            const negated = /\b(?:not|n't|never|cannot|can't|unable|nahin?|nahi|nako|nathi|refus\w*|won't|will not|do not|don't|couldn't|could not|failed|fail\w*)\b/i;

            if (!negated.test(text) && (shared.test(text) || (agreed.test(text) && subject.test(text)))) return true;

            // Devanagari compliance, where the negation words above do not apply.
            if (/(?:डाउनलोड|इंस्टॉल|क्लिक|स्कॅन|स्कैन)[^.?!]{0,20}(?:केले|किया|करते|करत|कर दिया|झाले)/u.test(text)) return true;

            return false;
        },
    },
    {
        id: 'payment_claim',
        severity: SEVERITY.BLOCK,
        reason: 'The reply said money had been sent or that a payment had gone through.',
        test: (text) => {
            // Past or completed money movement. The persona stalls forever and
            // never pays, so any claim that she did is either a model slip or a
            // reply that would end the engagement on the scammer's terms.
            const done = /\b(?:sent|transferred|transfered|paid|deposited|credited|remitted|done|completed|successful|success|went through|has gone|processed)\b/i;
            const money = /\b(?:money|amount|payment|transfer|rs\.?|rupees|inr|₹|cash|fee|lakh|thousand|upi|neft|imps|rtgs|paisa|paise|transaction)\b/i;
            const negated = /\b(?:not|n't|never|cannot|can't|unable|haven't|have not|didn't|did not|won't|will not|failed|fail\w*|pending|trying|could not|couldn't)\b/i;

            if (done.test(text) && money.test(text) && !negated.test(text)) return true;

            // Hindi and Marathi, where the English negation list does not reach.
            if (/\b(?:bhej\s*diya|bhej\s*diye|bheja\s*hai|pathavle|pathavla|pathvle|jama\s*kar\s*diya|transfer\s*kar\s*diya|ho\s*gaya\s*payment|payment\s*ho\s*gaya)\b/i.test(text)) return true;
            if (/(?:पैसे|रक्कम|पेमेंट)[^.?!]{0,24}(?:पाठवले|भेज दिए|भेज दिया|जमा केले|जमा किया|झाले|हो गया)/u.test(text)) return true;

            return false;
        },
    },
    {
        id: 'threat_or_abuse',
        severity: SEVERITY.BLOCK,
        reason: 'The reply threatened or abused the other party.',
        test: (text) =>
            /\b(?:i will (?:kill|hurt|find|beat|destroy|ruin|expose|trace|report you)|i'?ll (?:kill|hurt|find|beat|destroy|ruin|expose|trace))\b/i.test(text)
            || /\b(?:you (?:bastard|bitch|idiot|fool|swine|dog|scum|criminal|thief)|shut up|go to hell|fuck|f\*+k|shit|asshole)\b/i.test(text)
            || /\b(?:bhenchod|madarchod|gandu|chutiya|harami|kutta|saala|randi)\b/i.test(text)
            || /\b(?:i am (?:recording|tracing) (?:you|this)|you will (?:go to jail|be arrested|pay for this))\b/i.test(text),
    },
    {
        id: 'official_impersonation',
        severity: SEVERITY.BLOCK,
        reason: 'The reply claimed to be the police, a government officer or an institution.',
        test: (text) => {
            // First-person claims only. "My son said to call the police" is an
            // ordinary thing for her to say; "I am from the police" is not.
            if (/\b(?:i\s*am|i'?m|this\s*is|speaking\s*from|calling\s*from|we\s*are)\b[^.?!]{0,30}\b(?:police|cbi|c\.b\.i|cid|ed\b|enforcement directorate|income tax|customs|narcotics|ncb|trai|rbi|reserve bank|cyber\s*(?:cell|crime|police)|crime branch|inspector|officer|constable|sub[\s-]?inspector|magistrate|court|government|govt)\b/i.test(text)) return true;
            if (/\b(?:i\s*am|i'?m)\s+(?:an?\s+)?(?:police|inspector|officer|constable|agent|advocate|lawyer|bank\s*manager|official)\b/i.test(text)) return true;
            if (/\b(?:mi|main)\b[^.?!]{0,20}\b(?:police|cbi|inspector|adhikari|afsar)\b[^.?!]{0,20}\b(?:bolat|bol|aahe|hoon|hun)\b/i.test(text)) return true;
            if (/(?:मी|मैं)[^.?!]{0,24}(?:पोलीस|पुलिस|अधिकारी|सीबीआय|सीबीआई|इंस्पेक्टर)[^.?!]{0,16}(?:बोलत|बोल)/u.test(text)) return true;
            return false;
        },
    },
    {
        id: 'persona_break',
        severity: SEVERITY.BLOCK,
        reason: 'The reply admitted to being software, or referred to the Guardian or the monitoring.',
        test: (text) =>
            /\b(?:as an ai|i am an ai|i'm an ai|i am ai|language model|llm|i am a bot|i'm a bot|i am a robot|i am a program|i am software|chatbot|artificial intelligence|gpt|openai|anthropic)\b/i.test(text)
            || /\b(?:honeypot|decoy|guardian|chakravyuh|this is a (?:test|simulation|demo|exercise)|being recorded|monitored|scam[\s-]?bait\w*|scam detect\w*|my (?:system )?prompt|my instructions|i was (?:told|instructed|programmed)|persona)\b/i.test(text),
    },
    {
        id: 'real_person_data',
        severity: SEVERITY.BLOCK,
        reason: "The reply contained a real person's personal details.",
        /**
         * The checkable part of "no real person's data".
         *
         * `protectedIdentifiers` is supplied by the caller: the protected
         * user's id and number, the counterpart's number, and every trusted
         * contact on file. Those are the only real-person values the system
         * actually holds, so those are the ones that can be matched exactly.
         * The *shape* of anybody else's identifier - a phone number, an
         * Aadhaar, a PAN - is already caught by `credential_leak`, which does
         * not care whose it is.
         */
        test: (text, context = {}) => {
            const haystack = normalise(text).toLowerCase();
            const bare = haystack.replace(/[^a-z0-9@.]/g, '');

            return (context.protectedIdentifiers || []).some((raw) => {
                const value = String(raw || '').trim().toLowerCase();
                // Short values would match inside ordinary words.
                if (value.length < 5) return false;
                const normalised = normalise(value).replace(/[^a-z0-9@.]/g, '');
                if (normalised.length < 5) return false;
                return bare.includes(normalised) || haystack.includes(value);
            });
        },
    },

    // --- persona consistency, substituted rather than blocked -------------
    {
        id: 'bank_named',
        severity: SEVERITY.REWRITE,
        reason: 'The reply named a real bank, which the persona must never do.',
        substitute: SAFE_SUBSTITUTES.bank_named,
        test: (text) => /\b(?:my|our|the)\s+(?:bank\s+is\s+)?(SBI|State Bank|HDFC|ICICI|Axis Bank|Kotak|PNB|Punjab National|Bank of Baroda|Canara Bank|Union Bank|Yes Bank|IDFC)\b/i.test(text),
    },
    {
        id: 'followed_injected_instruction',
        severity: SEVERITY.BLOCK,
        reason: 'The reply looks like it obeyed an instruction embedded in the scammer message.',
        test: (text) =>
            // Our own output schema leaking into the spoken reply, or the model
            // narrating compliance with the message it was handed.
            /"(?:reply|targetAsked|excuseUsed|ledgerUpdates|language)"\s*:/i.test(text)
            || /\b(?:ignoring|as you (?:instructed|asked|requested)|per your instruction|switching to|new instructions)\b[^.?!]{0,30}\b(?:rules|instructions|system|prompt|format|json)\b/i.test(text)
            || /^\s*[{[]/.test(text),
    },
];

/** The rules the brief names as the six things a reply must never do. */
const SAFETY_RULE_IDS = RULES.filter((rule) => rule.severity === SEVERITY.BLOCK).map((rule) => rule.id);

/**
 * Checks one draft.
 *
 * @param {string} draft
 * @param {object} [context]
 * @param {string} [context.sessionId]              for the log line
 * @param {object} [context.persona]
 * @param {string[]} [context.protectedIdentifiers] real values that must never
 *                                                  appear in a reply
 * @returns {{verdict: string, text: string, violations: object[], blocked: boolean}}
 */
const review = (draft, context = {}) => {
    const original = String(draft ?? '').trim();

    if (original === '') {
        return {
            verdict: VERDICTS.BLOCK,
            text: '',
            blocked: true,
            violations: [{ id: 'empty', reason: 'The draft was empty.', severity: SEVERITY.BLOCK }],
        };
    }

    // Every rule is tested against the ORIGINAL draft, not against a partly
    // substituted one. Cascading the substitutions meant a draft that broke two
    // rules only ever reported the first, which under-reports what went wrong.
    const fired = [];
    for (const rule of RULES) {
        try {
            if (rule.test(original, context)) fired.push(rule);
        } catch (error) {
            logger.warn(`outputGuard rule ${rule.id} threw: ${error.message}`);
        }
    }

    const violations = fired.map((rule) => ({
        id: rule.id,
        reason: rule.reason,
        severity: rule.severity,
    }));

    // Any safety violation throws the draft away. There is no softened version
    // of a reply that leaked an account number or agreed to install an APK.
    const blocking = fired.filter((rule) => rule.severity === SEVERITY.BLOCK);
    if (blocking.length > 0) {
        if (context.sessionId) {
            logger.warn(`outputGuard blocked a reply on ${context.sessionId}: `
                + blocking.map((rule) => rule.id).join(', '));
        }
        return { verdict: VERDICTS.BLOCK, text: '', violations, blocked: true };
    }

    let text = original;
    if (fired.length > 0) text = fired[0].substitute;

    // A spoken reply is one or two short sentences. Anything longer reads as
    // written rather than said.
    if (text.length > 320) {
        text = `${text.slice(0, 300).trim()}...`;
        violations.push({
            id: 'too_long',
            reason: 'The reply was trimmed to sound spoken rather than written.',
            severity: SEVERITY.REWRITE,
        });
    }

    if (violations.length === 0) {
        return { verdict: VERDICTS.PASS, text, violations, blocked: false };
    }

    if (context.sessionId) {
        logger.warn(`outputGuard rewrote a reply on ${context.sessionId}: `
            + violations.map((v) => v.id).join(', '));
    }

    return { verdict: VERDICTS.REWRITE, text, violations, blocked: false };
};

/**
 * The identifiers that must never appear in a reply, for one session.
 *
 * Collected here rather than at the call site so every caller passes the same
 * set, and so adding one later does not mean finding every `review()` call.
 */
const protectedIdentifiersFor = (session, extra = []) => {
    const values = [
        session?.userId,
        session?.userAlias,
        session?.counterpartId,
        ...extra,
    ];
    return [...new Set(values.filter((value) => typeof value === 'string' && value.trim().length >= 5))];
};

/** The content-free stall line used when a draft was blocked twice. */
const safeStall = (language = 'English') => SAFE_STALL[language] || SAFE_STALL.English;

module.exports = {
    review,
    protectedIdentifiersFor,
    safeStall,
    VERDICTS,
    SEVERITY,
    RULES,
    SAFETY_RULE_IDS,
    SAFE_SUBSTITUTES,
    SAFE_STALL,
    IDENTIFIER_DIGITS,
    normalise,
    digitRuns,
    longestRun,
};
