/**
 * One turn of the system, end to end.
 *
 *   normalize -> extract identifiers -> Guardian assessment -> (Decoy reply) -> persist
 *
 * The Decoy runs only when the Guardian returns ENGAGE. On PASS or WATCH the
 * conversation is left alone and no reply is generated, which is what protects a
 * legitimate caller from being baited.
 *
 * Every counter and duration written here is measured. Nothing is padded.
 */

const Session = require('../models/Session');
const guardian = require('../agents/guardian');
const decoy = require('../agents/decoy');
const intelligence = require('./intelligence');
const logger = require('./logger');
const { normalizeMessage, normalizeHistory } = require('./normalize');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class PipelineError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.name = 'PipelineError';
        this.status = status;
    }
}

/**
 * Loads a session, or builds one and hydrates it from the supplied history.
 *
 * firstSeenAt comes from the earliest real timestamp in the transcript when the
 * caller supplied any, and otherwise from the server's own receive time. It is
 * never back-dated to make a duration look longer.
 */
const loadOrCreate = async ({ sessionId, history, metadata, receivedAt }) => {
    const existing = await Session.findOne({ sessionId });
    if (existing) return { session: existing, created: false };

    const timestamps = history.map((m) => m.ts).filter((ts) => typeof ts === 'number');
    const firstSeenAt = timestamps.length > 0 ? new Date(Math.min(...timestamps)) : receivedAt;

    const session = new Session({
        sessionId,
        firstSeenAt,
        lastSeenAt: receivedAt,
        channel: metadata.channel || 'unknown',
        language: metadata.language || 'English',
        locale: metadata.locale || 'IN',
        messages: history.map((m) => ({
            role: m.role,
            text: m.text,
            ts: m.ts,
            // The transcript was handed to us now; its own ts carries the original time.
            receivedAt: m.ts ? new Date(m.ts) : receivedAt,
        })),
    });

    session.messageCount = session.messages.length;
    session.scammerMessageCount = session.messages.filter((m) => m.role === 'scammer').length;
    session.decoyMessageCount = session.messages.filter((m) => m.role === 'decoy').length;

    return { session, created: true };
};

/**
 * Handles one inbound message.
 *
 * @param {object} body             the request body
 * @param {object} deps             { llm }
 * @returns {Promise<object>}       the turn result
 */
const handleTurn = async (body, deps = {}) => {
    const { llm = null, config = {} } = deps;
    const receivedAt = new Date();

    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!sessionId) throw new PipelineError('sessionId is required.');

    const incoming = normalizeMessage(body?.message, { defaultRole: 'scammer' });
    if (!incoming) throw new PipelineError('message.text is required.');

    const history = normalizeHistory(body?.conversationHistory);
    const metadata = body?.metadata && typeof body.metadata === 'object' ? body.metadata : {};

    const { session, created } = await loadOrCreate({ sessionId, history, metadata, receivedAt });

    // A returning session may carry metadata it did not have on the first turn.
    if (!created) {
        if (metadata.channel) session.channel = metadata.channel;
        if (metadata.language) session.language = metadata.language;
        if (metadata.locale) session.locale = metadata.locale;
    }

    // Record the incoming message.
    session.messages.push({ role: incoming.role, text: incoming.text, ts: incoming.ts, receivedAt });
    session.messageCount += 1;
    if (incoming.role === 'scammer') session.scammerMessageCount += 1;
    session.lastSeenAt = receivedAt;

    // Identifiers, from the scammer side only.
    const scammerMessages = session.messages.filter((m) => m.role === 'scammer');
    const extracted = intelligence.extract(incoming.text);
    const merged = intelligence.mergeInto(session, extracted);

    // On a first contact that arrived with history, scan the back-log too.
    if (created && history.length > 0) {
        for (const message of history.filter((m) => m.role === 'scammer')) {
            intelligence.mergeInto(session, intelligence.extract(message.text));
        }
    }

    // Guardian.
    const assessment = await guardian.assess({
        incomingText: incoming.text,
        priorScammerMessages: scammerMessages.slice(0, -1),
        llm,
        extracted,
    });

    session.confidence = assessment.confidence;
    session.signals = assessment.signalIds;
    if (assessment.scamType && assessment.scamType !== 'unknown') session.scamType = assessment.scamType;

    const wasEngaged = session.stage === 'engaged';
    let handedOffThisTurn = false;

    if (assessment.stage === guardian.STAGES.ENGAGE && session.stage === 'monitoring') {
        session.stage = 'engaged';
        session.scamDetected = true;
        session.handoffAtMessage = session.messageCount;
        handedOffThisTurn = true;
        logger.info(`Hand-off to decoy on session ${sessionId} at message ${session.messageCount} (confidence ${assessment.confidence}).`);
    }

    // A stand-down is a real outcome: the Guardian can withdraw the decoy.
    const limit = session.stage === 'engaged' ? decoy.shouldStandDown(session) : { standDown: false };
    if (limit.standDown) {
        session.stage = 'stood_down';
        logger.info(`Decoy stood down on session ${sessionId}: ${limit.reason}.`);
    }

    // Decoy, only while engaged.
    let decoyResult = null;
    if (session.stage === 'engaged') {
        decoyResult = await decoy.respond({
            session,
            history: session.messages.slice(0, -1),
            incomingText: incoming.text,
            llm,
        });

        session.messages.push({
            role: 'decoy',
            text: decoyResult.reply,
            ts: null,
            receivedAt: new Date(),
        });
        session.messageCount += 1;
        session.decoyMessageCount += 1;
        session.lastAskedTarget = decoyResult.askedFor === 'none' ? null : decoyResult.askedFor;

        if (decoyResult.observed) session.agentNotes = decoyResult.observed;
    }

    if (!session.agentNotes && assessment.classifier.rationale) {
        session.agentNotes = assessment.classifier.rationale;
    }

    session.markModified('messages');
    await session.save();

    // Optional cosmetic pause for a live demo. Defaults to 0, is reported
    // separately, and is excluded from every engagement figure.
    const replyDelayMs = Number.isFinite(config.replyDelayMs) ? config.replyDelayMs : 0;
    if (replyDelayMs > 0 && decoyResult) await sleep(replyDelayMs);

    return {
        sessionId,
        reply: decoyResult ? decoyResult.reply : null,
        action: session.stage === 'engaged' ? 'decoy_engaged' : session.stage,
        guardian: {
            stage: assessment.stage,
            scamDetected: session.scamDetected,
            confidence: assessment.confidence,
            scamType: session.scamType,
            signals: assessment.signals,
            hasHardSignal: assessment.hasHardSignal,
            classifier: assessment.classifier,
            handedOffThisTurn,
            wasAlreadyEngaged: wasEngaged,
        },
        decoy: decoyResult
            ? { askedFor: decoyResult.askedFor, source: decoyResult.source, violations: decoyResult.violations }
            : null,
        measured: {
            messageCount: session.messageCount,
            scammerMessageCount: session.scammerMessageCount,
            decoyMessageCount: session.decoyMessageCount,
            engagementDurationSeconds: session.engagementDurationSeconds(),
            newIdentifiersThisTurn: merged.identifiers,
            newKeywordsThisTurn: merged.keywords,
            simulatedReplyDelayMs: replyDelayMs,
        },
        intelligence: session.intelligence.toObject
            ? session.intelligence.toObject()
            : session.intelligence,
    };
};

module.exports = { handleTurn, PipelineError, loadOrCreate };
