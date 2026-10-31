const mongoose = require('mongoose');

/**
 * One scam-baiting session.
 *
 * Every number stored here is measured, not assigned:
 *   - firstSeenAt / lastSeenAt are server receive times,
 *   - messageCount counts messages actually recorded,
 *   - confidence comes from the Guardian's documented weights.
 */
const MessageSchema = new mongoose.Schema({
    role: { type: String, enum: ['scammer', 'decoy', 'guardian', 'user'], required: true },
    text: { type: String, required: true },
    // Caller-supplied time; null when the caller sent none.
    ts: { type: Number, default: null },
    // Server receive time. Always real, so durations never need a fallback.
    receivedAt: { type: Date, default: Date.now },
}, { _id: false });

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

    intelligence: {
        bankAccounts: { type: [String], default: [] },
        upiIds: { type: [String], default: [] },
        phoneNumbers: { type: [String], default: [] },
        phishingLinks: { type: [String], default: [] },
        emailAddresses: { type: [String], default: [] },
        caseIds: { type: [String], default: [] },
        suspiciousKeywords: { type: [String], default: [] },
    },

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

module.exports = mongoose.models.Session || mongoose.model('Session', SessionSchema);
