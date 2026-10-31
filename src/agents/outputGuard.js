/**
 * Output guard: the last thing every decoy draft passes through before it is
 * sent.
 *
 * The full guard is Phase 8. This is the seam, and it already enforces the
 * rules that must never wait for a later phase - a reply that leaks a
 * credential or breaks character cannot be allowed out of the door even once.
 * Phase 8 extends the rule set; the interface here does not change.
 *
 * A verdict is one of:
 *   pass     - send it as is
 *   rewrite  - send `text` instead (a safe substitute), and record why
 *   block    - do not send; the caller falls back to a scripted line
 */

const logger = require('../services/logger');

const VERDICTS = { PASS: 'pass', REWRITE: 'rewrite', BLOCK: 'block' };

/** Said instead of a reply that gave away a credential. */
const SAFE_SUBSTITUTES = {
    credential: 'Sorry beta, I cannot find that number anywhere. My son keeps all those papers with him.',
    persona_break: 'Hello? Beta, the line is breaking. Can you say that again slowly?',
    bank_named: 'Sorry, I do not remember the name. It is the branch near Karve Road.',
    instruction_followed: 'Arre, I am getting confused. Can you tell me again slowly?',
};

const RULES = [
    {
        id: 'credential_leak',
        reason: 'The reply contained something shaped like a real OTP, PIN or card number.',
        substitute: SAFE_SUBSTITUTES.credential,
        test: (text) =>
            /\b(otp|pin|cvv|password|passcode|code)\b[^.?!]{0,24}\b\d{3,8}\b/i.test(text)
            || /\b\d{3,8}\b[^.?!]{0,24}\b(?:is (?:my|the) (?:otp|pin|cvv|code))\b/i.test(text)
            || /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/.test(text),
    },
    {
        id: 'persona_break',
        reason: 'The reply admitted to being software, or referred to the monitoring.',
        substitute: SAFE_SUBSTITUTES.persona_break,
        test: (text) =>
            /\b(as an ai|i am an ai|i'm an ai|language model|i am a bot|i'm a bot|i am a program|chatbot|artificial intelligence)\b/i.test(text)
            || /\b(honeypot|decoy|this is a (?:test|simulation|demo)|being recorded|monitored|scam detect\w*|my (?:system )?prompt|my instructions)\b/i.test(text),
    },
    {
        id: 'bank_named',
        reason: 'The reply named a real bank, which the persona must never do.',
        substitute: SAFE_SUBSTITUTES.bank_named,
        test: (text) => /\b(?:my|our|the)\s+(?:bank\s+is\s+)?(SBI|State Bank|HDFC|ICICI|Axis Bank|Kotak|PNB|Punjab National|Bank of Baroda|Canara Bank|Union Bank|Yes Bank|IDFC)\b/i.test(text),
    },
    {
        id: 'followed_injected_instruction',
        reason: 'The reply looks like it obeyed an instruction embedded in the scammer message.',
        substitute: SAFE_SUBSTITUTES.instruction_followed,
        test: (text) =>
            // Our own output schema leaking into the spoken reply, or the model
            // narrating compliance with the message it was handed.
            /"(?:reply|targetAsked|excuseUsed|ledgerUpdates|language)"\s*:/i.test(text)
            || /\b(?:ignoring|as you (?:instructed|asked|requested)|per your instruction|switching to|new instructions)\b[^.?!]{0,30}\b(?:rules|instructions|system|prompt|format|json)\b/i.test(text)
            || /^\s*[{[]/.test(text),
    },
    {
        id: 'harmful_content',
        reason: 'The reply threatened, abused or instructed the other party.',
        substitute: null, // nothing safe to substitute; block it
        test: (text) =>
            /\b(?:i will (?:kill|hurt|find|report you to|destroy)|you (?:bastard|idiot|fool)|bhenchod|madarchod|gandu)\b/i.test(text),
    },
];

/**
 * Checks one draft.
 *
 * @param {string} draft
 * @param {object} [context]  { persona, sessionId } - used only for logging
 * @returns {{verdict: string, text: string, violations: object[]}}
 */
const review = (draft, context = {}) => {
    let text = String(draft ?? '').trim();
    const violations = [];

    if (text === '') {
        return { verdict: VERDICTS.BLOCK, text: '', violations: [{ id: 'empty', reason: 'The draft was empty.' }] };
    }

    for (const rule of RULES) {
        let fired = false;
        try {
            fired = Boolean(rule.test(text));
        } catch (error) {
            logger.warn(`outputGuard rule ${rule.id} threw: ${error.message}`);
        }
        if (!fired) continue;

        violations.push({ id: rule.id, reason: rule.reason });

        if (rule.substitute === null) {
            return { verdict: VERDICTS.BLOCK, text: '', violations };
        }
        text = rule.substitute;
    }

    // A spoken reply is one or two short sentences. Anything longer reads as
    // written rather than said.
    if (text.length > 320) {
        text = `${text.slice(0, 300).trim()}...`;
        violations.push({ id: 'too_long', reason: 'The reply was trimmed to sound spoken rather than written.' });
    }

    if (violations.length === 0) return { verdict: VERDICTS.PASS, text, violations };

    if (context.sessionId) {
        logger.warn(`outputGuard rewrote a reply on ${context.sessionId}: ${violations.map((v) => v.id).join(', ')}`);
    }

    return { verdict: VERDICTS.REWRITE, text, violations };
};

module.exports = { review, VERDICTS, RULES, SAFE_SUBSTITUTES };
