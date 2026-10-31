/**
 * One turn of the system, end to end.
 *
 *   normalize -> extract entities -> tag script stages -> GUARDIAN -> (DECOY) -> persist
 *
 * The Guardian owns the session state. The Decoy runs only when the Guardian
 * has put the session in DECOY_ACTIVE. In MONITORING, SUSPICIOUS, LEGIT, ENDED
 * or FALSE_POSITIVE no reply is generated at all, which is what keeps a real
 * caller from ever being baited.
 *
 * Every counter and duration written here is measured. Nothing is padded.
 */

const Session = require('../models/Session');
const guardian = require('../agents/guardian');
const decoy = require('../agents/decoy');
const extractor = require('./extractor');
const intelligence = require('../agents/intelligence');
const stages = require('./stages');
const logger = require('./logger');
const trustedContacts = require('./trustedContacts');
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
const loadOrCreate = async ({ sessionId, history, metadata, receivedAt, userId }) => {
    const existing = await Session.findOne({ sessionId });
    if (existing) return { session: existing, created: false };

    const timestamps = history.map((m) => m.ts).filter((ts) => typeof ts === 'number');
    const firstSeenAt = timestamps.length > 0 ? new Date(Math.min(...timestamps)) : receivedAt;

    const session = new Session({
        sessionId,
        userId,
        firstSeenAt,
        lastSeenAt: receivedAt,
        channel: metadata.channel || 'unknown',
        language: metadata.language || 'English',
        locale: metadata.locale || 'IN',
        messages: history.map((m, index) => ({
            messageId: `m${index + 1}`,
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

/** Records every script stage seen in the session, in taxonomy order. */
const refreshScriptStages = (session) => {
    const seen = new Set();
    for (const message of session.messages) {
        for (const tag of message.stages || []) seen.add(tag.stage);
    }
    session.scriptStages = stages.STAGES.filter((stage) => seen.has(stage));
};

/**
 * Where the caller's identity comes from. `metadata.from` is the number or
 * handle the message arrived on; it is what trusted contacts are matched
 * against.
 */
const callerIdFrom = (metadata, message) => metadata.from
    ?? metadata.sender
    ?? metadata.callerId
    ?? message?.from
    ?? null;

/**
 * Handles one inbound message.
 *
 * @param {object} body   the request body
 * @param {object} deps   { llm, config, events }
 * @returns {Promise<object>} the turn result
 */
const handleTurn = async (body, deps = {}) => {
    const { llm = null, config = {}, events = null } = deps;
    const receivedAt = new Date();

    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!sessionId) throw new PipelineError('sessionId is required.');

    const incoming = normalizeMessage(body?.message, { defaultRole: 'scammer' });
    if (!incoming) throw new PipelineError('message.text is required.');

    const history = normalizeHistory(body?.conversationHistory);
    const metadata = body?.metadata && typeof body.metadata === 'object' ? body.metadata : {};
    const userId = (metadata.userId || body?.userId || trustedContacts.DEFAULT_USER_ID).toString();
    const from = callerIdFrom(metadata, body?.message);

    const { session, created } = await loadOrCreate({ sessionId, history, metadata, receivedAt, userId });

    // A returning session may carry metadata it did not have on the first turn.
    if (!created) {
        if (metadata.channel) session.channel = metadata.channel;
        if (metadata.language) session.language = metadata.language;
        if (metadata.locale) session.locale = metadata.locale;
    }

    // On a first contact that arrived with history, mine the back-log first so
    // the Guardian sees everything the transcript already contains.
    if (created && session.messages.length > 0) {
        for (const message of session.messages) {
            if (message.role !== 'scammer') continue;
            extractor.mergeInto(session, extractor.extractEntities(message.text, {
                sessionId,
                messageId: message.messageId,
                timestamp: message.ts ? new Date(message.ts) : message.receivedAt,
            }));
            message.stages = stages.tagWithRules(message.text);
        }
    }

    // Record the incoming message.
    const messageId = session.nextMessageId();
    session.messages.push({
        messageId,
        role: incoming.role,
        text: incoming.text,
        ts: incoming.ts,
        receivedAt,
    });
    session.messageCount += 1;
    if (incoming.role === 'scammer') session.scammerMessageCount += 1;
    session.lastSeenAt = receivedAt;

    const isIncomingFromCounterpart = incoming.role === 'scammer';

    // Entities, from the counterpart's side only, with full provenance.
    const entities = isIncomingFromCounterpart
        ? extractor.extractEntities(incoming.text, {
            sessionId,
            messageId,
            timestamp: incoming.ts ? new Date(incoming.ts) : receivedAt,
        })
        : [];
    const merged = extractor.mergeInto(session, entities);

    // Script stages for this message: rules, then one LLM call for the rest.
    const messageStages = isIncomingFromCounterpart ? await stages.tag(incoming.text, { llm }) : [];
    session.messages[session.messages.length - 1].stages = messageStages;
    refreshScriptStages(session);

    // Guardian: scores the message and owns the state transition.
    const priorCounterpartTexts = session.messages
        .filter((m) => m.role === 'scammer')
        .slice(0, -1)
        .map((m) => m.text);

    const verdict = isIncomingFromCounterpart
        ? await guardian.handleMessage({
            session,
            text: incoming.text,
            entities,
            allEntities: session.entities,
            priorTexts: priorCounterpartTexts,
            scriptStages: session.scriptStages,
            llm,
            events,
            thresholds: config.guardianThresholds || {},
            from,
            userId,
            messageId,
        })
        : null;

    if (verdict) {
        const scamType = guardian.classifyScamType(
            session.messages.filter((m) => m.role === 'scammer').map((m) => m.text).join('\n')
        );
        if (scamType !== 'unknown') session.scamType = scamType;
    }

    // The engagement ends on its own terms: the other party leaves, or the
    // session passes 30 minutes. There is no turn cap - a long engagement is
    // the whole point.
    if (session.guardianState === guardian.STATES.DECOY_ACTIVE) {
        const limit = decoy.shouldEnd(session, incoming.text);
        if (limit.end) {
            await guardian.endSession({ session, events, reason: limit.reason });
            logger.info(`Engagement ended on session ${sessionId}: ${limit.reason}.`);
        }
    }

    // Decoy, only while the Guardian has the session engaged.
    let decoyResult = null;
    if (session.guardianState === guardian.STATES.DECOY_ACTIVE) {
        decoyResult = await decoy.respond({
            session,
            history: session.messages.slice(0, -1),
            incomingText: incoming.text,
            llm,
            config,
            personaId: session.personaId || 'default',
        });

        session.messages.push({
            messageId: session.nextMessageId(),
            role: 'decoy',
            text: decoyResult.reply,
            ts: null,
            receivedAt: new Date(),
        });
        session.messageCount += 1;
        session.decoyMessageCount += 1;
        session.lastAskedTarget = decoyResult.targetAsked === 'none' ? null : decoyResult.targetAsked;
        decoy.noteExcuseUsed(session, decoyResult.excuseUsed);

        session.markModified('personaLedger');
        session.markModified('excuseHistory');
    }

    // agentNotes is rebuilt from the stored session every turn rather than
    // appended to. It is assembled from extracted data only - no model call -
    // so it can never state a fact the session does not contain.
    if (isIncomingFromCounterpart) {
        session.agentNotes = intelligence.buildAgentNotes(session);
    }

    session.markModified('messages');
    await session.save();

    // The decoy's typing delay. Zero under DEMO_MODE, reported separately,
    // and excluded from every engagement figure.
    const typingDelayMs = decoyResult ? decoyResult.typingDelayMs : 0;
    if (typingDelayMs > 0) await sleep(typingDelayMs);

    return {
        sessionId,
        // What the counterpart receives. Null unless the decoy is engaged.
        reply: decoyResult ? decoyResult.reply : null,
        state: session.guardianState,
        guardian: verdict
            ? {
                state: verdict.state,
                previousState: verdict.previousState,
                changed: verdict.changed,
                takeover: verdict.engagedNow,
                released: verdict.released,
                trustedContact: verdict.trustedContact,
                // Confidence is the score, its breakdown and the label, side by
                // side. No probability is invented.
                score: verdict.score,
                rawScore: verdict.rawScore,
                breakdown: verdict.breakdown,
                firedSignals: verdict.firedSignals,
                hardSignals: verdict.hardSignals,
                ruleState: verdict.ruleState,
                classifier: verdict.classifier,
                thresholds: verdict.thresholds,
                notes: verdict.notes,
                decisionMs: verdict.decisionMs,
                scamType: session.scamType,
            }
            : null,
        // What the protected user, and a family contact, are shown.
        alerts: verdict ? verdict.alerts : [],
        takeoverNotice: verdict ? verdict.takeoverNotice : null,
        decoy: decoyResult
            ? {
                language: decoyResult.language,
                targetAsked: decoyResult.targetAsked,
                excuseUsed: decoyResult.excuseUsed,
                ledgerUpdates: decoyResult.ledgerUpdates,
                source: decoyResult.source,
                pressure: decoyResult.pressure,
                injectionAttempt: decoyResult.injectionAttempt,
                contradictionsRejected: decoyResult.contradictionsRejected.length,
                guard: decoyResult.guard,
                typingDelayMs: decoyResult.typingDelayMs,
            }
            : null,
        scriptStages: {
            thisMessage: messageStages,
            session: session.scriptStages,
        },
        measured: {
            messageCount: session.messageCount,
            scammerMessageCount: session.scammerMessageCount,
            decoyMessageCount: session.decoyMessageCount,
            engagementDurationSeconds: session.engagementDurationSeconds(),
            newEntitiesThisTurn: merged.identifiers,
            newEntityTypesThisTurn: merged.types,
            simulatedTypingDelayMs: typingDelayMs,
        },
        entitiesThisTurn: entities,
        intelligence: session.intelligence.toObject
            ? session.intelligence.toObject()
            : session.intelligence,
    };
};

/**
 * The protected user pressed "This is genuine".
 *
 * Ends the engagement immediately, returns the one neutral line to send so the
 * thread does not stop dead, and marks the session FALSE_POSITIVE.
 */
const markGenuine = async (sessionId, deps = {}) => {
    const { events = null } = deps;

    const session = await Session.findOne({ sessionId });
    if (!session) throw new PipelineError('Session not found.', 404);

    const result = await guardian.markGenuine({ session, events });

    // The neutral line is recorded in the transcript like any other reply, so
    // the thread stays coherent and the report shows exactly what was said.
    session.messages.push({
        messageId: session.nextMessageId(),
        role: 'decoy',
        text: result.handbackLine,
        ts: null,
        receivedAt: new Date(),
    });
    session.messageCount += 1;
    session.decoyMessageCount += 1;
    session.markModified('messages');
    await session.save();

    return {
        sessionId,
        state: result.state,
        previousState: result.previousState,
        reply: result.handbackLine,
        offerTrustedContact: result.offerTrustedContact,
        counterpartId: result.counterpartId,
    };
};

module.exports = { handleTurn, markGenuine, PipelineError, loadOrCreate, refreshScriptStages };
