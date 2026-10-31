const mongoose = require('mongoose');
const { SUMMARY_FIELDS } = require('../services/extractor');
const { STAGES } = require('../services/stages');

/**
 * One scam-baiting session.
 *
 * Every number stored here is measured, not assigned:
 *   - firstSeenAt / lastSeenAt are server receive times,
 *   - messageCount counts messages actually recorded,
 *   - confidence comes from the Guardian's documented weights.
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
}, { _id: false });

/** The flat per-type lists, built from SUMMARY_FIELDS so the two cannot drift. */
const intelligenceShape = {};
for (const field of Object.values(SUMMARY_FIELDS)) {
    intelligenceShape[field] = { type: [mongoose.Schema.Types.Mixed], default: [] };
}
// Tactic hints. Not evidence, and counted separately from identifiers.
intelligenceShape.suspiciousKeywords = { type: [String], default: [] };

const SessionSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, unique: true, index: true },

    // Guardian state
    stage: {
        type: String,
        enum: ['monitoring', 'engaged', 'stood_down'],
        default: 'monitoring',
    },
    scamDetected: { type: Boolean, default: false },
    confidence: { type: Number, default: 0 }, // 0..1, computed from signals
    scamType: { type: String, default: 'unknown' },
    signals: { type: [String], default: [] }, // which detection rules fired
    handoffAtMessage: { type: Number, default: null }, // message index of the hand-off

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

module.exports = mongoose.models.Session || mongoose.model('Session', SessionSchema);
