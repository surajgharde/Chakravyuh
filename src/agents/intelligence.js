/**
 * Intelligence agent.
 *
 * Turns a finished session into an evidence report a cybercrime unit can act
 * on, and that a family member can read and check.
 *
 * Three rules shape everything here:
 *
 *   1. NOTHING IS INVENTED. Every number, quote and timestamp is read out of
 *      the stored session. There is no model call in this file at all - a
 *      report that goes to the 1930 helpline with a guessed figure in it is
 *      worse than no report.
 *
 *   2. NOTHING IS SUBMITTED. The report is produced locally, in JSON, HTML and
 *      PDF. There is no outbound call to 1930, to cybercrime.gov.in, or
 *      anywhere else, and there is no code path that could add one.
 *
 *   3. THE PROTECTED USER IS NOT IN IT. They appear as an alias. Their name and
 *      number never reach an exported document.
 *
 * A report is only marked ready to file once a family member has ticked that
 * they have read it.
 */

const crypto = require('node:crypto');

const guardian = require('./guardian');
const stages = require('../services/stages');

// ---------------------------------------------------------------------------
// Scam categories, as a complaint form would name them
// ---------------------------------------------------------------------------

const CATEGORIES = {
    DIGITAL_ARREST: 'digital arrest',
    KYC_BANK: 'KYC / bank',
    PARCEL_CUSTOMS: 'parcel / customs',
    INVESTMENT: 'investment',
    JOB_TASK: 'job / task',
    LOAN_APP: 'loan app',
    LOTTERY: 'lottery',
    SEXTORTION: 'sextortion',
    OTHER: 'other',
};

/** The Guardian's internal families mapped onto report categories. */
const CATEGORY_FROM_SCAM_TYPE = {
    digital_arrest: CATEGORIES.DIGITAL_ARREST,
    sextortion: CATEGORIES.SEXTORTION,
    loan_app_scam: CATEGORIES.LOAN_APP,
    courier_scam: CATEGORIES.PARCEL_CUSTOMS,
    investment_scam: CATEGORIES.INVESTMENT,
    job_scam: CATEGORIES.JOB_TASK,
    lottery_scam: CATEGORIES.LOTTERY,
    bank_fraud: CATEGORIES.KYC_BANK,
    upi_fraud: CATEGORIES.KYC_BANK,
    tech_support_scam: CATEGORIES.OTHER,
    utility_scam: CATEGORIES.OTHER,
    phishing: CATEGORIES.OTHER,
    unknown: CATEGORIES.OTHER,
};

/**
 * The category, decided from the stored transcript.
 *
 * The Guardian's own classification is used where it maps cleanly. Where it
 * does not, the scammer's text decides, because the report category has to be
 * the one a complaint form offers rather than an internal label.
 */
const categorize = (session) => {
    const counterpartText = scammerMessages(session).map((m) => m.text).join('\n');
    const scamType = session.scamType && session.scamType !== 'unknown'
        ? session.scamType
        : guardian.classifyScamType(counterpartText);

    const mapped = CATEGORY_FROM_SCAM_TYPE[scamType] || CATEGORIES.OTHER;

    // A parcel story runs under a police or customs banner; the parcel is what
    // a complaint form would call it.
    if (mapped === CATEGORIES.DIGITAL_ARREST
        && /\b(parcel|courier|consignment|fedex|dhl|bluedart|customs)\b/i.test(counterpartText)) {
        return { category: CATEGORIES.PARCEL_CUSTOMS, scamType, basis: 'guardian classification, narrowed by the parcel story in the transcript' };
    }

    return { category: mapped, scamType, basis: 'guardian classification of the stored transcript' };
};

// ---------------------------------------------------------------------------
// Payment channels
// ---------------------------------------------------------------------------

/** Which route the money was asked to travel, inferred from the identifiers found. */
const PAYMENT_CHANNELS = [
    { id: 'upi', label: 'UPI', when: (intel) => (intel.upiIds || []).length > 0 },
    { id: 'bank_transfer', label: 'Bank transfer (NEFT/IMPS/RTGS)', when: (intel) => (intel.bankAccounts || []).length > 0 },
    { id: 'crypto', label: 'Cryptocurrency wallet', when: (intel) => (intel.cryptoWallets || []).length > 0 },
    { id: 'app_install', label: 'Remote-access or APK install', when: (intel) => (intel.apkLinks || []).length > 0 },
    { id: 'phishing_link', label: 'Payment or login link', when: (intel) => (intel.phishingLinks || []).length > 0 },
];

const paymentChannels = (session) => PAYMENT_CHANNELS
    .filter((channel) => {
        try {
            return channel.when(session.intelligence || {});
        } catch {
            return false;
        }
    })
    .map(({ id, label }) => ({ id, label }));

// ---------------------------------------------------------------------------
// Helpers over the stored session
// ---------------------------------------------------------------------------

const scammerMessages = (session) => (session.messages || []).filter((m) => m.role === 'scammer');

const asDate = (value) => (value instanceof Date ? value : (value ? new Date(value) : null));
const iso = (value) => {
    const date = asDate(value);
    return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
};

/** An excerpt short enough to print, long enough to be evidence. */
const excerpt = (text, limit = 220) => {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    return clean.length <= limit ? clean : `${clean.slice(0, limit - 3)}...`;
};

/**
 * The alias used in the report. Derived from the stored alias if there is one,
 * and otherwise from the userId - which is an opaque id, not a name.
 */
const aliasFor = (session) => {
    if (session.userAlias) return session.userAlias;
    const id = String(session.userId || 'unknown');
    const digest = crypto.createHash('sha256').update(id).digest('hex').slice(0, 6).toUpperCase();
    return `Protected User ${digest}`;
};

// ---------------------------------------------------------------------------
// Transcript and its hash
// ---------------------------------------------------------------------------

const ROLE_LABELS = {
    scammer: 'CALLER',
    decoy: 'DECOY',
    user: 'PROTECTED USER',
    guardian: 'GUARDIAN',
};

/** The full transcript, timestamped, in order. */
const buildTranscript = (session) => (session.messages || []).map((message) => ({
    messageId: message.messageId,
    role: message.role,
    speaker: ROLE_LABELS[message.role] || message.role,
    at: iso(message.receivedAt),
    callerTimestamp: message.ts ?? null,
    text: message.text,
    stages: (message.stages || []).map((tag) => tag.stage),
}));

/**
 * A canonical rendering of the transcript, for hashing.
 *
 * Deliberately not JSON.stringify of the whole object: key order and added
 * fields would change the hash without the transcript changing. This is only
 * the things that make a transcript what it is.
 */
const canonicalTranscript = (transcript) => transcript
    .map((line) => [line.messageId, line.role, line.at ?? '', line.text].join(''))
    .join('');

/** SHA-256 over the canonical transcript, so tampering is detectable. */
const transcriptHash = (transcript) => ({
    algorithm: 'sha256',
    value: crypto.createHash('sha256').update(canonicalTranscript(transcript), 'utf8').digest('hex'),
    lineCount: transcript.length,
    note: 'Computed over message id, role, receive time and text, in order. '
        + 'Any edit to the transcript changes this value.',
});

// ---------------------------------------------------------------------------
// Suspect identifiers
// ---------------------------------------------------------------------------

/** Entity types that identify the suspect, in the order a report should list them. */
const SUSPECT_TYPES = [
    'phone', 'upiId', 'bankAccount', 'ifsc', 'cryptoWallet',
    'url', 'apkLink', 'email', 'caseRef', 'officerId',
];

const TYPE_LABELS = {
    phone: 'Phone number',
    upiId: 'UPI ID',
    bankAccount: 'Bank account',
    ifsc: 'IFSC code',
    cryptoWallet: 'Crypto wallet',
    url: 'Link',
    apkLink: 'APK / app link',
    email: 'Email address',
    caseRef: 'Case / FIR number quoted',
    officerId: 'Officer ID quoted',
    amount: 'Amount demanded',
    impersonatedAuthority: 'Authority impersonated',
    aadhaar: 'Aadhaar quoted',
    pan: 'PAN quoted',
};

/**
 * The identifiers table.
 *
 * Each row is one entity record, with the sentence it was first found in. The
 * `timesRepeated` column comes from the occurrence counter the extractor keeps,
 * so a number the caller said five times is visibly insisted upon.
 */
const suspectIdentifiers = (session) => (session.entities || [])
    .filter((entity) => SUSPECT_TYPES.includes(entity.type))
    .sort((a, b) => SUSPECT_TYPES.indexOf(a.type) - SUSPECT_TYPES.indexOf(b.type))
    .map((entity) => ({
        type: entity.type,
        label: TYPE_LABELS[entity.type] || entity.type,
        value: entity.normalized,
        asWritten: entity.raw,
        firstSeenAt: iso(entity.timestamp),
        firstSeenInMessage: entity.messageId,
        excerpt: excerpt(entity.sentence),
        timesRepeated: entity.occurrences || 1,
        lastSeenAt: iso(entity.lastSeenAt) || iso(entity.timestamp),
        extractedBy: entity.method || 'rules',
        ...(entity.meta ? { details: entity.meta } : {}),
    }));

const moneyDemanded = (session) => {
    const amounts = (session.entities || [])
        .filter((entity) => entity.type === 'amount')
        .map((entity) => ({
            rupees: Number(entity.normalized),
            asWritten: entity.raw,
            firstSeenAt: iso(entity.timestamp),
            excerpt: excerpt(entity.sentence),
            timesRepeated: entity.occurrences || 1,
        }))
        .sort((a, b) => b.rupees - a.rupees);

    return {
        amounts,
        // The largest figure actually said. Not a total: the same sum demanded
        // three times is one demand, and adding them up would overstate it.
        highestRupees: amounts.length > 0 ? amounts[0].rupees : null,
        currency: 'INR',
    };
};

const impersonatedAuthorities = (session) => (session.entities || [])
    .filter((entity) => entity.type === 'impersonatedAuthority')
    .map((entity) => ({
        authority: entity.normalized,
        asWritten: entity.raw,
        firstSeenAt: iso(entity.timestamp),
        excerpt: excerpt(entity.sentence),
    }));

// ---------------------------------------------------------------------------
// Script stages
// ---------------------------------------------------------------------------

/**
 * The stages in the order they first appeared, each with one real example line
 * from the transcript.
 */
const scriptTimeline = (session) => {
    const seen = new Map();

    for (const message of scammerMessages(session)) {
        for (const tag of message.stages || []) {
            if (seen.has(tag.stage)) continue;
            seen.set(tag.stage, {
                stage: tag.stage,
                description: stages.STAGE_DESCRIPTIONS[tag.stage] || '',
                firstSeenAt: iso(message.receivedAt),
                inMessage: message.messageId,
                example: excerpt(tag.evidence && tag.evidence.length > 0 ? tag.evidence : message.text),
                taggedBy: tag.method,
            });
        }
    }

    return [...seen.values()];
};

// ---------------------------------------------------------------------------
// Guardian decision log
// ---------------------------------------------------------------------------

const decisionLog = (session) => (session.guardianLog || []).map((entry) => ({
    at: iso(entry.at),
    messageId: entry.messageId,
    score: entry.score,
    state: entry.state,
    previousState: entry.previousState,
    stateChanged: entry.stateChanged,
    firedSignals: entry.firedSignals,
    hardSignals: entry.hardSignals,
    classifier: { label: entry.classifierLabel, reasons: entry.classifierReasons },
    reasons: entry.notes,
    decisionMs: entry.decisionMs,
}));

// ---------------------------------------------------------------------------
// agentNotes
// ---------------------------------------------------------------------------

const list = (values) => {
    const items = values.filter(Boolean);
    if (items.length === 0) return '';
    if (items.length === 1) return items[0];
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
};

const rupees = (value) => `Rs ${Number(value).toLocaleString('en-IN')}`;

/**
 * A plain-language summary, assembled from the stored data only.
 *
 * Every clause is guarded by the presence of the thing it describes, so the
 * summary cannot state a fact the session does not contain. There is no model
 * call here: a sentence generated from a prompt could add a plausible detail
 * that was never said, and this text goes into a police complaint.
 */
const buildAgentNotes = (session) => {
    const sentences = [];

    const { category } = categorize(session);
    const authorities = impersonatedAuthorities(session).map((a) => a.authority);
    const counterpartCount = scammerMessages(session).length;
    const channel = session.channel && session.channel !== 'unknown' ? session.channel : null;

    // 1. What happened.
    const opening = [`A ${category} attempt was received`];
    if (channel) opening.push(`over ${channel}`);
    if (authorities.length > 0) opening.push(`from someone presenting as ${list([...new Set(authorities)])}`);
    sentences.push(`${opening.join(' ')}.`);

    // 2. What was demanded.
    const money = moneyDemanded(session);
    const channels = paymentChannels(session).map((c) => c.label);
    if (money.highestRupees !== null) {
        sentences.push(
            channels.length > 0
                ? `The caller asked for ${rupees(money.highestRupees)}, to be paid by ${list(channels)}.`
                : `The caller asked for ${rupees(money.highestRupees)}.`
        );
    } else if (channels.length > 0) {
        sentences.push(`The caller pushed for payment by ${list(channels)}.`);
    }

    // 3. What tactics were used, named from the stage tags that actually fired.
    const stageList = scriptTimeline(session).map((s) => s.stage);
    const tactics = [];
    if (stageList.includes('THREAT')) tactics.push('threats of arrest or legal action');
    if (stageList.includes('ACCUSATION')) tactics.push('an accusation of a crime');
    if (stageList.includes('ISOLATION')) tactics.push('instructions to tell nobody and stay on the line');
    if (stageList.includes('URGENCY')) tactics.push('an artificial deadline');
    if (stageList.includes('CREDENTIAL_REQUEST')) tactics.push('a request for an OTP or PIN');
    if (stageList.includes('VERIFICATION_LURE')) tactics.push('a claim that the money was refundable');
    if (tactics.length > 0) sentences.push(`Tactics used: ${list(tactics)}.`);

    // 4. What was recovered.
    const identifiers = suspectIdentifiers(session);
    if (identifiers.length > 0) {
        const byType = new Map();
        for (const row of identifiers) byType.set(row.type, (byType.get(row.type) || 0) + 1);
        const parts = [...byType.entries()].map(([type, count]) => {
            const label = (TYPE_LABELS[type] || type).toLowerCase();
            return count === 1 ? `1 ${label}` : `${count} ${label}s`;
        });
        sentences.push(`Recovered from the caller: ${list(parts)}.`);
    } else {
        sentences.push('No suspect identifiers were recovered from the caller.');
    }

    // 5. What the system did.
    if (session.guardianState === guardian.STATES.FALSE_POSITIVE) {
        sentences.push('The protected user marked this conversation as genuine, so it is recorded as a false positive.');
    } else if (session.takeoverAt) {
        const duration = durationSeconds(session);
        sentences.push(
            `The decoy held the conversation for ${duration} seconds across `
            + `${counterpartCount} caller message${counterpartCount === 1 ? '' : 's'}.`
        );
    } else {
        sentences.push('The decoy was not engaged; the conversation was only monitored.');
    }

    return sentences.join(' ');
};

// ---------------------------------------------------------------------------
// Durations and counts
// ---------------------------------------------------------------------------

const durationSeconds = (session) => {
    if (typeof session.engagementDurationSeconds === 'function') return session.engagementDurationSeconds();
    const first = asDate(session.firstSeenAt);
    const last = asDate(session.lastSeenAt);
    if (!first || !last) return 0;
    return Math.max(0, Math.round((last.getTime() - first.getTime()) / 1000));
};

const humanDuration = (totalSeconds) => {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes === 0) return `${seconds}s`;
    return `${minutes}m ${seconds}s`;
};

// ---------------------------------------------------------------------------
// Recommended actions
// ---------------------------------------------------------------------------

const recommendedActions = (session) => {
    const intel = session.intelligence || {};
    const actions = [
        {
            priority: 1,
            action: 'Call 1930 now',
            detail: 'The national cyber-fraud helpline. Speed matters more than completeness: '
                + 'a reported mule account can be frozen before the money is moved on.',
        },
        {
            priority: 2,
            action: 'File a complaint at cybercrime.gov.in',
            detail: 'Use the "For cybercrime.gov.in" section of this report to fill the form. '
                + 'Attach this report as the incident description.',
        },
    ];

    const accounts = intel.bankAccounts || [];
    const upis = intel.upiIds || [];
    if (accounts.length > 0 || upis.length > 0) {
        actions.push({
            priority: 3,
            action: 'Ask the bank to place a hold on the listed accounts',
            detail: `Quote these to the bank's fraud desk: ${[...accounts, ...upis].join(', ')}.`
                + ' A hold is only useful before the funds are withdrawn.',
        });
    }

    const phones = intel.phoneNumbers || [];
    if (phones.length > 0) {
        actions.push({
            priority: actions.length + 1,
            action: 'Block the caller numbers',
            detail: `On the phone and with the operator: ${phones.join(', ')}.`,
        });
    }

    actions.push({
        priority: actions.length + 1,
        action: 'Do not call the caller back',
        detail: 'Anything the caller said about a case, a refund or a deadline was part of the script.',
    });

    return actions;
};

// ---------------------------------------------------------------------------
// The cybercrime.gov.in mapping
// ---------------------------------------------------------------------------

/** Complaint-form categories as the portal words them. */
const PORTAL_CATEGORY = {
    [CATEGORIES.DIGITAL_ARREST]: 'Online Financial Fraud > Cheating by impersonation (digital arrest)',
    [CATEGORIES.KYC_BANK]: 'Online Financial Fraud > Internet Banking / UPI related fraud',
    [CATEGORIES.PARCEL_CUSTOMS]: 'Online Financial Fraud > Cheating by impersonation (courier / customs)',
    [CATEGORIES.INVESTMENT]: 'Online Financial Fraud > Online investment / trading fraud',
    [CATEGORIES.JOB_TASK]: 'Online Financial Fraud > Fraud involving job offers / task-based work',
    [CATEGORIES.LOAN_APP]: 'Online Financial Fraud > Fraudulent loan app / recovery harassment',
    [CATEGORIES.LOTTERY]: 'Online Financial Fraud > Lottery / prize fraud',
    [CATEGORIES.SEXTORTION]: 'Women / Child Related Crime > Sextortion',
    [CATEGORIES.OTHER]: 'Online Financial Fraud > Other',
};

/**
 * Our data laid out against the fields the complaint form asks for, so a family
 * member can fill the form by copying across rather than re-reading a
 * transcript.
 *
 * Nothing here is submitted. These are values to be typed in by a person.
 */
const portalMapping = (session, { category, transcript, hash }) => {
    const intel = session.intelligence || {};
    const first = asDate(session.firstSeenAt);

    return {
        note: 'For a person to copy into the form at cybercrime.gov.in. Nothing is submitted automatically.',
        incidentDate: first ? first.toISOString().slice(0, 10) : null,
        incidentTime: first ? first.toISOString().slice(11, 16) : null,
        timezone: 'Asia/Kolkata (times shown in UTC in this report)',
        category: PORTAL_CATEGORY[category] || PORTAL_CATEGORY[CATEGORIES.OTHER],
        whereDidItHappen: session.channel && session.channel !== 'unknown' ? session.channel : 'Phone call or chat',
        suspectMobileNumbers: intel.phoneNumbers || [],
        suspectUpiIds: intel.upiIds || [],
        suspectBankAccounts: intel.bankAccounts || [],
        suspectIfscCodes: intel.ifscCodes || [],
        suspectWebsites: [...(intel.phishingLinks || []), ...(intel.apkLinks || [])],
        suspectEmailAddresses: intel.emailAddresses || [],
        amountInvolved: moneyDemanded(session).highestRupees,
        amountLost: 0,
        amountLostNote: 'Nothing was paid. The decoy never transfers money and holds no credentials.',
        description: buildAgentNotes(session),
        evidenceAttached: [
            `Full transcript, ${transcript.length} messages, SHA-256 ${hash.value}`,
            'Identifier table with the exact sentence each value appeared in',
            'Guardian decision log',
        ],
    };
};

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const REPORT_VERSION = 1;

/**
 * Builds the report for a session.
 *
 * Pure: it reads the session and returns an object. It writes nothing, sends
 * nothing, and calls no model.
 *
 * @param {object} session         a Session document, or a plain object shaped like one
 * @param {object} [options]       { generatedAt } - injectable for deterministic tests
 */
const buildReport = (session, options = {}) => {
    const generatedAt = options.generatedAt ? asDate(options.generatedAt) : new Date();

    const transcript = buildTranscript(session);
    const hash = transcriptHash(transcript);
    const { category, scamType, basis } = categorize(session);

    const counterpart = scammerMessages(session);
    const decoyCount = (session.messages || []).filter((m) => m.role === 'decoy').length;
    const seconds = durationSeconds(session);

    const reviewed = Boolean(session.report && session.report.reviewedByFamily);

    const report = {
        reportVersion: REPORT_VERSION,
        reportId: reportIdFor(session, generatedAt),
        generatedAt: generatedAt.toISOString(),

        // Who was protected, as an alias. Never a name or a number.
        protectedUser: {
            alias: aliasFor(session),
            note: 'The protected user is identified by an alias only. Their name and '
                + 'phone number do not appear anywhere in this report.',
        },

        session: {
            sessionId: session.sessionId,
            channel: session.channel || 'unknown',
            language: session.language || null,
            locale: session.locale || null,
            startedAt: iso(session.firstSeenAt),
            endedAt: iso(session.lastSeenAt),
            durationSeconds: seconds,
            durationHuman: humanDuration(seconds),
            durationNote: 'Measured from the first to the last message receive time. Not padded.',
            messageCounts: {
                total: session.messageCount || (session.messages || []).length,
                fromCaller: counterpart.length,
                fromDecoy: decoyCount,
            },
            guardianState: session.guardianState,
            takeoverAt: iso(session.takeoverAt),
            handoffAtMessage: session.handoffAtMessage ?? null,
        },

        classification: {
            category,
            internalScamType: scamType,
            basis,
            authoritiesImpersonated: impersonatedAuthorities(session),
        },

        suspectIdentifiers: suspectIdentifiers(session),
        moneyDemanded: moneyDemanded(session),
        paymentChannelsRequested: paymentChannels(session),
        scriptStages: scriptTimeline(session),
        guardianDecisionLog: decisionLog(session),

        transcript,
        transcriptHash: hash,

        agentNotes: buildAgentNotes(session),

        recommendedActions: recommendedActions(session),
        forCybercrimePortal: portalMapping(session, { category, transcript, hash }),

        review: {
            reviewedByFamily: reviewed,
            reviewedAt: iso(session.report && session.report.reviewedAt),
            reviewedBy: (session.report && session.report.reviewedBy) || null,
            readyToFile: reviewed,
            gate: 'A family member must confirm they have read this report before it '
                + 'is marked ready to file. Until then it is a draft.',
        },

        disclosure: {
            autoSubmitted: false,
            note: 'This report was generated locally and sent nowhere. Filing it with '
                + '1930 or cybercrime.gov.in is a decision for the family to take.',
        },
    };

    return report;
};

/**
 * A stable report id: the session and the generation time. Two reports of the
 * same session at the same instant are the same report.
 */
const reportIdFor = (session, generatedAt) => {
    const stamp = asDate(generatedAt).toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
    const digest = crypto.createHash('sha256')
        .update(`${session.sessionId}:${stamp}`)
        .digest('hex')
        .slice(0, 8)
        .toUpperCase();
    return `CHKV-${stamp}-${digest}`;
};

/**
 * Records that a family member has read the report.
 * Mutates the session; the caller saves it.
 */
const markReviewed = (session, { reviewedBy = 'family member' } = {}) => {
    session.report = {
        reviewedByFamily: true,
        reviewedAt: new Date(),
        // A relationship or alias. A real name is not needed and is not stored.
        reviewedBy: String(reviewedBy).slice(0, 60),
    };
    if (session.markModified) session.markModified('report');
    return session.report;
};

module.exports = {
    buildReport,
    buildAgentNotes,
    markReviewed,
    categorize,
    suspectIdentifiers,
    moneyDemanded,
    paymentChannels,
    scriptTimeline,
    decisionLog,
    buildTranscript,
    transcriptHash,
    canonicalTranscript,
    recommendedActions,
    portalMapping,
    aliasFor,
    humanDuration,
    CATEGORIES,
    CATEGORY_FROM_SCAM_TYPE,
    PORTAL_CATEGORY,
    SUSPECT_TYPES,
    TYPE_LABELS,
    REPORT_VERSION,
};
