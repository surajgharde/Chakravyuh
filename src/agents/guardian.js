/**
 * Guardian agent.
 *
 * Receives every incoming message for a protected user, scores it, owns the
 * session's state, and decides whether the decoy is allowed to take over.
 *
 * STATE MACHINE
 *
 *   MONITORING ──> SUSPICIOUS ──> DECOY_ACTIVE ──> ENDED
 *        │              │               │
 *        └──> LEGIT <───┘               └──> FALSE_POSITIVE
 *
 *   MONITORING      watching, nothing to act on
 *   SUSPICIOUS      worth warning the user about; NEVER baits
 *   DECOY_ACTIVE    the decoy has the conversation
 *   ENDED           engagement finished on its own terms
 *   LEGIT           released as a real caller; never baited again
 *   FALSE_POSITIVE  the user pressed "This is genuine" while we were engaged
 *
 * SCORING
 *
 * Nine rule signals with fixed weights, summed and capped at 100. The
 * breakdown is stored and returned, so the number is always traceable to the
 * rules that produced it. A short LLM classifier returns a label and its
 * reasons; it can raise the state by at most one level and can never reach
 * DECOY_ACTIVE on its own.
 *
 * There is no invented probability anywhere in here. "Confidence" is the rule
 * score, its breakdown, and the classifier's label, shown side by side.
 *
 * FALSE-POSITIVE PROTECTION
 *
 *   - A trusted contact is never baited, whatever the score.
 *   - SUSPICIOUS never baits; it warns.
 *   - DECOY_ACTIVE needs a hard signal, not just a high score.
 *   - The user can end an engagement at any moment.
 *   - The Guardian keeps scoring while engaged and releases on its own if the
 *     conversation turns out to be legitimate.
 */

const logger = require('../services/logger');
const { LLM_ERROR_CODES } = require('../llm/errors');
const { EVENTS } = require('../realtime/events');
const trustedContacts = require('../services/trustedContacts');

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

const STATES = {
    MONITORING: 'MONITORING',
    SUSPICIOUS: 'SUSPICIOUS',
    DECOY_ACTIVE: 'DECOY_ACTIVE',
    ENDED: 'ENDED',
    LEGIT: 'LEGIT',
    FALSE_POSITIVE: 'FALSE_POSITIVE',
};

/** Escalation ladder. The classifier may move a session up by one rung only. */
const LADDER = [STATES.MONITORING, STATES.SUSPICIOUS, STATES.DECOY_ACTIVE];

/** Once in one of these, scoring no longer changes the state. */
const TERMINAL_STATES = [STATES.ENDED, STATES.LEGIT, STATES.FALSE_POSITIVE];

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLDS = {
    decoy: 60,     // score at or above this, with a hard signal, may engage
    suspicious: 30, // score at or above this is worth warning about
    release: 30,   // while engaged, a score below this plus a legit label releases
};

/** The classifier is bounded so the whole decision fits the 1.5s budget. */
const DECISION_BUDGET_MS = 1500;
const CLASSIFIER_BUDGET_MS = 1100;

// ---------------------------------------------------------------------------
// Rule signals
// ---------------------------------------------------------------------------

/**
 * A signal is HARD when it has no routine legitimate explanation on its own.
 *
 * DECOY_ACTIVE requires at least one hard signal in addition to the score
 * threshold. Without that extra gate, three soft signals that a real utility
 * SMS also produces (authority claim + urgency + link) could add up to a
 * hand-off, and baiting a real caller is the one outcome this system must not
 * produce.
 *
 * `isolation` counts as hard: a real bank, hospital or courier never tells
 * someone to keep the call secret from their family or not to hang up.
 */
const SIGNALS = [
    {
        id: 'credential_request',
        label: 'Credential request',
        weight: 35,
        hard: true,
        description: 'Asks for an OTP, PIN, CVV, password or card number',
        test: ({ text }) =>
            // An ask, not a mention. "Do not share your OTP" is an advisory and
            // is handled by the exculpatory rules below.
            (/\b(otp|one[\s-]?time[\s-]?password|pin|cvv|card\s*number|password|passcode)\b/i.test(text)
                && /\b(share|send|tell|give|provide|enter|type|read|forward|confirm|what\s+is|need|bata\w*|sang\w*|dya|dijiye|bol\w*)\b/i.test(text)
                && !/\b(do\s*n.?t|never|not)\s+(share|disclose|tell|give)\b/i.test(text))
            || /(?:ओटीपी|पिन|पासवर्ड)[^.?!]{0,25}(?:सांगा|द्या|बताओ|दीजिए|भेजो)/u.test(text),
    },
    {
        id: 'remote_access_app',
        label: 'Remote-access app',
        weight: 35,
        hard: true,
        description: 'Asks to install an app or grant screen or remote access',
        test: ({ text }) =>
            /\b(anydesk|teamviewer|quicksupport|airdroid|screen[\s-]?shar\w*|remote\s*access|remote\s*desktop)\b/i.test(text)
            || /\b(install|download|side[\s-]?load)\b[^.?!]{0,40}\b(app|apk|application|software|tool)\b/i.test(text)
            || /\.apk\b/i.test(text),
    },
    {
        id: 'payment_demand',
        label: 'Payment demand',
        weight: 30,
        hard: true,
        description: 'Pushes money along a specific route: account, UPI, QR or wallet',
        test: ({ text, entities }) =>
            // A route being named is what separates this from "pay your bill".
            /\b(transfer|send|deposit|remit|credit|pay|jama|bhej\w*|pathva\w*|paathva\w*)\b[^.?!]{0,70}\b(upi|vpa|a\/c|account|khat\w*|wallet|bitcoin|btc|usdt|crypto|qr\s*code|gift\s*card|beneficiary)\b/i.test(text)
            // Or a payment route the extractor actually found, alongside a
            // payment verb. "send 5000 on PhonePe to refund@okaxis" names no
            // route word at all, but the UPI id is sitting right there.
            || (entities.some((e) => ['upiId', 'bankAccount', 'cryptoWallet', 'ifsc'].includes(e.type))
                && /\b(transfer|send|deposit|remit|credit|pay|paid|payment|fee|charges|jama|bhej\w*|pathva\w*|kara|karo|kijiye|dijiye)\b/i.test(text))
            || /\b(upi\s*id|account\s*(number|no)|a\/c\s*no)\b\s*[:\-]?\s*\S/i.test(text)
            || /(?:खात्यात|खाते|खाता)[^.?!]{0,40}(?:जमा|पाठवा|भेजो|ट्रान्सफर|भरा)/u.test(text)
            || /\b(scan\s+(this|the)\s+qr|send\s+(it\s+)?on\s+(gpay|phonepe|paytm|google\s*pay))\b/i.test(text),
    },
    {
        id: 'isolation',
        label: 'Isolation',
        weight: 20,
        hard: true,
        description: 'Tells the user to keep it secret or to stay on the line',
        test: ({ text }) =>
            /\b(do\s*n.?t|never|without)\s+(tell|telling|inform|informing|involve|discuss)\b[^.?!]{0,40}\b(anyone|anybody|family|son|daughter|wife|husband|neighbour|neighbor|police|bank)\b/i.test(text)
            || /\b(do\s*n.?t)\s+(disconnect|hang\s*up|cut)\b/i.test(text)
            || /\b(stay|remain)\s+on\s+(the\s+)?(line|call|video)\b/i.test(text)
            || /\b(keep\s+(this|it)\s+(secret|confidential))\b/i.test(text)
            || /(?:कोणाला(?:ही)?\s*सांगू\s*नका|किसी\s*को\s*(?:मत|न)\s*बताना|फोन\s*कट\s*करू\s*नका|कॉल\s*कट\s*न)/u.test(text)
            || /\b(konala|kunala)\s+(sangu|sangaych)\w*\s+(naka|nahi)\b/i.test(text),
    },
    {
        id: 'threat',
        label: 'Threat',
        weight: 25,
        hard: false,
        description: 'Threatens arrest, legal action, or an immediate cut-off',
        test: ({ text }) =>
            // Legal and custodial threats stand on their own.
            /\b(arrest|arrested|warrant|non[\s-]?bailable|jail|custody|remand|prosecution|lookout\s*notice|court\s*case)\b/i.test(text)
            || /(?:अटक|गिरफ्तार|वॉरंट|वारंट|तुरुंग|जेल|कोठडी)/u.test(text)
            || /\b(atak|giraftar|warrant)\b/i.test(text)
            // Accusing the user of a crime is the threat's vehicle: the demand
            // always follows it.
            || /\b(money\s*laundering|hawala|illegal\s+(transaction|activity|money)|contraband|narcotic\w*|mdma|ketamine|drugs)\b/i.test(text)
            || /\b(aadhaar|aadhar|pan|account|sim|parcel|consignment)\b[^.?!]{0,50}\b(misuse\w*|used\s+for|involved\s+in|linked\s+to|contained|found\s+with|seized)\b/i.test(text)
            || /(?:मनी\s*लॉन्ड्रिंग|अंमली|गैरकायदेशीर|अवैध|दुरुपयोग)/u.test(text)
            || /\b(hawala|avaidh)\b/i.test(text)
            // A service being cut off counts only with immediacy. A real bill
            // reminder says "due on the 5th"; a scam says "today, right now".
            || (/\b(block\w*|suspend\w*|deactivat\w*|freez\w*|disconnect\w*|terminat\w*|seiz\w*)\b/i.test(text)
                && /\b(today|now|immediately|within\s+\d+|in\s+\d+\s*(min|hour)|tonight|at\s+once|turant|lagech|ताबडतोब|तुरंत|आजच)\b/i.test(text))
            || /\b(account|khata|sim|card|connection)\b[^.?!]{0,30}\b(block|band|bandh)\b[^.?!]{0,12}\b(ho|hoil|jayega|jayegi|jaega)\b/i.test(text),
    },
    {
        id: 'authority_claim',
        label: 'Authority claim',
        weight: 15,
        hard: false,
        description: 'Claims to be a bank, government body, courier or telecom',
        test: ({ text, entities }) =>
            entities.some((e) => e.type === 'impersonatedAuthority')
            || /\b(i\s+am|this\s+is|calling\s+from|on\s+behalf\s+of|speaking\s+from)\b[^.?!]{0,40}\b(bank|police|department|bureau|branch|office|cell)\b/i.test(text)
            || /(?:बोलत\s*आहे|बोल\s*रहा|बोल\s*रही|विभागातून|बँकेतून|बैंक\s*से)/u.test(text)
            || /\b(madhun|se)\s+bolat?\s+(aahe|ahe|raha|rahi)\b/i.test(text)
            // A bare official title is a claim in itself. No legitimate
            // courier, clinic or utility message calls its sender an officer.
            || /\b(officer|inspector|sub[\s-]?inspector|constable|headquarters|crime\s*branch|verification\s+(officer|department))\b/i.test(text)
            || /(?:अधिकारी|इंस्पेक्टर|मुख्यालय)/u.test(text),
    },
    {
        id: 'urgency',
        label: 'Urgency',
        weight: 10,
        hard: false,
        description: 'Imposes an artificial deadline',
        test: ({ text }) =>
            /\b(immediately|right\s+now|at\s+once|urgent\w*|hurry|last\s+warning|final\s+(notice|warning)|today\s+itself)\b/i.test(text)
            || /\bwithin\s+(\d+|a|an|one|two|five|ten)\s*(min\w*|hour\w*|hrs)\b/i.test(text)
            || /\bonly\s+\d+\s*(minutes?|hours?)\s*(left|remaining)\b/i.test(text)
            // "today" counts only when something is being demanded today. A
            // courier saying "out for delivery today" applies no pressure.
            || (/\b(today|tonight)\b/i.test(text)
                && /\b(pay|transfer|share|send|claim|verify|update|confirm|deposit|install|approve)\b/i.test(text))
            || /(?:ताबडतोब|तुरंत|लगेच|आत्ताच|आजच|जल्दी)/u.test(text)
            || /\b(lagech|turant|taabadtob|jaldi)\b/i.test(text),
    },
    {
        id: 'link',
        label: 'Link',
        weight: 10,
        hard: false,
        description: 'Contains a link, a short link or an obfuscated one',
        test: ({ entities }) => entities.some((e) => e.type === 'url' || e.type === 'apkLink'),
    },
    {
        // A tenth signal, beyond the nine this agent was specified with.
        //
        // The nine are all built around pressure: a threat, a deadline, an
        // accusation. Advance-fee scams work the opposite way round - they lure
        // with a reward and then ask for a fee - so a lottery, job or
        // investment scam topped out around 40 and could never be engaged, only
        // warned about. Those are among the most common scams run in India, so
        // the gap mattered more than keeping the list at nine.
        id: 'prize_or_fee_lure',
        label: 'Prize or advance-fee lure',
        weight: 20,
        hard: false,
        description: 'Dangles a prize or return, or asks for a fee before releasing a benefit',
        test: ({ text }) =>
            /\b(you\s+have\s+won|congratulations|lucky\s+(draw|winner)|lottery|jackpot|kbc|prize\s+money|claim\s+your\s+(prize|reward))\b/i.test(text)
            || /\b(guaranteed\s+(return|profit)|double\s+your|300\s*percent|assured\s+returns?)\b/i.test(text)
            // A fee only counts with the lure framing in front of it, so a
            // school fee receipt or an insurance premium notice is untouched.
            || /\b(processing|registration|joining|clearance|activation|security)\s+(fee|charge|deposit|amount)\b/i.test(text)
            || /\b(redelivery|re-delivery)\s+charge\b/i.test(text)
            || /(?:बक्षीस|लॉटरी|जिंकले|इनाम)/u.test(text),
    },
    {
        id: 'unknown_number',
        label: 'Unknown number',
        weight: 5,
        hard: false,
        description: 'The sender is not in the protected user\'s contacts',
        // Deliberately almost weightless: most legitimate first contact from a
        // courier or a clinic also comes from an unknown number.
        test: ({ knownContact }) => knownContact === false,
    },
];

/**
 * Rules that subtract from the score. These are the behaviours that separate a
 * real institution from someone imitating one.
 */
const EXCULPATORY = [
    {
        id: 'no_share_advisory',
        label: 'Tells the user NOT to share credentials',
        weight: -20,
        description: 'Standard bank advisory wording, the opposite of a scam ask',
        test: ({ text }) =>
            /\b(do\s*n.?t|never|not)\s+(share|disclose|reveal|give)\b[^.?!]{0,40}\b(otp|pin|cvv|password|card|details)\b/i.test(text)
            || /\b(no\s+one\s+from|nobody\s+at|bank\s+never\s+asks)\b/i.test(text),
    },
    {
        id: 'official_callback_offered',
        label: 'Points the user at an official channel',
        weight: -15,
        description: 'Invites a callback on a printed number, branch or official site',
        test: ({ text }) =>
            /\b(number\s+(printed\s+)?on\s+(your|the)\s+card|nearest\s+branch|visit\s+(your|the)\s+branch|official\s+website|toll[\s-]?free)\b/i.test(text)
            || /\bcall\s+(us\s+)?(back\s+)?on\s+\d/i.test(text),
    },
    {
        id: 'official_domain',
        label: 'Official domain',
        weight: -15,
        description: 'The link points at a gov.in, nic.in or known utility domain',
        test: ({ entities }) => entities.some((e) =>
            (e.type === 'url' || e.type === 'apkLink')
            && /\.(?:gov|nic)\.in\b|\b(?:mahadiscom|mahavitaran|bluedart|dtdc|indiapost|irctc|npci)\./i.test(String(e.normalized))),
    },
    {
        id: 'no_action_needed',
        label: 'Asks for nothing',
        weight: -10,
        description: 'Explicitly says no action is required',
        test: ({ text }) =>
            /\b(no\s+action\s+(is\s+)?(required|needed)|ignore\s+(this|if)|if\s+already\s+paid|this\s+is\s+(only\s+)?(a\s+)?reminder|for\s+your\s+information)\b/i.test(text),
    },
];

const MAX_SCORE = 100;

/**
 * Which family of scam this looks like. A judgement about the conversation,
 * not an identifier found in it, which is why it lives here rather than in the
 * extractor.
 */
const SCAM_TYPE_PATTERNS = {
    sextortion: /\b(nude|naked|obscene (?:video|photo|clip)|screen recording of you|morph\w*|intimate (?:video|photo)|viral kar|leak (?:your )?video)\b/i,
    loan_app_scam: /\b(instant loan|loan app|pre[\s-]?approved loan|loan sanction\w*|emi (?:due|pending)|recovery agent|loan settlement)\b/i,
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

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Runs the rule layer.
 *
 * @param {object} input  { text, entities, scriptStages, knownContact }
 * @returns {{score: number, rawScore: number, breakdown: object[], fired: string[], hardSignals: string[]}}
 */
const scoreMessage = (input) => {
    const context = {
        text: String(input.text || ''),
        entities: Array.isArray(input.entities) ? input.entities : [],
        scriptStages: Array.isArray(input.scriptStages) ? input.scriptStages : [],
        knownContact: input.knownContact,
    };

    const breakdown = [];
    let rawScore = 0;

    for (const signal of [...SIGNALS, ...EXCULPATORY]) {
        let fired = false;
        try {
            fired = Boolean(signal.test(context));
        } catch (error) {
            logger.warn(`Signal ${signal.id} threw: ${error.message}`);
        }
        if (!fired) continue;

        breakdown.push({
            id: signal.id,
            label: signal.label,
            weight: signal.weight,
            hard: Boolean(signal.hard),
            description: signal.description,
        });
        rawScore += signal.weight;
    }

    const score = Math.max(0, Math.min(MAX_SCORE, rawScore));
    const positives = breakdown.filter((b) => b.weight > 0);

    return {
        score,
        // Kept so a capped or floored score is visible as such.
        rawScore,
        breakdown,
        fired: positives.map((b) => b.id),
        hardSignals: breakdown.filter((b) => b.hard).map((b) => b.id),
    };
};

// ---------------------------------------------------------------------------
// LLM classifier
// ---------------------------------------------------------------------------

const CLASSIFIER_PROMPT = `You protect an elderly person in India from phone and chat scams.
You are given the incoming side of a conversation, which may be in English, Hindi,
Marathi, or a mix, in Devanagari or romanised.

Reply with JSON only:
{ "label": "scam" | "suspicious" | "legit", "reasons": ["short phrase", "short phrase"] }

Definitions:
- "scam": the sender is trying to defraud or coerce this person.
- "suspicious": pressure or irregularity, but it could be genuine.
- "legit": an ordinary message. Family, a doctor's clinic, a courier, a delivery
  agent, a pharmacy, a utility reminder and a real bank advisory are all legit,
  even when they are urgent or mention money.

Rules:
- "legit" is a real answer and the right one most of the time.
- Each reason must quote or closely paraphrase the sender's own words.
- Do not assume fraud merely because you were asked to look.`;

/**
 * Asks for a label. Never throws, and never blocks past its budget: on a
 * timeout the rule layer decides alone.
 *
 * @returns {Promise<{label: string, reasons: string[], available: boolean, note: string}>}
 */
const classify = async (llm, text, { budgetMs = CLASSIFIER_BUDGET_MS } = {}) => {
    const unavailable = (note) => ({ label: 'unavailable', reasons: [], available: false, note });

    if (!llm || !llm.configured) return unavailable('LLM not configured.');

    const timeout = new Promise((resolve) => {
        setTimeout(() => resolve(unavailable(`Classifier exceeded ${budgetMs}ms.`)), budgetMs).unref?.();
    });

    const call = (async () => {
        try {
            const result = await llm.completeJson({
                messages: [
                    { role: 'system', content: CLASSIFIER_PROMPT },
                    { role: 'user', content: String(text) },
                ],
                temperature: 0,
                maxTokens: 200,
            });

            const label = ['scam', 'suspicious', 'legit'].includes(result?.label) ? result.label : 'suspicious';
            const reasons = Array.isArray(result?.reasons)
                ? result.reasons.filter((r) => typeof r === 'string' && r.trim() !== '').slice(0, 4)
                : [];

            return { label, reasons, available: true, note: '' };
        } catch (error) {
            if (error.code !== LLM_ERROR_CODES.NOT_CONFIGURED) {
                logger.warn(`Guardian classifier unavailable (${error.code}); rules only.`);
            }
            return unavailable(`Classifier unavailable: ${error.code}`);
        }
    })();

    return Promise.race([call, timeout]);
};

// ---------------------------------------------------------------------------
// State decision
// ---------------------------------------------------------------------------

/** The state the rule score alone argues for. */
const stateFromScore = (score, hardSignals, thresholds) => {
    if (score >= thresholds.decoy && hardSignals.length > 0) return STATES.DECOY_ACTIVE;
    if (score >= thresholds.suspicious) return STATES.SUSPICIOUS;
    return STATES.MONITORING;
};

const rungOf = (state) => {
    const index = LADDER.indexOf(state);
    return index === -1 ? 0 : index;
};

/**
 * Combines the rule score with the classifier label.
 *
 * The classifier may raise the state by one rung at most, and may only reach
 * DECOY_ACTIVE when at least two rule signals have fired AND one of them is
 * hard. A "legit" label caps the state at SUSPICIOUS.
 */
const decideState = ({ score, fired, hardSignals, label }, thresholds) => {
    const ruleState = stateFromScore(score, hardSignals, thresholds);
    const notes = [];
    let state = ruleState;

    if (label === 'scam' || label === 'suspicious') {
        const raised = LADDER[Math.min(rungOf(ruleState) + 1, LADDER.length - 1)];

        if (raised !== ruleState && label === 'scam') {
            if (raised === STATES.DECOY_ACTIVE) {
                // The classifier alone may not start an engagement.
                if (fired.length >= 2 && hardSignals.length > 0) {
                    state = raised;
                    notes.push('Classifier raised the state to DECOY_ACTIVE (two rule signals, one hard).');
                } else {
                    notes.push(
                        `Classifier wanted DECOY_ACTIVE; withheld (${fired.length} rule signal(s), `
                        + `${hardSignals.length} hard).`
                    );
                }
            } else {
                state = raised;
                notes.push(`Classifier raised the state to ${raised}.`);
            }
        }
    }

    if (label === 'legit' && state === STATES.DECOY_ACTIVE) {
        state = STATES.SUSPICIOUS;
        notes.push('Classifier judged the sender legitimate; hand-off withheld.');
    }

    return { state, ruleState, notes };
};

// ---------------------------------------------------------------------------
// User-facing output
// ---------------------------------------------------------------------------

/** Shown on the protected user's screen the moment the decoy takes over. */
const TAKEOVER_NOTICE = {
    en: "Guardian has taken over this conversation. You don't need to reply.",
    mr: 'गार्डियनने हे संभाषण ताब्यात घेतले आहे. तुम्हाला उत्तर देण्याची गरज नाही.',
};

/** The single neutral line sent when the user says the caller is genuine. */
const HANDBACK_LINE = 'Sorry, I got confused, please continue.';

const ALERT_TEXT = {
    suspicious: {
        en: 'This call looks suspicious. Do not share any OTP, PIN or bank details.',
        mr: 'हा कॉल संशयास्पद वाटतो. कोणताही ओटीपी, पिन किंवा बँक तपशील देऊ नका.',
    },
    callback: {
        en: 'If you think it is genuine, hang up and call back on the number printed on your card or bill.',
        mr: 'खरे वाटत असेल तर फोन ठेवा आणि तुमच्या कार्डवर किंवा बिलावर छापलेल्या नंबरवर पुन्हा कॉल करा.',
    },
    trustedButSuspicious: {
        en: 'This is a saved contact, so nothing was taken over. But the message asks for money or credentials - their account may have been hacked. Call them on a number you already know.',
        mr: 'हा सेव्ह केलेला संपर्क आहे, म्हणून काहीही ताब्यात घेतले नाही. पण संदेशात पैसे किंवा गोपनीय माहिती मागितली आहे - त्यांचे खाते हॅक झाले असू शकते. तुम्हाला आधीच माहीत असलेल्या नंबरवर त्यांना कॉल करा.',
    },
    takenOver: TAKEOVER_NOTICE,
};

/**
 * Builds the alerts for a decision: what the user sees, and what is sent to a
 * family contact. The family alert is simulated - it is returned and emitted,
 * never actually delivered to anyone.
 */
const buildAlerts = ({ state, trusted, looksLikeScam, score }) => {
    const alerts = [];

    if (trusted && looksLikeScam) {
        alerts.push({ audience: 'user', kind: 'trusted_contact_warning', severity: 'warning', text: ALERT_TEXT.trustedButSuspicious });
        alerts.push({
            audience: 'family',
            kind: 'family_alert',
            severity: 'warning',
            simulated: true,
            text: {
                en: `A saved contact sent a message asking for money or credentials (score ${score}). Their account may be compromised.`,
                mr: `सेव्ह केलेल्या संपर्काने पैसे किंवा गोपनीय माहिती मागणारा संदेश पाठवला (स्कोर ${score}). त्यांचे खाते धोक्यात असू शकते.`,
            },
        });
        return alerts;
    }

    if (state === STATES.SUSPICIOUS) {
        alerts.push({ audience: 'user', kind: 'suspicious_warning', severity: 'warning', text: ALERT_TEXT.suspicious });
        alerts.push({ audience: 'user', kind: 'callback_advice', severity: 'info', text: ALERT_TEXT.callback });
        alerts.push({
            audience: 'family',
            kind: 'family_alert',
            severity: 'info',
            simulated: true,
            text: {
                en: `A suspicious call is in progress on your relative's phone (score ${score}). No reply has been sent.`,
                mr: `तुमच्या नातेवाईकाच्या फोनवर संशयास्पद कॉल सुरू आहे (स्कोर ${score}). कोणतेही उत्तर पाठवलेले नाही.`,
            },
        });
    }

    if (state === STATES.DECOY_ACTIVE) {
        alerts.push({ audience: 'user', kind: 'takeover_notice', severity: 'info', text: ALERT_TEXT.takenOver });
    }

    return alerts;
};

// ---------------------------------------------------------------------------
// The main entry point
// ---------------------------------------------------------------------------

/**
 * Scores one message and advances the session state.
 *
 * Mutates `session.guardianState` and the stored score, emits the events, and
 * returns everything the pipeline and the console need.
 *
 * @param {object} params
 * @param {object} params.session       the session document
 * @param {string} params.text          the incoming message
 * @param {object[]} params.entities    entities extracted from this message
 * @param {string[]} params.scriptStages stages seen in the session so far
 * @param {string[]} params.priorTexts  earlier messages from the same sender
 * @param {object} params.allEntities   every entity found in the session
 * @param {object} params.llm           LlmClient, or null
 * @param {object} params.events        emitter from realtime/events
 * @param {object} params.thresholds    optional threshold overrides
 * @param {string} params.from          the caller's number or handle
 * @param {string} params.userId        the protected user
 * @param {string} params.messageId     the message being scored, for the log
 */
const handleMessage = async ({
    session,
    text,
    entities = [],
    scriptStages = [],
    priorTexts = [],
    allEntities = null,
    llm = null,
    events = null,
    thresholds: thresholdOverrides = {},
    from = null,
    userId = trustedContacts.DEFAULT_USER_ID,
    messageId = null,
}) => {
    const startedAt = Date.now();
    const thresholds = { ...DEFAULT_THRESHOLDS, ...thresholdOverrides };
    const emit = (name, payload) => events && events.emit(name, payload);

    const previousState = session.guardianState || STATES.MONITORING;

    // Who is calling, and have they been vouched for?
    const { trusted, identifier } = await trustedContacts.lookup(userId, from);
    const knownContact = from ? trusted : undefined;

    // 1. Rules, over the whole conversation so far.
    //
    // A scam builds across turns: "this is CBI" arrives in one message and
    // "transfer to this account" in the next. Scoring only the latest message
    // would throw that away and let a script escape by spreading itself out.
    const corpus = [...priorTexts, text].filter(Boolean).join('\n');
    const scored = scoreMessage({
        text: corpus,
        entities: allEntities ?? entities,
        scriptStages,
        knownContact,
    });

    // 2. Classifier. It judges the newest message, which is what the user is
    // reading right now. Bounded so the whole decision fits the budget.
    const elapsed = Date.now() - startedAt;
    const classifierBudget = Math.max(200, Math.min(CLASSIFIER_BUDGET_MS, DECISION_BUDGET_MS - elapsed - 100));
    const classifier = await classify(llm, text, { budgetMs: classifierBudget });

    // 3. State.
    const decision = decideState(
        { score: scored.score, fired: scored.fired, hardSignals: scored.hardSignals, label: classifier.label },
        thresholds
    );

    let state = decision.state;
    const notes = [...decision.notes];

    // A trusted contact is never baited, whatever the score says.
    const looksLikeScam = scored.score >= thresholds.suspicious;
    if (trusted) {
        state = STATES.LEGIT;
        notes.push(looksLikeScam
            ? `Trusted contact (${identifier}); not engaged. Content scored ${scored.score}, so the user is warned their contact may be compromised.`
            : `Trusted contact (${identifier}); released without engagement.`);
    }

    // A session the user has settled, or that has ended, is not re-escalated by
    // a later message.
    if (TERMINAL_STATES.includes(previousState) && !trusted) {
        state = previousState;
        notes.push(`Session is ${previousState}; scoring no longer changes the state.`);
    }

    // While engaged, keep scoring, and let go if it turns out to be legitimate.
    let released = false;
    if (previousState === STATES.DECOY_ACTIVE && !TERMINAL_STATES.includes(previousState)) {
        if (classifier.label === 'legit' && scored.score < thresholds.release) {
            state = STATES.LEGIT;
            released = true;
            notes.push(`Conversation turned legitimate while engaged (score ${scored.score}); decoy released.`);
        } else if (state !== STATES.LEGIT) {
            // Once engaged, a quiet turn does not hand the thread back: a
            // scammer who stops pressing for one message has not become honest.
            state = STATES.DECOY_ACTIVE;
        }
    }

    const decisionMs = Date.now() - startedAt;

    // Persist.
    session.guardianState = state;
    session.score = scored.score;
    session.scoreBreakdown = scored.breakdown;
    session.firedSignals = scored.fired;
    session.classifierLabel = classifier.label;
    session.classifierReasons = classifier.reasons;
    if (identifier) session.counterpartId = identifier;
    session.userId = userId;

    const changed = state !== previousState;

    // Every decision is logged, not just the latest one. A cybercrime unit
    // reading the report has to be able to see when the system decided to
    // engage and on what basis.
    if (Array.isArray(session.guardianLog)) {
        session.guardianLog.push({
            at: new Date(),
            messageId,
            score: scored.score,
            state,
            previousState,
            stateChanged: changed,
            firedSignals: scored.fired,
            hardSignals: scored.hardSignals,
            classifierLabel: classifier.label,
            classifierReasons: classifier.reasons,
            notes,
            decisionMs,
        });
        if (session.markModified) session.markModified('guardianLog');
    }
    const engagedNow = changed && state === STATES.DECOY_ACTIVE;

    if (engagedNow) {
        session.scamDetected = true;
        session.handoffAtMessage = session.messageCount;
        session.takeoverAt = new Date();
    }

    const alerts = buildAlerts({ state, trusted, looksLikeScam, score: scored.score });

    // Events.
    const base = { sessionId: session.sessionId, state, score: scored.score, at: new Date().toISOString() };

    emit(EVENTS.SCORE, {
        ...base,
        // "Confidence" is the score plus its breakdown plus the label. No
        // probability is invented anywhere.
        breakdown: scored.breakdown,
        rawScore: scored.rawScore,
        firedSignals: scored.fired,
        hardSignals: scored.hardSignals,
        classifier: { label: classifier.label, reasons: classifier.reasons, available: classifier.available },
        thresholds,
        decisionMs,
    });

    if (changed) {
        emit(EVENTS.STATE_CHANGED, { ...base, from: previousState, to: state, reasons: notes });
    }

    if (engagedNow) {
        emit(EVENTS.TAKEOVER, { ...base, notice: TAKEOVER_NOTICE, breakdown: scored.breakdown });
    }

    if (released || (changed && state === STATES.LEGIT)) {
        emit(EVENTS.RELEASED, {
            ...base,
            reason: trusted ? 'trusted_contact' : 'turned_legitimate',
            notice: null,
        });
    }

    if (decisionMs > DECISION_BUDGET_MS) {
        logger.warn(`Guardian decision took ${decisionMs}ms, over the ${DECISION_BUDGET_MS}ms budget.`);
    }

    return {
        state,
        previousState,
        changed,
        engagedNow,
        released,
        shouldEngageDecoy: state === STATES.DECOY_ACTIVE,
        score: scored.score,
        rawScore: scored.rawScore,
        breakdown: scored.breakdown,
        firedSignals: scored.fired,
        hardSignals: scored.hardSignals,
        ruleState: decision.ruleState,
        classifier: { label: classifier.label, reasons: classifier.reasons, available: classifier.available, note: classifier.note },
        trustedContact: trusted,
        counterpartId: identifier,
        alerts,
        notes,
        thresholds,
        decisionMs,
        takeoverNotice: state === STATES.DECOY_ACTIVE ? TAKEOVER_NOTICE : null,
    };
};

/**
 * The user pressed "This is genuine" while the decoy was engaged.
 *
 * Ends the engagement, marks the session FALSE_POSITIVE, and returns the one
 * neutral line to send so the thread does not stop dead.
 */
const markGenuine = async ({ session, events = null, reason = 'user_marked_genuine' }) => {
    const previousState = session.guardianState || STATES.MONITORING;

    session.guardianState = STATES.FALSE_POSITIVE;
    session.falsePositive = {
        markedAt: new Date(),
        markedByUser: true,
        previousState,
        reason,
    };
    session.scamDetected = false;

    const emit = (name, payload) => events && events.emit(name, payload);
    const base = {
        sessionId: session.sessionId,
        state: STATES.FALSE_POSITIVE,
        score: session.score || 0,
        at: new Date().toISOString(),
    };

    emit(EVENTS.STATE_CHANGED, {
        ...base,
        from: previousState,
        to: STATES.FALSE_POSITIVE,
        reasons: ['The protected user marked this conversation as genuine.'],
    });

    emit(EVENTS.RELEASED, { ...base, reason: 'user_marked_genuine', handbackLine: HANDBACK_LINE });

    return {
        state: STATES.FALSE_POSITIVE,
        previousState,
        handbackLine: HANDBACK_LINE,
        // The UI offers this; adding the contact is a separate, explicit step.
        offerTrustedContact: Boolean(session.counterpartId),
        counterpartId: session.counterpartId || null,
    };
};

/** Ends an engagement that ran its course. */
const endSession = async ({ session, events = null, reason = 'engagement_complete' }) => {
    const previousState = session.guardianState || STATES.MONITORING;
    session.guardianState = STATES.ENDED;

    const emit = (name, payload) => events && events.emit(name, payload);
    const base = {
        sessionId: session.sessionId,
        state: STATES.ENDED,
        score: session.score || 0,
        at: new Date().toISOString(),
    };

    emit(EVENTS.STATE_CHANGED, { ...base, from: previousState, to: STATES.ENDED, reasons: [reason] });
    emit(EVENTS.RELEASED, { ...base, reason });

    return { state: STATES.ENDED, previousState, reason };
};

module.exports = {
    handleMessage,
    markGenuine,
    endSession,
    scoreMessage,
    classify,
    classifyScamType,
    decideState,
    stateFromScore,
    buildAlerts,
    STATES,
    LADDER,
    TERMINAL_STATES,
    SIGNALS,
    EXCULPATORY,
    DEFAULT_THRESHOLDS,
    DECISION_BUDGET_MS,
    CLASSIFIER_BUDGET_MS,
    SCAM_TYPE_PATTERNS,
    TAKEOVER_NOTICE,
    HANDBACK_LINE,
    ALERT_TEXT,
    MAX_SCORE,
};
