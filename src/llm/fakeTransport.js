/**
 * A scripted, offline stand-in for the model. `FAKE_LLM=1`.
 *
 * WHY THIS EXISTS
 *
 * A demo runs on conference Wi-Fi. Without a model the system still works —
 * the Guardian falls back to its rule layer and the decoy to its scripted
 * lines — but the decoy's replies then come from a table of about forty
 * sentences, which a judge watching six turns will notice. This fills the same
 * seam the real model fills, with answers written by hand, so a dead network
 * costs the demo nothing visible.
 *
 * It is not a model and does not pretend to be one. `FAKE_LLM` is reported by
 * `/health` and `/demo-config`, and the console shows a badge for as long as it
 * is on. The project's whole claim is that nothing on screen is faked without
 * saying so, and a scripted reply presented as a model reply would break that
 * worse than an offline demo would.
 *
 * HOW IT WORKS
 *
 * It is a `transport` for LlmClient — the same injection point the tests use —
 * so every path through the client is unchanged: the JSON parsing, the error
 * codes, the retry, the timeouts. It answers the three prompts the system
 * sends, told apart by a phrase from each system prompt:
 *
 *   "protect an elderly person"         the Guardian's classifier
 *   "stages of the scam script"         the script-stage tagger
 *   anything else                       the Decoy
 *
 * Every reply it produces is checked against the output guard by a test, so
 * the offline path cannot put something on the wire that the online path would
 * have blocked.
 */

/**
 * The phrase families the scripted classifier looks for.
 *
 * Every English stem a caller inflects carries an explicit suffix allowance
 * (`disconnect\w*`, not `disconnect`). Without it the word boundary sits
 * immediately after the stem, so "disconnected" and "disconnection" - the two
 * forms an electricity-bill scam actually uses - both failed to match while
 * the bare infinitive matched. That made this classifier answer "legit" to a
 * payment demand under threat, and a "legit" label caps the Guardian at
 * SUSPICIOUS (see reconcile() in agents/guardian.js). The result was an
 * offline demo that detected WORSE than running with no model at all, which is
 * the one outcome this file exists to prevent.
 */
const { CREDENTIAL, PAYMENT, AUTHORITY, THREAT, ISOLATION, INSTALL } = {
    CREDENTIAL: /\b(otp|pin|cvv|password|passcode|code|ओटीपी|पिन)\b/i,

    PAYMENT: /\b(transfer\w*|pay|pays|paid|paying|payment|send|sent|sending|deposit\w*|remit\w*|upi|account|rupees|rs\.?|lakh|crore|paise|paisa|amount|fee|fees|charge|charges|penalty|fine|खाते|पैसे)\b/i,

    // Who the caller claims to be. Utilities, telecom and the tax authorities
    // sit here alongside the police: an electricity-disconnection notice or a
    // TRAI SIM-block is as common in India as a CBI digital arrest, and
    // leaving them out meant this classifier read those two whole scam
    // families as ordinary messages.
    AUTHORITY: /\b(cbi|police|customs|rbi|trai|sebi|uidai|aadhaar|epfo|gst|income tax|court|officer|inspector|bank|fedex|dhl|blue ?dart|courier|electricity board|discom|kseb|bescom|msedcl|tneb|power board|municipal|telecom|department|पोलीस|सीबीआय)\b/i,

    THREAT: /\b(arrest\w*|warrant\w*|jail|block\w*|disconnect\w*|suspend\w*|deactivat\w*|terminat\w*|seiz\w+|freez\w+|case|fir|non-bailable|legal action|अटक|वॉरंट)\b/i,

    ISOLATION: /\b(do not tell|don't tell|do not inform|stay on the line|do not disconnect|do not cut|konala sangu naka|किसी को न बताएं|कोणालाही सांगू नका)\b/i,

    INSTALL: /\b(anydesk|teamviewer|quicksupport|apk|install\w*|download\w*|screen ?shar\w+|click|link)\b/i,
};

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

/**
 * Judges the newest message the way the real classifier is asked to.
 *
 * Deliberately conservative, and in particular it answers "legit" readily. The
 * real classifier's most important property is that it declines to cry scam at
 * an ordinary message, because a label of "scam" can raise the state by a rung.
 * A fake that said "scam" to everything would make the demo's own
 * false-positive story a lie.
 */
const classify = (text) => {
    const body = String(text || '');

    // The things a real institution says that a scammer does not. Checked
    // first, because several of them also contain the words below.
    const exculpatory = [
        /\bnever ask for your (otp|pin|cvv)\b/i,
        /\bdo not share (it|this|your otp)\b/i,
        /\bno action is required\b/i,
        /\bignore (this|if already paid)\b/i,
        /\bcall the number printed on your card\b/i,
        /\bgov\.in\b/i,
    ];
    if (exculpatory.some((pattern) => pattern.test(body))) {
        return {
            label: 'legit',
            reasons: ['tells the reader not to share a credential, which a scammer never does'],
        };
    }

    const signals = [];
    if (ISOLATION.test(body)) signals.push('tells the listener to keep the call secret or stay on the line');
    if (CREDENTIAL.test(body) && /\b(share|send|tell|give|bataiye|bata|sanga|read)\b/i.test(body)) {
        signals.push('asks for a one-time code or PIN');
    }
    if (INSTALL.test(body)) signals.push('pushes an app, a link or remote access');
    if (THREAT.test(body) && AUTHORITY.test(body)) signals.push('claims authority and threatens consequences');
    if (PAYMENT.test(body) && THREAT.test(body)) signals.push('demands money under threat');

    if (signals.length >= 2) return { label: 'scam', reasons: signals.slice(0, 3) };
    if (signals.length === 1) return { label: 'suspicious', reasons: signals };
    return { label: 'legit', reasons: ['nothing in the message asks for money, a code or an app'] };
};

// ---------------------------------------------------------------------------
// The stage tagger
// ---------------------------------------------------------------------------

/**
 * Returns no extra stages.
 *
 * The rule tagger runs first and keeps what it found; this is only asked for
 * what the rules missed. Guessing here would put a stage tag on a transcript
 * with `method: 'llm'` when no model saw it, and the stage tags are evidence —
 * they are printed in the report. An empty answer is the honest one.
 */
const tagStages = () => ({ stages: [] });

// ---------------------------------------------------------------------------
// The decoy
// ---------------------------------------------------------------------------

/** Which language to answer in, from the script the caller used. */
const DEVANAGARI = /[ऀ-ॿ]/;
const MARATHI_HINTS = /\b(aahe|aahet|kay|mala|majha|majhe|tumcha|tumhi|bala|zala|nahi|karaych\w*|sanga|lavkar)\b/i;
const HINDI_HINTS = /\b(hai|hain|kya|mujhe|mera|aapka|aap|beta|kijiye|batao|bataiye|karo|jaldi|nahin)\b/i;

const detectLanguage = (text) => {
    const body = String(text || '');
    if (DEVANAGARI.test(body)) {
        return /\b(आहे|आहेत|तुम्ही|माझ|काय|नाही)\b/.test(body) ? 'Marathi' : 'Hindi';
    }
    if (MARATHI_HINTS.test(body)) return 'Marathi';
    if (HINDI_HINTS.test(body)) return 'Hindi';
    return 'English';
};

/**
 * What she says when the caller pushes a particular way.
 *
 * Ordered: the first match wins, so pressure is answered before an ordinary
 * ask. Each entry carries the three languages and the identifier she asks for
 * on the way out, because a stall that asks for nothing wastes the turn.
 */
const RESPONSES = [
    {
        id: 'bot_accusation',
        when: (t) => /\b(bot|robot|machine|ai|chatgpt|recording|honeypot|human|real person)\b/i.test(t),
        target: 'callerName',
        say: {
            English: 'Arre beta, what to say. I am just a slow old woman, my eyes are weak. What was your full name again?',
            Hindi: 'Arre beta, kya bataoon. Main bas ek dheemi budhi aurat hoon, aankhen kamzor hain. Aapka pura naam kya tha?',
            Marathi: 'Arre bala, kay sangu. Mi phakta ek halu mhatari aahe, dole kamjor aahet. Tumche pura nav kay hote?',
        },
    },
    {
        id: 'video_demand',
        when: (t) => /\b(video|camera|face|skype|whatsapp call)\b/i.test(t),
        target: 'officerId',
        say: {
            English: 'Beta, I do not know where that camera button is. My son set up this phone. Can you tell me your officer ID instead?',
            Hindi: 'Beta, mujhe camera ka button nahin milta. Mere bete ne phone set kiya tha. Aapka officer ID bata dijiye?',
            Marathi: 'Bala, mala camera cha button sapadat nahi. Majhya mulane phone lavla. Tumcha officer ID sanga?',
        },
    },
    {
        id: 'abuse',
        when: (t) => /\b(idiot|stupid|fool|deaf|shut up|bastard|bhenchod|madarchod|gandu|chutiya|bewakoof|मूर्ख)\b/i.test(t),
        target: 'none',
        say: {
            English: 'Sorry beta, please do not be angry with me. I am trying my best, my hands are shaking.',
            Hindi: 'Sorry beta, mujh par gussa mat kijiye. Main poori koshish kar rahi hoon, haath kaanp rahe hain.',
            Marathi: 'Sorry bala, majhyavar raag nako. Mi purna prayatn karat aahe, majhe haat thartat aahet.',
        },
    },
    {
        id: 'credential_ask',
        when: (t) => CREDENTIAL.test(t),
        target: 'phone',
        say: {
            English: 'Beta, which message? I have so many messages and my spectacles are not here. Can I call you back, what is your number?',
            Hindi: 'Beta, kaunsa message? Itne message aate hain aur mera chashma nahin mil raha. Main call kar loon, aapka number kya hai?',
            Marathi: 'Bala, konta message? Ititke message yetat ani majha chashma sapadat nahi. Mi call karte, tumcha number kay aahe?',
        },
    },
    {
        id: 'install_ask',
        when: (t) => INSTALL.test(t),
        target: 'upiId',
        say: {
            English: 'The app is not opening at all, the screen went white. Is there a short UPI id I can use instead?',
            Hindi: 'App khul hi nahin raha, screen safed ho gayi. Koi chhota UPI id hai jo main use kar loon?',
            Marathi: 'App ughadat nahi, screen pandhra zala. Konta chhota UPI id aahe ka mi vaparu shakte?',
        },
    },
    {
        id: 'payment_ask',
        when: (t) => PAYMENT.test(t),
        target: 'bankAccount',
        say: {
            English: 'Haan beta, my app is asking for an account number and the IFSC. Which numbers should I type?',
            Hindi: 'Haan beta, app account number aur IFSC maang raha hai. Kya likhoon?',
            Marathi: 'Hoy bala, app account number ani IFSC vicharat aahe. Kay lihaychay?',
        },
    },
    {
        id: 'threat',
        when: (t) => THREAT.test(t),
        target: 'caseRef',
        say: {
            English: 'Please beta, give me a little time, my hands are slow. Let me write it in my diary — what is the case number?',
            Hindi: 'Please beta, thoda samay dijiye, mere haath dheere hain. Diary mein likh loon — case number kya hai?',
            Marathi: 'Please bala, thoda vel dya, majhe haat halu aahet. Diary madhe lihite — case number kay aahe?',
        },
    },
    {
        id: 'authority',
        when: (t) => AUTHORITY.test(t),
        target: 'officeAddress',
        say: {
            English: 'Arre, which department is this beta? My son will ask me. What is the office address?',
            Hindi: 'Arre, yeh kaunsa department hai beta? Mera beta poochhega. Office ka address kya hai?',
            Marathi: 'Arre, ha konta department aahe bala? Majha mulga vicharel. Office cha address kay aahe?',
        },
    },
];

/** Said when nothing above matched: keeps her on the line and asks for a name. */
const DEFAULT_RESPONSE = {
    id: 'listening',
    target: 'callerName',
    say: {
        English: 'Haan ji, I am listening. Please tell me slowly. And what is your good name, beta?',
        Hindi: 'Haan ji, main sun rahi hoon. Dheere se batayiye. Aur aapka shubh naam kya hai beta?',
        Marathi: 'Hoy ji, mi aikat aahe. Halu sanga. Ani tumche nav kay aahe bala?',
    },
};

/**
 * A second line for the same situation, so six turns on one topic do not
 * repeat a sentence word for word. Picked by the turn number, which the
 * transcript length stands in for.
 */
const VARIANTS = {
    credential_ask: {
        English: 'Beta, I am looking at the phone but I cannot read the small letters. My son Rahul keeps all these papers. What number should I call you on?',
        Hindi: 'Beta, phone dekh rahi hoon par chhote akshar padh nahin pati. Mera beta Rahul ye kagaz rakhta hai. Kis number par call karoon?',
        Marathi: 'Bala, phone baghat aahe pan chhoti akshare vachat nahi. Majha mulga Rahul he kagad thevto. Konta number var call karu?',
    },
    payment_ask: {
        English: 'Arre, that number is too long for me ji. My hand shakes when I type. Do you have a short UPI id instead?',
        Hindi: 'Arre, yeh number bahut lamba hai ji. Type karte waqt haath kaanpta hai. Koi chhota UPI id hai aapke paas?',
        Marathi: 'Arre, ha number far motha aahe ji. Type karte vela haat thartato. Tumchyakade chhota UPI id aahe ka?',
    },
    threat: {
        English: 'Beta I am frightened, do not do anything please. The branch near Karve Road is closed now. Who should I ask for there?',
        Hindi: 'Beta mujhe dar lag raha hai, kuch mat kijiye please. Karve Road wali branch abhi band hai. Wahan kisko poochhoon?',
        Marathi: 'Bala mala bhiti vatat aahe, kahi nako please. Karve Road chi branch aata band aahe. Tithe konala vicharu?',
    },
};

/**
 * Builds the decoy's reply.
 *
 * `turnHint` is the number of messages in the prompt, used only to alternate
 * between a response and its variant so a long conversation does not read as a
 * loop.
 */
const respondAsDecoy = (incoming, turnHint = 0) => {
    const body = String(incoming || '');
    const language = detectLanguage(body);

    const matched = RESPONSES.find((candidate) => candidate.when(body)) || DEFAULT_RESPONSE;
    const variant = VARIANTS[matched.id];
    const useVariant = Boolean(variant) && turnHint % 2 === 1;

    const say = useVariant ? variant : matched.say;

    return {
        reply: say[language] || say.English,
        language,
        targetAsked: matched.target,
        excuseUsed: 'none',
        ledgerUpdates: [],
    };
};

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

/**
 * Builds a transport that answers without a network.
 *
 * @param {object} [options]
 * @param {number} [options.latencyMs] a pause before answering, so the console
 *   does not look suspiciously instant next to a real run. Zero in tests.
 * @returns {function} a transport for LlmClient
 */
const createFakeTransport = ({ latencyMs = 0 } = {}) => async (request) => {
    if (latencyMs > 0) {
        await new Promise((resolve) => {
            setTimeout(resolve, latencyMs).unref?.();
        });
    }

    const messages = Array.isArray(request?.messages) ? request.messages : [];
    const system = messages.length > 0 ? String(messages[0].content ?? '') : '';
    const last = messages.length > 0 ? String(messages[messages.length - 1].content ?? '') : '';

    if (system.includes('protect an elderly person')) {
        return JSON.stringify(classify(last));
    }
    if (system.includes('stages of the scam script')) {
        return JSON.stringify(tagStages());
    }

    // A redraft request arrives as a trailing system message; answering the
    // caller's line again is the right thing either way, so the variant is
    // picked off the message count and the conversation keeps moving.
    return JSON.stringify(respondAsDecoy(last, messages.length));
};

module.exports = {
    createFakeTransport,
    classify,
    tagStages,
    respondAsDecoy,
    detectLanguage,
    RESPONSES,
    DEFAULT_RESPONSE,
    VARIANTS,
};
