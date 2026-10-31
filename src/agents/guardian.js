/**
 * Guardian agent - watches the conversation and decides whether the decoy
 * takes over.
 *
 * Detection is two layers:
 *   1. A deterministic signal table (below). Each rule that fires contributes a
 *      fixed, documented weight. This runs with no LLM key and no network.
 *   2. An optional LLM verdict on intent, which can only nudge the score.
 *
 * `confidence` is the sum of those weights, clamped to 0..1. No part of it is
 * invented by the model and it never starts from a floor.
 *
 * Three outcomes, so a legitimate caller is never baited:
 *   PASS    - nothing to act on; the decoy is not involved.
 *   WATCH   - suspicious but unproven; keep listening, still no bait.
 *   ENGAGE  - hand off to the decoy.
 *
 * ENGAGE additionally requires at least one HARD signal, so urgency or worry
 * alone - which a real bank or hospital call also carries - cannot trigger it.
 */

const logger = require('../services/logger');
const { LLM_ERROR_CODES } = require('../llm/errors');

const STAGES = { PASS: 'pass', WATCH: 'watch', ENGAGE: 'engage' };

// A signal is HARD when, on its own, it has no routine legitimate explanation.
const SIGNALS = [
    {
        id: 'otp_or_pin_request',
        hard: true,
        weight: 0.45,
        description: 'Asks for an OTP, PIN, CVV or password',
        test: (t) => /\b(otp|one[\s-]?time[\s-]?password|pin|cvv|card\s*number|password|passcode)\b/i.test(t)
            && /\b(share|send|sent|tell|give|provide|enter|type|confirm|read|forward|need|what\s+is)\b/i.test(t),
    },
    {
        id: 'remote_access_request',
        hard: true,
        weight: 0.40,
        description: 'Asks to install an app or grant screen/remote access',
        test: (t) => /\b(anydesk|teamviewer|quicksupport|apk|screen[\s-]?shar\w*|remote\s*access)\b/i.test(t)
            || /\b(install|download)\b[^.?]{0,30}\b(app|apk|file|software|tool)\b/i.test(t),
    },
    {
        id: 'arrest_or_legal_threat',
        hard: true,
        weight: 0.40,
        description: 'Threatens arrest, FIR or legal action to force compliance',
        test: (t) => /\b(arrest|warrant|fir|non[\s-]?bailable|custody|court\s*case|digital\s*arrest|cbi|narcotics)\b/i.test(t)
            || /\bcustoms\b[^.?]{0,30}\b(seiz\w*|parcel|held)\b/i.test(t),
    },
    {
        id: 'payment_redirect',
        hard: true,
        weight: 0.35,
        description: 'Directs money to an account, UPI id or wallet',
        test: (t) => /\b(transfer|send|deposit|pay|remit|credit)\b[^.?]{0,60}\b(upi|account|a\/c|wallet|bitcoin|usdt|qr|scan)\b/i.test(t)
            || /\b(upi\s*id|account\s*number|a\/c\s*no)\b[^.?]{0,20}[:\-]/i.test(t),
    },
    {
        id: 'credential_phishing_link',
        hard: true,
        weight: 0.30,
        description: 'Link paired with a verification or login instruction',
        test: (t) => /https?:\/\/\S+/i.test(t)
            && /\b(verify|verification|kyc|update|re[\s-]?activat\w*|login|log\s*in|unblock|claim|confirm)\b/i.test(t),
    },

    {
        id: 'urgency_pressure',
        hard: false,
        weight: 0.15,
        description: 'Artificial deadline or final-warning framing',
        test: (t) => /\b(immediately|right\s+now|today\s+itself|last\s+warning|final\s+notice)\b/i.test(t)
            || /\bwithin\s+\d+\s*(min\w*|hour\w*|hrs)\b/i.test(t)
            || /\bexpir\w*\s+(today|now|in)\b/i.test(t),
    },
    {
        id: 'secrecy_instruction',
        hard: false,
        weight: 0.20,
        description: 'Tells the target to keep it secret or stay on the line',
        test: (t) => /\b(do\s*n.?t\s+(tell|inform|disconnect|hang\s*up|cut)|without\s+telling|keep\s+(this|it)\s+(secret|confidential)|stay\s+on\s+the\s+(line|call))\b/i.test(t),
    },
    {
        id: 'authority_claim',
        hard: false,
        weight: 0.15,
        description: 'Unverified claim to represent a bank, telecom or government body',
        test: (t) => /\b(i\s+am|this\s+is|calling\s+from|on\s+behalf\s+of)\b[^.?]{0,40}\b(sbi|hdfc|icici|axis|kotak|bank|rbi|trai|income\s+tax|police|cyber\s*(cell|crime)|department|electricity\s+board|government)\b/i.test(t),
    },
    {
        id: 'account_threat',
        hard: false,
        weight: 0.15,
        description: 'Threatens that an account or service will be blocked',
        test: (t) => /\b(block\w*|suspend\w*|deactivat\w*|freez\w*|terminat\w*|disconnect\w*)\b[^.?]{0,40}\b(account|number|sim|connection|card|service|kyc)\b/i.test(t)
            || /\b(account|kyc|sim|card)\b[^.?]{0,40}\b(block\w*|suspend\w*|deactivat\w*|freez\w*)\b/i.test(t),
    },
    {
        id: 'prize_lure',
        hard: false,
        weight: 0.20,
        description: 'Unsolicited prize, refund, cashback or guaranteed return',
        test: (t) => /\b(you\s+have\s+won|congratulations|lucky\s+winner|lottery|jackpot|cashback|guaranteed\s+return|double\s+your|claim\s+your)\b/i.test(t)
            || /\brefund\b[^.?]{0,20}\b(pending|approved|ready|initiated)\b/i.test(t),
    },
    {
        id: 'fee_before_benefit',
        hard: false,
        weight: 0.20,
        description: 'Asks for a fee, charge or tax before releasing a benefit',
        test: (t) => /\b(processing\s+fee|service\s+charge|clearance\s+fee|security\s+deposit|registration\s+(fee|amount)|refundable\s+amount)\b/i.test(t),
    },
];

// Signals that point the other way. A legitimate caller tends to produce these.
const EXCULPATORY = [
    {
        id: 'explicit_no_otp_advisory',
        weight: -0.35,
        description: 'States that it will never ask for an OTP or PIN - standard bank advisory',
        test: (t) => /\b(never\s+(ask|share|request)|will\s+not\s+ask|do\s+not\s+share|no\s+one\s+from)\b[^.?]{0,40}\b(otp|pin|cvv|password)\b/i.test(t),
    },
    {
        id: 'verifiable_callback_offered',
        weight: -0.20,
        description: 'Invites the target to call the official number on their card or website',
        test: (t) => /\b(number\s+(printed\s+)?on\s+(your|the)\s+card|nearest\s+branch|official\s+website|toll[\s-]?free\s+number)\b/i.test(t)
            || /\bcall\s+(us\s+)?back\s+on\s+the\s+(number|helpline)\b/i.test(t),
    },
];

/**
 * Signals derived from script stage tags rather than from the English text
 * patterns above.
 *
 * The signal table is written in English, so a scam run in Hindi or Marathi
 * scored far too low: a romanised Marathi digital-arrest script with a mule
 * account in it reached only 0.50 and stalled at WATCH. The stage tagger
 * (services/stages.js) has vocabularies for all three languages, so reusing
 * its output makes detection language-agnostic.
 *
 * `unless` names the text signals that cover the same ground. A stage signal
 * only contributes when none of them fired, so an English message is never
 * counted twice for the same behaviour.
 */
const STAGE_SIGNALS = [
    {
        id: 'stage_credential_request',
        hard: true,
        weight: 0.40,
        description: 'Script stage: asks for a credential or remote access',
        requires: ['CREDENTIAL_REQUEST'],
        unless: ['otp_or_pin_request', 'remote_access_request'],
    },
    {
        id: 'stage_payment_under_pressure',
        hard: true,
        weight: 0.35,
        description: 'Script stage: demands payment alongside a threat or an accusation',
        requires: ['PAYMENT_DEMAND'],
        requiresAny: ['THREAT', 'ACCUSATION', 'ISOLATION'],
        unless: ['payment_redirect'],
    },
    {
        id: 'stage_accusation_and_threat',
        hard: true,
        weight: 0.40,
        description: 'Script stage: accuses the target of a crime and threatens consequences',
        requires: ['ACCUSATION', 'THREAT'],
        unless: ['arrest_or_legal_threat'],
    },
    {
        id: 'stage_isolation',
        hard: false,
        weight: 0.20,
        description: 'Script stage: isolates the target from family or keeps them on the line',
        requires: ['ISOLATION'],
        unless: ['secrecy_instruction'],
    },
    {
        id: 'stage_authority_claim',
        hard: false,
        weight: 0.15,
        description: 'Script stage: claims to represent an institution',
        requires: ['AUTHORITY_CLAIM'],
        unless: ['authority_claim'],
    },
    {
        id: 'stage_urgency',
        hard: false,
        weight: 0.15,
        description: 'Script stage: imposes a deadline',
        requires: ['URGENCY'],
        unless: ['urgency_pressure'],
    },
    {
        id: 'stage_verification_lure',
        hard: false,
        weight: 0.20,
        description: 'Script stage: frames the payment as safe or refundable',
        requires: ['VERIFICATION_LURE'],
        unless: ['fee_before_benefit'],
    },
];

const WEIGHTS = {
    // The LLM can move the score, but never decide alone.
    llmScam: 0.20,
    llmLegitimate: -0.30,
    volunteeredIdentifier: 0.10,
};

const THRESHOLDS = {
    engage: 0.60, // plus at least one hard signal
    watch: 0.25,
};

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const round2 = (n) => Math.round(n * 100) / 100;

/** Maps a confidence to a stage. ENGAGE additionally requires a hard signal. */
const stageFor = (confidence, hasHardSignal) => {
    if (confidence >= THRESHOLDS.engage && hasHardSignal) return STAGES.ENGAGE;
    if (confidence >= THRESHOLDS.watch) return STAGES.WATCH;
    return STAGES.PASS;
};

/** Runs the deterministic layer over the scammer-side text of a session. */
const scoreSignals = (text) => {
    const fired = [];
    let score = 0;

    for (const signal of [...SIGNALS, ...EXCULPATORY]) {
        if (signal.test(text)) {
            fired.push({
                id: signal.id,
                hard: Boolean(signal.hard),
                weight: signal.weight,
                description: signal.description,
            });
            score += signal.weight;
        }
    }

    return { score, fired };
};

const CLASSIFIER_PROMPT = `You are a fraud analyst protecting an elderly person in India.
You receive the incoming side of a conversation. Judge the SENDER's intent.

Reply with JSON only:
{
  "intent": "scam" | "legitimate" | "unclear",
  "scamType": "bank_fraud" | "upi_fraud" | "digital_arrest" | "phishing" | "investment_scam" | "advance_fee_fraud" | "job_scam" | "lottery_scam" | "tech_support_scam" | "unknown",
  "rationale": "one short sentence citing what the sender actually said"
}

Rules:
- "legitimate" is a real answer. Delivery agents, pharmacies, clinics, relatives
  and genuine bank advisories are legitimate even when they sound urgent.
- Judge only what the sender said. Do not assume fraud because you were asked.
- Answer "unclear" when there is not enough to decide.`;

/**
 * Asks the LLM for an intent verdict. Never throws: a failed or absent LLM
 * leaves detection running on the deterministic layer alone.
 */
const classifyWithLlm = async (llm, conversationText) => {
    if (!llm || !llm.configured) {
        return { intent: 'unavailable', scamType: 'unknown', rationale: 'LLM not configured.' };
    }

    try {
        const verdict = await llm.completeJson({
            messages: [
                { role: 'system', content: CLASSIFIER_PROMPT },
                { role: 'user', content: conversationText },
            ],
            temperature: 0,
            maxTokens: 200,
        });

        const intent = ['scam', 'legitimate', 'unclear'].includes(verdict && verdict.intent)
            ? verdict.intent
            : 'unclear';

        return {
            intent,
            scamType: typeof verdict?.scamType === 'string' ? verdict.scamType : 'unknown',
            rationale: typeof verdict?.rationale === 'string' ? verdict.rationale : '',
        };
    } catch (error) {
        if (error.code !== LLM_ERROR_CODES.NOT_CONFIGURED) {
            logger.warn(`Guardian classifier unavailable (${error.code}); using rules only.`);
        }
        return { intent: 'unavailable', scamType: 'unknown', rationale: `Classifier unavailable: ${error.code}` };
    }
};

/**
 * Which family of scam this looks like. Classification lives here rather than
 * in the extractor: it is a judgement about the conversation, not an identifier
 * found in it.
 */
const SCAM_TYPE_PATTERNS = {
    digital_arrest: /\b(cbi|narcotics|ncb|arrest|warrant|fir|custody|enforcement directorate|money laundering)\b/i,
    upi_fraud: /\b(upi|vpa|paytm|gpay|google pay|phonepe|collect request|qr code|cashback)\b/i,
    bank_fraud: /\b(sbi|hdfc|icici|axis|kotak|bank|account|kyc|debit card|credit card|net banking|rbi)\b/i,
    tech_support_scam: /\b(anydesk|teamviewer|quicksupport|remote access|screen shar\w*|virus|technician)\b/i,
    investment_scam: /\b(investment|trading|profit|returns|crypto|bitcoin|usdt|portfolio|ipo)\b/i,
    lottery_scam: /\b(lottery|lucky draw|jackpot|you have won|prize|kbc)\b/i,
    job_scam: /\b(work from home|part time job|task based|registration fee|joining fee|placement)\b/i,
    courier_scam: /\b(fedex|dhl|bluedart|dtdc|courier|parcel|consignment|customs)\b/i,
    utility_scam: /\b(electricity|mseb|mahavitaran|bijli|meter|bill payment|connection will be)\b/i,
    phishing: /\b(click|link|verify|login|update your|http)\b/i,
};

/** Picks the most specific matching scam family, or 'unknown'. */
const classifyScamType = (text) => {
    for (const [type, pattern] of Object.entries(SCAM_TYPE_PATTERNS)) {
        if (pattern.test(text)) return type;
    }
    return 'unknown';
};

/** Identifier fields that count as a volunteered payment route. */
const PAYMENT_ROUTE_FIELDS = ['upiIds', 'bankAccounts', 'phishingLinks', 'apkLinks', 'cryptoWallets', 'ifscCodes'];

/**
 * Assesses a session.
 *
 * @param {object}   params
 * @param {string}   params.incomingText          the newest scammer-side message
 * @param {object[]} params.priorScammerMessages  earlier scammer-side messages
 * @param {object}   params.llm                   LlmClient, or null
 * @param {object}   params.summary               the session's flat identifier lists
 * @param {string[]} params.scriptStages          script stages seen so far
 */
const assess = async ({
    incomingText,
    priorScammerMessages = [],
    llm = null,
    summary = null,
    scriptStages = [],
}) => {
    // Signals are scored over the whole scammer side: tactics build up across turns.
    const corpus = [...priorScammerMessages.map((m) => m.text), incomingText].join('\n');

    const { score: ruleScore, fired } = scoreSignals(corpus);
    let score = ruleScore;

    // Stage-derived signals, so a scam in Hindi or Marathi scores like the
    // same scam in English.
    const firedIds = new Set(fired.map((s) => s.id));
    for (const signal of STAGE_SIGNALS) {
        if (signal.unless.some((id) => firedIds.has(id))) continue;
        if (!signal.requires.every((stage) => scriptStages.includes(stage))) continue;
        if (signal.requiresAny && !signal.requiresAny.some((stage) => scriptStages.includes(stage))) continue;

        fired.push({
            id: signal.id,
            hard: signal.hard,
            weight: signal.weight,
            description: signal.description,
        });
        score += signal.weight;
    }

    // An identifier the sender volunteered is corroboration, not a tactic on its own.
    const volunteered = Boolean(summary
        && PAYMENT_ROUTE_FIELDS.some((field) => (summary[field] || []).length > 0));

    if (volunteered) {
        score += WEIGHTS.volunteeredIdentifier;
        fired.push({
            id: 'volunteered_identifier',
            hard: false,
            weight: WEIGHTS.volunteeredIdentifier,
            description: 'Sender volunteered a payment identifier or link',
        });
    }

    const hasHardSignal = fired.some((s) => s.hard);

    // Staged deliberately in two steps so the demo can show what the rules
    // alone concluded and what the classifier then did to that conclusion.
    const ruleConfidence = clamp01(score);
    const ruleStage = stageFor(ruleConfidence, hasHardSignal);

    const llmVerdict = await classifyWithLlm(llm, corpus);
    if (llmVerdict.intent === 'scam') score += WEIGHTS.llmScam;
    if (llmVerdict.intent === 'legitimate') score += WEIGHTS.llmLegitimate;

    const confidence = clamp01(score);
    let stage = stageFor(confidence, hasHardSignal);

    // An explicit "legitimate" verdict vetoes hand-off outright, even if the
    // rules still add up: missing a scam costs less than baiting a real caller.
    if (llmVerdict.intent === 'legitimate') {
        if (stage === STAGES.ENGAGE) stage = STAGES.WATCH;
        if (ruleStage === STAGES.ENGAGE) {
            fired.push({
                id: 'handoff_blocked_by_classifier',
                hard: false,
                weight: 0,
                description: 'Classifier judged the sender legitimate; hand-off withheld',
            });
        }
    }

    const ruleScamType = classifyScamType(corpus);
    const scamType = ruleScamType !== 'unknown' ? ruleScamType : llmVerdict.scamType;

    return {
        stage,
        isScam: stage === STAGES.ENGAGE,
        confidence: round2(confidence),
        // What the deterministic layer concluded on its own, before the classifier.
        ruleConfidence: round2(ruleConfidence),
        ruleStage,
        hasHardSignal,
        signals: fired,
        signalIds: fired.map((s) => s.id),
        scamType: scamType || 'unknown',
        classifier: llmVerdict,
        rationale: fired.length ? fired.map((s) => s.description).join('; ') : 'No scam signals fired.',
    };
};

module.exports = {
    assess,
    scoreSignals,
    classifyWithLlm,
    classifyScamType,
    STAGES,
    SIGNALS,
    STAGE_SIGNALS,
    EXCULPATORY,
    THRESHOLDS,
    WEIGHTS,
    SCAM_TYPE_PATTERNS,
};
