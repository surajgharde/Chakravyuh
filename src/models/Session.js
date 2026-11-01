const mongoose = require('mongoose');
const { SUMMARY_FIELDS } = require('../services/extractor');
const { STAGES } = require('../services/stages');

/**
 * One scam-baiting session.
 *
 * Every number stored here is measured, not assigned:
 *   - firstSeenAt / lastSeenAt are server receive times,
 *   - messageCount counts messages actually recorded,
 *   - score is the sum of the Guardian's fixed signal weights, and
 *     scoreBreakdown records which ones produced it.
 */

/** A stage tag, with the method that produced it. */
const StageTagSchema = new mongoose.Schema({
    stage: { type: String, enum: STAGES, required: true },
    method: { type: String, enum: ['rules', 'llm'], required: true },
    evidence: { type: String, default: '' },
}, { _id: false });

const MessageSchema = new mongoose.Schema({
    // Stable within the session ("m1", "m2", ...), so an entity can point back
    // to the message it was found in.
    messageId: { type: String, required: true },
    role: { type: String, enum: ['scammer', 'decoy', 'guardian', 'user'], required: true },
    text: { type: String, required: true },
    // Caller-supplied time; null when the caller sent none.
    ts: { type: Number, default: null },
    // Server receive time. Always real, so durations never need a fallback.
    receivedAt: { type: Date, default: Date.now },
    // Script stages, scammer-side messages only.
    stages: { type: [StageTagSchema], default: [] },
}, { _id: false });

/**
 * One extracted entity, with its full provenance. The sentence is kept
 * verbatim so a report can be audited line by line against the transcript.
 */
const EntitySchema = new mongoose.Schema({
    type: { type: String, required: true },
    raw: { type: String, required: true },
    // String for identifiers, number for an amount in whole rupees.
    normalized: { type: mongoose.Schema.Types.Mixed, required: true },
    sessionId: { type: String, required: true },
    messageId: { type: String, default: null },
    timestamp: { type: Date, default: null },
    sentence: { type: String, default: '' },
    method: { type: String, default: 'rules' },
    meta: { type: mongoose.Schema.Types.Mixed, default: undefined },

    // How many times this identifier was said. The record itself is kept once,
    // with the FIRST sighting's provenance, because that is what an evidence
    // report quotes; the count is what shows a number was repeated.
    occurrences: { type: Number, default: 1 },
    lastSeenAt: { type: Date, default: null },
    lastMessageId: { type: String, default: null },
}, { _id: false });

/** The flat per-type lists, built from SUMMARY_FIELDS so the two cannot drift. */
const intelligenceShape = {};
for (const field of Object.values(SUMMARY_FIELDS)) {
    intelligenceShape[field] = { type: [mongoose.Schema.Types.Mixed], default: [] };
}
// Tactic hints. Not evidence, and counted separately from identifiers.
intelligenceShape.suspiciousKeywords = { type: [String], default: [] };

/**
 * One Guardian decision, kept per scored message.
 *
 * The report needs the whole decision history, not just the latest score: a
 * cybercrime unit reading it has to be able to see when the system decided to
 * engage and on what basis.
 *
 * `partial` marks a decision taken on a half-finished sentence during a voice
 * call. Those are logged only when they moved the state, and marked as such,
 * because the text they were taken on is not in the transcript - speech
 * recognition had not finished the sentence yet.
 */
const GuardianLogEntrySchema = new mongoose.Schema({
    at: { type: Date, default: Date.now },
    messageId: { type: String, default: null },
    partial: { type: Boolean, default: false },
    score: { type: Number, required: true },
    state: { type: String, required: true },
    previousState: { type: String, default: null },
    stateChanged: { type: Boolean, default: false },
    firedSignals: { type: [String], default: [] },
    hardSignals: { type: [String], default: [] },
    classifierLabel: { type: String, default: 'unavailable' },
    classifierReasons: { type: [String], default: [] },
    notes: { type: [String], default: [] },
    decisionMs: { type: Number, default: 0 },
}, { _id: false });

/**
 * One decoy draft the output guard refused to send.
 *
 * Kept per block, not per turn: a turn can produce two blocked drafts before
 * the decoy gives up and says a scripted line, and both are worth seeing.
 *
 * `redactedDraft` is the draft with every digit masked and every link and
 * handle removed. The draft was blocked because of what was in it, so storing
 * it verbatim would move the leak from the wire into the database and from
 * there into any exported report. What is kept shows the shape of the mistake
 * without carrying the dangerous part.
 */
const GuardBlockSchema = new mongoose.Schema({
    at: { type: Date, default: Date.now },
    messageId: { type: String, default: null },
    attempt: { type: Number, default: 1 },
    ruleIds: { type: [String], default: [] },
    reasons: { type: [String], default: [] },
    redactedDraft: { type: String, default: '' },
}, { _id: false });

/** One fact the persona has claimed, and when she claimed it. */
const LedgerEntrySchema = new mongoose.Schema({
    slot: { type: String, required: true },
    value: { type: String, required: true },
    source: { type: String, default: 'reply' }, // persona | reply
    turn: { type: Number, default: 0 },
    messageId: { type: String, default: null },
    statedAt: { type: Date, default: Date.now },
}, { _id: false });

/** One use of a stalling excuse, for the cooldown window. */
const ExcuseUseSchema = new mongoose.Schema({
    id: { type: String, required: true },
    turn: { type: Number, default: 0 },
}, { _id: false });

/** One rule signal that fired, with the weight it contributed. */
const ScoreLineSchema = new mongoose.Schema({
    id: { type: String, required: true },
    label: { type: String, default: '' },
    weight: { type: Number, required: true },
    hard: { type: Boolean, default: false },
    description: { type: String, default: '' },
}, { _id: false });

const SessionSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, unique: true, index: true },

    // Which protected user this conversation belongs to, and who is on the
    // other end (normalised, so it can be matched against trusted contacts).
    userId: { type: String, default: 'default-user', index: true },
    counterpartId: { type: String, default: null, index: true },

    // Guardian state machine.
    guardianState: {
        type: String,
        enum: ['MONITORING', 'SUSPICIOUS', 'DECOY_ACTIVE', 'ENDED', 'LEGIT', 'FALSE_POSITIVE'],
        default: 'MONITORING',
    },

    scamDetected: { type: Boolean, default: false },
    scamType: { type: String, default: 'unknown' },

    // The rule score, 0-100, with the breakdown that produced it. There is no
    // separate probability: this and the classifier label are the confidence.
    score: { type: Number, default: 0 },
    scoreBreakdown: { type: [ScoreLineSchema], default: [] },
    firedSignals: { type: [String], default: [] },
    classifierLabel: { type: String, default: 'unavailable' },
    classifierReasons: { type: [String], default: [] },

    handoffAtMessage: { type: Number, default: null }, // message index of the hand-off
    takeoverAt: { type: Date, default: null },

    // Every scored message, in order. The evidence report prints this.
    guardianLog: { type: [GuardianLogEntrySchema], default: [] },

    // Every decoy draft the output guard refused to send, with the rule it
    // broke. This is the record of what the system declined to say.
    guardLog: { type: [GuardBlockSchema], default: [] },

    // Set when the protected user pressed "This is genuine".
    falsePositive: {
        markedAt: { type: Date, default: null },
        markedByUser: { type: Boolean, default: false },
        previousState: { type: String, default: null },
        reason: { type: String, default: null },
    },

    // Measured counters
    messageCount: { type: Number, default: 0 },
    scammerMessageCount: { type: Number, default: 0 },
    decoyMessageCount: { type: Number, default: 0 },

    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },

    channel: { type: String, default: 'unknown' },
    language: { type: String, default: 'English' },
    locale: { type: String, default: 'IN' },

    // Flat lists for reporting; derived from `entities`.
    intelligence: intelligenceShape,

    // The evidence itself, one record per identifier occurrence.
    entities: { type: [EntitySchema], default: [] },

    // Every script stage seen anywhere in the session, in taxonomy order.
    scriptStages: { type: [String], default: [] },

    messages: { type: [MessageSchema], default: [] },

    agentNotes: { type: String, default: '' },

    // Which identifier the decoy asked for last, so it can switch target
    // instead of repeating a question that went unanswered.
    lastAskedTarget: { type: String, default: null },

    // Every fact the persona has claimed in this session. Injected into each
    // prompt and checked against each draft, so she cannot contradict herself.
    personaLedger: { type: [LedgerEntrySchema], default: [] },

    // Which stalling excuses have been used, and on which decoy turn, so none
    // is reused inside the cooldown window.
    excuseHistory: { type: [ExcuseUseSchema], default: [] },

    // The persona file in force for this session.
    personaId: { type: String, default: 'default' },

    /**
     * The report is never filed automatically and never marked ready to file
     * until a family member has actually read it.
     */
    report: {
        reviewedByFamily: { type: Boolean, default: false },
        reviewedAt: { type: Date, default: null },
        reviewedBy: { type: String, default: null }, // an alias or relationship, never a real name
    },

    // Set on synthetic sessions created by scripts/seed-demo.js, so a seeded
    // demo session is never mistaken for a real incident.
    seeded: { type: Boolean, default: false },
    seedNote: { type: String, default: null },

    // Alias used in every report. The protected user's real name and number
    // never appear in an exported document.
    userAlias: { type: String, default: null },
}, { timestamps: true });

/**
 * Engagement duration in whole seconds, measured from real server receive
 * times. Returns 0 for a single-message session because that is the truth:
 * nothing has elapsed yet.
 */
SessionSchema.methods.engagementDurationSeconds = function engagementDurationSeconds() {
    const first = new Date(this.firstSeenAt).getTime();
    const last = new Date(this.lastSeenAt).getTime();
    if (!Number.isFinite(first) || !Number.isFinite(last)) return 0;
    return Math.max(0, Math.round((last - first) / 1000));
};

/** The next message id for this session. */
SessionSchema.methods.nextMessageId = function nextMessageId() {
    return `m${this.messages.length + 1}`;
};

/** True while the decoy holds the conversation. */
SessionSchema.methods.isEngaged = function isEngaged() {
    return this.guardianState === 'DECOY_ACTIVE';
};

module.exports = mongoose.models.Session || mongoose.model('Session', SessionSchema);
