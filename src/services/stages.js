/**
 * Script stage tagging.
 *
 * Scam calls follow a script. Labelling each message with the stages it plays
 * turns a transcript into something a cybercrime unit can compare across
 * sessions: the same operation reuses the same sequence.
 *
 * Nine stages, zero or more per message.
 *
 * Keyword rules run first, in English, Hindi and Marathi, Devanagari and
 * romanised. One cheap LLM call then covers only the stages the rules did not
 * find — a paraphrase the vocabulary misses still gets labelled. Every tag
 * records which method produced it, so a reader can tell a matched phrase from
 * a model's judgement.
 */

const logger = require('./logger');
const { boundedWords, asciiDigits } = require('./digits');
const { LLM_ERROR_CODES } = require('../llm/errors');

const STAGES = [
    'CONTACT',
    'AUTHORITY_CLAIM',
    'ACCUSATION',
    'THREAT',
    'ISOLATION',
    'URGENCY',
    'PAYMENT_DEMAND',
    'CREDENTIAL_REQUEST',
    'VERIFICATION_LURE',
];

const STAGE_DESCRIPTIONS = {
    CONTACT: 'Opening contact: a greeting, or stating why they are calling',
    AUTHORITY_CLAIM: 'Claims to be a bank, the police, a government body or a courier',
    ACCUSATION: 'Accuses the target of a crime or of a compromised identity',
    THREAT: 'Threatens arrest, a warrant, jail, a fine or disconnection',
    ISOLATION: 'Tells the target to stay on the call or tell nobody',
    URGENCY: 'Imposes a deadline or demands immediate action',
    PAYMENT_DEMAND: 'Asks for money, or for a transfer to an account, UPI id or wallet',
    CREDENTIAL_REQUEST: 'Asks for an OTP, PIN, CVV, screen share or an app install',
    VERIFICATION_LURE: 'Frames the payment as safe, refundable or held for verification',
};

/**
 * Keyword rules. `words` are matched on a word boundary that works for
 * Devanagari; `patterns` carry the phrasings a word list cannot express.
 */
const RULES = {
    CONTACT: {
        words: [
            'hello', 'hallo', 'good morning', 'good afternoon', 'good evening',
            'namaste', 'namaskar', 'नमस्ते', 'नमस्कार', 'हॅलो', 'हैलो',
            'am i speaking', 'is this', 'sir', 'madam', 'ma am', 'सर', 'मॅडम', 'मैडम',
        ],
        patterns: [
            /\b(?:am i (?:speaking|talking) (?:to|with)|is (?:this|that) (?:mr|mrs|ms|miss))\b/i,
            /\b(?:my name is|i am calling|this call is|calling you)\b/i,
            /\b(?:aapka naam|तुमचे नाव|आपका नाम|बोलत आहे|बोल रहा|बोल रही)\b/iu,
        ],
    },

    AUTHORITY_CLAIM: {
        words: [
            'cbi', 'ed', 'enforcement directorate', 'police', 'cyber cell', 'cyber crime',
            'customs', 'narcotics', 'ncb', 'trai', 'rbi', 'reserve bank', 'income tax',
            'fedex', 'dhl', 'bluedart', 'courier', 'electricity board', 'mseb',
            'mahavitaran', 'bsnl', 'inspector', 'officer', 'department', 'headquarters',
            // Naming the institution is itself the claim, which is how it is
            // usually done in Hinglish: "aapka SBI account ...".
            'sbi', 'state bank', 'hdfc', 'icici', 'axis bank', 'kotak', 'pnb',
            'punjab national', 'bank of baroda', 'canara', 'union bank', 'yes bank',
            'सीबीआई', 'पोलीस', 'पुलिस', 'साइबर', 'सायबर', 'कस्टम', 'आरबीआई', 'आयकर',
            'विभाग', 'अधिकारी', 'इंस्पेक्टर', 'कुरिअर', 'महावितरण', 'वीज',
        ],
        patterns: [
            /\b(?:i am|this is|calling from|on behalf of|speaking from)\b[^.?!]{0,40}\b(?:bank|police|department|branch|office|cell|bureau)\b/i,
            /\b(?:sbi|hdfc|icici|axis|kotak|pnb|canara|baroda)\b[^.?!]{0,30}\b(?:bank|branch|security|team|officer)\b/i,
            /(?:बँकेतून|बैंक से|विभागातून|विभाग से|कार्यालयातून)/u,
        ],
    },

    ACCUSATION: {
        words: [
            'money laundering', 'hawala', 'illegal transaction', 'suspicious transaction',
            'drugs', 'narcotic substance', 'mdma', 'ketamine', 'contraband',
            'fake passport', 'misuse', 'misused', 'your name', 'implicated', 'accused',
            'मनी लॉन्ड्रिंग', 'ड्रग्स', 'अंमली', 'गैरकायदेशीर', 'अवैध', 'दुरुपयोग',
            'तुमच्या नावावर', 'आपके नाम पर',
        ],
        patterns: [
            /\b(?:parcel|package|courier|consignment)\b[^.?!]{0,60}\b(?:drugs|narcotic|mdma|illegal|contraband|passport|sim)\b/i,
            /\b(?:aadhaar|aadhar|pan|account|sim)\b[^.?!]{0,40}\b(?:misuse|misused|used for|linked to|involved in)\b/i,
            /\b(?:your (?:name|aadhaar|account|sim) (?:is|has been|was) (?:used|involved|linked))\b/i,
            /(?:पार्सल|कुरिअर)[^.?!]{0,50}(?:ड्रग्स|अंमली|अवैध)/u,
        ],
    },

    THREAT: {
        words: [
            'arrest', 'arrested', 'warrant', 'non bailable', 'jail', 'custody', 'remand',
            'lookout notice', 'fir', 'court case', 'prosecution', 'penalty', 'fine',
            'seize', 'seized', 'freeze', 'frozen', 'blacklist',
            'अटक', 'गिरफ्तार', 'वॉरंट', 'वारंट', 'जेल', 'तुरुंग', 'कोठडी', 'दंड',
            'जप्त', 'गोठवले', 'कारवाई', 'कार्रवाई',
        ],
        patterns: [
            /\b(?:police|team|officer)s?\b[^.?!]{0,40}\b(?:will (?:come|reach|arrive)|is coming|are coming)\b/i,
            // A service being cut off is a threat. "Do not disconnect the call"
            // is isolation, which is why the bare word is not in the list above.
            /\b(?:account|sim|connection|card|service|meter|supply|number|mobile)\b[^.?!]{0,40}\b(?:will be|is|are|was|has been|is being|shall be)\b[^.?!]{0,20}\b(?:block\w*|suspend\w*|clos\w*|deactivat\w*|disconnect\w*|cut|terminat\w*)/i,
            // The same threat in romanised Hinglish: "account block ho jayega",
            // "SIM band ho jayegi", "connection bandh hoil".
            /\b(?:account|khata|khate|sim|card|connection|number)\b[^.?!]{0,30}\b(?:block|band|bandh|close)\b[^.?!]{0,10}\b(?:ho|hoil|hoeil|jayega|jayegi|jaega|hojayega)\b/i,
            /(?:अटक\s*(?:होईल|करू|केली)|कारवाई\s*(?:होईल|केली)|बंद\s*(?:होईल|केले))/u,
        ],
    },

    ISOLATION: {
        words: [
            'do not tell', 'dont tell', 'don t tell', 'do not inform', 'tell no one',
            'keep it confidential', 'keep this secret', 'between us', 'do not disconnect',
            'dont disconnect', 'do not cut', 'stay on the line', 'stay on the call',
            'stay on video', 'video call', 'skype', 'do not involve',
            'किसी को मत', 'कोणाला सांगू नका', 'कोणालाही सांगू', 'सांगू नका', 'गुप्त',
            'फोन कट करू नका', 'कॉल कट', 'लाइन पर रहें',
        ],
        patterns: [
            /\b(?:do\s*n[o']?t|never)\b[^.?!]{0,30}\b(?:tell|inform|share with|discuss with|involve)\b[^.?!]{0,30}\b(?:anyone|anybody|family|son|daughter|neighbour|police)\b/i,
            /\b(?:stay|remain|be)\b[^.?!]{0,20}\b(?:on (?:the )?(?:line|call|video)|in front of the camera)\b/i,
            /\b(?:room|door)\b[^.?!]{0,30}\b(?:alone|lock|closed)\b/i,
        ],
    },

    URGENCY: {
        words: [
            'immediately', 'right now', 'at once', 'urgent', 'urgently', 'hurry',
            'last warning', 'final notice', 'final warning', 'today itself', 'within',
            'deadline', 'expires', 'expiring', 'before 5', 'no time',
            'तुरंत', 'ताबडतोब', 'लगेच', 'आत्ताच', 'अभी', 'जल्दी', 'शेवटची संधी',
            'अंतिम', 'आजच', 'मुदत',
        ],
        patterns: [
            /\bwithin\s+(?:\d+|a|an|one|two|five|ten)\s*(?:min|minute|hour|hrs|hour s)\w*\b/i,
            /\b(?:in|within)\s+the\s+next\s+\d+\b/i,
            /\b(?:only|just)\s+\d+\s*(?:minutes?|hours?)\s+(?:left|remaining)\b/i,
            /(?:\d+\s*(?:मिनिट|मिनट|तास|घंटे)\s*(?:मध्ये|में))/u,
        ],
    },

    PAYMENT_DEMAND: {
        words: [
            'transfer', 'deposit', 'remit', 'pay', 'payment', 'send money', 'fees',
            'fee', 'charges', 'processing fee', 'clearance', 'penalty amount',
            'upi', 'google pay', 'gpay', 'phonepe', 'paytm', 'qr code', 'scan',
            'bitcoin', 'usdt', 'crypto', 'gift card',
            'पैसे', 'रक्कम', 'भरणा', 'जमा', 'ट्रान्सफर', 'ट्रांसफर', 'शुल्क', 'दंड भरा',
        ],
        patterns: [
            /\b(?:transfer|send|deposit|pay|remit|credit)\b[^.?!]{0,60}\b(?:upi|account|a\/c|wallet|bitcoin|usdt|qr|number)\b/i,
            /(?:₹|rs\.?|inr|rupees)\s*[\d,]+/i,
            /\b\d[\d,]*\s*(?:lakh|lac|crore|thousand|rupees)\b/i,
            /(?:पैसे|रक्कम)[^.?!]{0,30}(?:पाठवा|भरा|जमा|ट्रान्सफर|भेजो|भेजिए)/u,
            // Romanised Hindi and Marathi payment verbs: "bhej dijiye",
            // "paise bhejo", "jama kara", "transfer kara", "paathva".
            /\b(?:bhej|bheje|bhejo|bhejiye|bhejna|paise|paisa|rupaye|jama|pathva|paathva|transfer)\w*\b/i,
        ],
    },

    CREDENTIAL_REQUEST: {
        words: [
            'otp', 'o t p', 'one time password', 'pin', 'cvv', 'password', 'passcode',
            'card number', 'expiry date', 'net banking', 'user id', 'login',
            'anydesk', 'teamviewer', 'quicksupport', 'screen share', 'screen sharing',
            'remote access', 'apk', 'install the app', 'download the app',
            'ओटीपी', 'पिन', 'पासवर्ड', 'स्क्रीन शेअर', 'अ‍ॅप इन्स्टॉल',
        ],
        patterns: [
            /\b(?:otp|pin|cvv|password|passcode|code)\b[^.?!]{0,30}\b(?:share|send|tell|give|provide|enter|type|read|forward|what is)\b/i,
            /\b(?:share|send|tell|give|provide|enter|type|read|forward|what is)\b[^.?!]{0,30}\b(?:otp|pin|cvv|password|passcode|code)\b/i,
            /\b(?:install|download)\b[^.?!]{0,30}\b(?:app|apk|application|software|tool)\b/i,
            /(?:ओटीपी|पिन|पासवर्ड)[^.?!]{0,25}(?:सांगा|द्या|बताओ|दीजिए|भेजो)/u,
        ],
    },

    VERIFICATION_LURE: {
        words: [
            'refundable', 'fully refundable', 'returned to you', 'safe account',
            'rbi safe account', 'verification purpose', 'for verification',
            'just for verification', 'security deposit', 'will be reversed',
            'temporary', 'audit', 'clearance process', 'no deduction',
            'परत मिळेल', 'वापस मिल', 'सुरक्षित खाते', 'सत्यापन', 'पडताळणी',
        ],
        patterns: [
            /\b(?:money|amount|funds?)\b[^.?!]{0,40}\b(?:safe|secure|refund|returned|reversed|back to you)\b/i,
            /\b(?:only|just)\b[^.?!]{0,20}\b(?:for|to)\s+verif\w*/i,
            /\b(?:rbi|government|official)\b[^.?!]{0,20}\b(?:safe|secure|verified)\s+account\b/i,
        ],
    },
};

/**
 * Tags a message using the keyword rules only. No network, no key.
 *
 * @returns {{stage: string, method: 'rules', evidence: string}[]}
 */
const tagWithRules = (text) => {
    const source = asciiDigits(String(text || ''));
    if (source.trim() === '') return [];

    const tags = [];

    for (const stage of STAGES) {
        const rule = RULES[stage];
        let evidence = null;

        if (rule.words && rule.words.length > 0) {
            const hit = source.match(boundedWords(rule.words));
            if (hit) evidence = hit[0];
        }

        if (!evidence && rule.patterns) {
            for (const pattern of rule.patterns) {
                const hit = source.match(pattern);
                if (hit) {
                    evidence = hit[0].trim();
                    break;
                }
            }
        }

        if (evidence) tags.push({ stage, method: 'rules', evidence });
    }

    return tags;
};

const LLM_PROMPT = `You label one message from a suspected scam conversation in India
with the stages of the scam script it plays. The message may be in English, Hindi,
Marathi, or a mix, in Devanagari or romanised.

Stages:
{{STAGES}}

Reply with JSON only:
{ "stages": [ { "stage": "<STAGE_NAME>", "evidence": "<the words in the message that show it>" } ] }

Rules:
- Only stages the message actually plays. An empty list is a valid answer.
- "evidence" must quote the message, not paraphrase it.
- Judge only this message.`;

/**
 * Asks the LLM about the stages the rules did not find.
 *
 * One call per message. Never throws: without a key, or on any failure, the
 * rule tags stand on their own.
 *
 * @returns {Promise<{stage: string, method: 'llm', evidence: string}[]>}
 */
const tagWithLlm = async (text, { llm, exclude = [] } = {}) => {
    if (!llm || !llm.configured) return [];

    const candidates = STAGES.filter((stage) => !exclude.includes(stage));
    if (candidates.length === 0) return [];

    const stageList = candidates.map((stage) => `- ${stage}: ${STAGE_DESCRIPTIONS[stage]}`).join('\n');

    try {
        const result = await llm.completeJson({
            messages: [
                { role: 'system', content: LLM_PROMPT.replace('{{STAGES}}', stageList) },
                { role: 'user', content: String(text) },
            ],
            temperature: 0,
            maxTokens: 300,
        });

        const raw = Array.isArray(result?.stages) ? result.stages : [];
        const tags = [];

        for (const item of raw) {
            const stage = typeof item?.stage === 'string' ? item.stage.trim().toUpperCase() : '';
            // Only the stages we asked about: the model cannot overrule a rule
            // tag, and cannot invent a stage that is not in the taxonomy.
            if (!candidates.includes(stage)) continue;
            if (tags.some((t) => t.stage === stage)) continue;

            tags.push({
                stage,
                method: 'llm',
                evidence: typeof item?.evidence === 'string' ? item.evidence.trim() : '',
            });
        }

        return tags;
    } catch (error) {
        if (error.code !== LLM_ERROR_CODES.NOT_CONFIGURED) {
            logger.warn(`Stage tagger unavailable (${error.code}); keyword rules only.`);
        }
        return [];
    }
};

/**
 * Tags a message: rules first, then one LLM call for what they missed.
 *
 * @param {string} text
 * @param {object} [options]  { llm, useLlm }
 * @returns {Promise<{stage: string, method: string, evidence: string}[]>}
 */
const tag = async (text, { llm = null, useLlm = true } = {}) => {
    const ruleTags = tagWithRules(text);
    if (!useLlm || !llm) return ruleTags;

    const llmTags = await tagWithLlm(text, { llm, exclude: ruleTags.map((t) => t.stage) });

    // Keep taxonomy order so a transcript reads as a script, not as match order.
    return [...ruleTags, ...llmTags].sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage));
};

module.exports = { tag, tagWithRules, tagWithLlm, STAGES, STAGE_DESCRIPTIONS, RULES };
