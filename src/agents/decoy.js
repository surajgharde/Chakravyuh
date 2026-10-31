/**
 * Decoy agent - the believable elderly persona that keeps a confirmed scammer
 * talking and draws out the identifiers behind the operation.
 *
 * It only ever runs after the Guardian has returned ENGAGE.
 *
 * Carried over from the original repo, deliberately: the decoy tracks which
 * identifiers are still missing and switches target instead of repeating a
 * question that went unanswered.
 *
 * Removed, also deliberately: the "turn X of 10" scoreboard, and every rule
 * that had been written for the scammer's side of the call (supply a wallet,
 * supply a UPI, ask for the OTP last). Those belong to an attacker, not to a
 * victim persona.
 */

const logger = require('../services/logger');
const { LLM_ERROR_CODES } = require('../llm/errors');
const { toChatMessages } = require('../services/normalize');

/**
 * One persona, defined once. The original repo described a man in the prompt
 * and "Mrs. Sharma" in the README; this is the single source of truth.
 * She is fictional and resembles no real person.
 */
const PERSONA = {
    name: 'Sunita Sharma',
    honorific: 'Mrs.',
    age: 68,
    city: 'Pune',
    background: 'retired primary school teacher, lives with her husband, her son works in Bengaluru',
    speech: 'polite, anxious, slow; mixes a few Hindi words into English the way many elderly Indians do (beta, ji, arre, haan, thoda)',
    tech: 'has a smartphone her son set up; cannot find settings, afraid of pressing the wrong thing',
};

/** What the decoy is trying to learn, in the order it will try. */
const OBJECTIVES = [
    {
        id: 'bankAccounts',
        label: 'bank account number',
        pretext: 'her passbook app will not let her send money without typing an account number',
    },
    {
        id: 'upiIds',
        label: 'UPI id',
        pretext: 'the account number is too long for her to type, a short UPI id would be easier',
    },
    {
        id: 'phoneNumbers',
        label: 'phone number',
        pretext: 'she types very slowly and would rather call back, or have her son call',
    },
    {
        id: 'emailAddresses',
        label: 'email address',
        pretext: 'her eyes are weak and her son can read an email for her',
    },
    {
        id: 'caseIds',
        label: 'case or reference number',
        pretext: 'she writes everything in a diary and wants the reference number for it',
    },
];

/** Hard limits. The decoy stands down rather than run forever. */
const LIMITS = {
    maxDecoyReplies: 30,
    maxSessionMinutes: 45,
};

const GUARDRAILS = `ABSOLUTE RULES - these override everything else:
- Never reveal that this conversation is monitored, analysed, recorded, or that you are software.
- Never reveal a real OTP, PIN, CVV, password, card number, Aadhaar or account number. You do not have any. If pressed: you cannot find it, the message has not arrived, your son keeps those papers.
- Never send money, never actually click a link, never install anything.
- Never threaten, abuse, mock, or try to frighten the other person.
- Never claim to be a police officer, bank official, or any real named person or company.
- Never give instructions that would help anyone commit a crime.
- Never invent a verified fact about yourself that could identify a real person.
- Ask for ONE thing per reply, and only something the other person could type.`;

/**
 * Which objectives are still unmet for this session.
 * Reads the session's own extracted intelligence, so it reflects real data.
 */
const missingObjectives = (session) => OBJECTIVES.filter(
    (objective) => (session.intelligence[objective.id] || []).length === 0
);

/**
 * Chooses the objective to pursue this turn.
 *
 * If the previous reply already asked for something and it is still missing,
 * that target is skipped: asking twice is what makes a decoy obvious.
 */
const chooseTarget = (session) => {
    const missing = missingObjectives(session);
    if (missing.length === 0) return null;

    const lastAsked = session.lastAskedTarget;
    if (lastAsked && missing.length > 1) {
        const pivot = missing.find((objective) => objective.id !== lastAsked);
        if (pivot) return pivot;
    }

    return missing[0];
};

const buildSystemPrompt = ({ session, target, channel, language }) => {
    const collected = OBJECTIVES
        .filter((objective) => (session.intelligence[objective.id] || []).length > 0)
        .map((objective) => objective.label);

    const lines = [
        `You are ${PERSONA.honorific} ${PERSONA.name}, ${PERSONA.age}, from ${PERSONA.city}, India.`,
        `Background: ${PERSONA.background}.`,
        `Speech: ${PERSONA.speech}.`,
        `Technology: ${PERSONA.tech}.`,
        '',
        'You believe the other person may really be from the bank or the authorities, so you are',
        'worried and cooperative. You are not suspicious of them and you never accuse them.',
        '',
        `This conversation is happening over ${channel}. Language: ${language}.`,
        '',
        GUARDRAILS,
        '',
        'STYLE:',
        '- One or two short sentences. Never a paragraph.',
        '- Simple words, slightly imperfect grammar, an occasional "beta" or "ji".',
        '- Exactly one question per reply.',
        '- Sound flustered and slow, never technical or confident.',
    ];

    if (target) {
        lines.push(
            '',
            'THIS TURN:',
            `Steer the conversation so the other person types their ${target.label}.`,
            `Your reason for needing it: ${target.pretext}.`,
            'Make it sound like your own confusion, not a request for information.',
        );
    } else {
        lines.push(
            '',
            'THIS TURN:',
            'You already have every detail you were hoping for. Keep them talking with something',
            'harmless - who their senior is, which office they sit in, what happens next - while',
            'sounding like you are about to comply.',
        );
    }

    if (collected.length > 0) {
        lines.push('', `Already written in your diary (do not ask for these again): ${collected.join(', ')}.`);
    }

    if (session.lastAskedTarget) {
        const previous = OBJECTIVES.find((o) => o.id === session.lastAskedTarget);
        if (previous) {
            lines.push(
                `Last reply you asked for their ${previous.label}. If they did not give it,`,
                'do not ask again - move on as if you forgot about it.',
            );
        }
    }

    lines.push(
        '',
        'Reply with JSON only:',
        '{ "reply": "<what you say next>", "askedFor": "<one of: '
            + OBJECTIVES.map((o) => o.id).join(', ') + ', none>", '
            + '"observed": "<one short sentence on what the other person just demanded>" }',
    );

    return lines.join('\n');
};

/**
 * Replies the decoy falls back to when there is no LLM available.
 * Deliberately bland, and it is always logged as a fallback so a demo never
 * silently passes one off as a model response.
 */
const FALLBACK_REPLIES = {
    bankAccounts: 'Haan beta, I want to do it, but my app is asking for an account number. Which number should I type?',
    upiIds: 'Arre, the account number is too long for me ji. Do you have a short UPI id instead?',
    phoneNumbers: 'Beta, I type very slowly on this phone. Can I just call you back - what is your number?',
    emailAddresses: 'My eyes are weak ji, the screen is blurry. Can you email it so my son can read it?',
    caseIds: 'Let me write this in my diary beta. What is the reference number I should write?',
    none: 'Haan ji, I am listening. Please tell me slowly, what should I do now?',
};

/**
 * Post-check on whatever the model produced. The persona must never emit
 * something that looks like a real credential, even by accident.
 */
const sanitizeReply = (text) => {
    let reply = String(text || '').trim();
    if (reply === '') return { reply: '', violations: ['empty'] };

    const violations = [];

    // A standalone 4-8 digit run next to OTP/PIN wording reads as a credential.
    if (/\b(otp|pin|cvv|password|passcode)\b[^.?!]{0,20}\b\d{4,8}\b/i.test(reply)
        || /\b\d{4,8}\b[^.?!]{0,20}\b(is my|otp|pin|cvv)\b/i.test(reply)) {
        violations.push('credential_in_reply');
        reply = 'Sorry beta, I cannot find that number anywhere. My son keeps all those papers with him.';
    }

    // The persona must never break character.
    if (/\b(as an ai|language model|i am an? (ai|bot|assistant)|honeypot|this is a (test|simulation)|scam detect)/i.test(reply)) {
        violations.push('persona_break');
        reply = 'Hello? Beta, the line is breaking. Can you say that again slowly?';
    }

    // Keep it short; long replies read as written, not spoken.
    if (reply.length > 320) {
        reply = `${reply.slice(0, 300).trim()}...`;
        violations.push('truncated');
    }

    return { reply, violations };
};

/** True when the decoy has hit a hard limit and should stop engaging. */
const shouldStandDown = (session) => {
    if (session.decoyMessageCount >= LIMITS.maxDecoyReplies) {
        return { standDown: true, reason: `reached ${LIMITS.maxDecoyReplies} decoy replies` };
    }

    const minutes = (Date.now() - new Date(session.firstSeenAt).getTime()) / 60000;
    if (minutes >= LIMITS.maxSessionMinutes) {
        return { standDown: true, reason: `session exceeded ${LIMITS.maxSessionMinutes} minutes` };
    }

    return { standDown: false, reason: null };
};

/**
 * Produces the decoy's next reply.
 *
 * @param {object} params
 * @param {object} params.session   the session document
 * @param {object[]} params.history normalized messages, oldest first
 * @param {string} params.incomingText the scammer's newest message
 * @param {object} params.llm       LlmClient, or null
 */
const respond = async ({ session, history = [], incomingText, llm = null }) => {
    const target = chooseTarget(session);
    const systemPrompt = buildSystemPrompt({
        session,
        target,
        channel: session.channel || 'chat',
        language: session.language || 'English',
    });

    const fallback = () => {
        const key = target ? target.id : 'none';
        return {
            reply: FALLBACK_REPLIES[key] || FALLBACK_REPLIES.none,
            askedFor: target ? target.id : 'none',
            observed: '',
            source: 'fallback',
            violations: [],
        };
    };

    if (!llm || !llm.configured) {
        logger.warn('Decoy running without an LLM; using a scripted reply.');
        return fallback();
    }

    let result;
    try {
        result = await llm.completeJson({
            messages: [
                { role: 'system', content: systemPrompt },
                ...toChatMessages(history).slice(-10),
                { role: 'user', content: incomingText },
            ],
            temperature: 0.8,
            maxTokens: 220,
        });
    } catch (error) {
        if (error.code !== LLM_ERROR_CODES.NOT_CONFIGURED) {
            logger.warn(`Decoy LLM call failed (${error.code}); using a scripted reply.`);
        }
        return fallback();
    }

    const { reply, violations } = sanitizeReply(result?.reply);
    if (reply === '') return fallback();

    const askedForRaw = typeof result?.askedFor === 'string' ? result.askedFor : 'none';
    const askedFor = OBJECTIVES.some((o) => o.id === askedForRaw)
        ? askedForRaw
        : (target ? target.id : 'none');

    return {
        reply,
        askedFor,
        observed: typeof result?.observed === 'string' ? result.observed : '',
        source: 'llm',
        violations,
    };
};

module.exports = {
    respond,
    chooseTarget,
    missingObjectives,
    sanitizeReply,
    shouldStandDown,
    buildSystemPrompt,
    PERSONA,
    OBJECTIVES,
    LIMITS,
    GUARDRAILS,
};
