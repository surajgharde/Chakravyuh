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
 *
 * handlePartial() is the voice-call seam. During a simulated call, speech
 * recognition hands over a partial transcript every couple of seconds while
 * the caller is still talking. Those run the Guardian and nothing else: no
 * message is recorded, no entity is stored, no decoy reply is produced. The
 * sentence becomes a message only when recognition marks it final and it
 * arrives through handleTurn() like any other.
 */

const Session = require('../models/Session');
const guardian = require('../agents/guardian');
const decoy = require('../agents/decoy');
const extractor = require('./extractor');
const intelligence = require('../agents/intelligence');
const stages = require('./stages');
const logger = require('./logger');
const trustedContacts = require('./trustedContacts');
const { EVENTS } = require('../realtime/events');
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

    // A spoken turn. The caller is waiting on the line rather than reading a
    // chat, so the two things that cost the most wall-clock time come out:
    // the decoy's typing delay (nobody types in a call) and the stage
    // tagger's model call. The stage rules still run, and the same text has
    // been through the rules every two seconds already as a partial.
    const live = body?.live === true || metadata.live === true;

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
    const messageStages = isIncomingFromCounterpart
        ? await stages.tag(incoming.text, { llm, useLlm: !live })
        : [];
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
            config: { ...config, live },
            personaId: session.personaId || 'default',
        });

        const decoyMessageId = session.nextMessageId();

        session.messages.push({
            messageId: decoyMessageId,
            role: 'decoy',
            text: decoyResult.reply,
            ts: null,
            receivedAt: new Date(),
        });
        session.messageCount += 1;
        session.decoyMessageCount += 1;

        // Every draft the guard refused, with the rule it broke. Recorded even
        // though the reply that went out was safe: the record of what the
        // system declined to say is the evidence that the guard is doing
        // anything at all.
        for (const blocked of decoyResult.guardBlocks || []) {
            session.guardLog.push({
                at: blocked.at,
                messageId: decoyMessageId,
                attempt: blocked.attempt,
                ruleIds: blocked.violations.map((v) => v.id),
                reasons: blocked.violations.map((v) => v.reason),
                redactedDraft: blocked.redactedDraft,
            });
        }
        if (session.markModified) session.markModified('guardLog');
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

    const result = {
        sessionId,
        // True when this turn came off a microphone rather than a keyboard.
        live,
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
                // What the guard refused this turn, newest last.
                guardBlocks: (decoyResult.guardBlocks || []).map((b) => ({
                    attempt: b.attempt,
                    ruleIds: b.violations.map((v) => v.id),
                    reasons: b.violations.map((v) => v.reason),
                    redactedDraft: b.redactedDraft,
                })),
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

    // The console listens for this so a second screen stays live.
    if (events) {
        events.emit(EVENTS.TURN, {
            ...result,
            incoming: { messageId, role: incoming.role, text: incoming.text, at: receivedAt.toISOString() },
            at: new Date().toISOString(),
        });
    }

    return result;
};

/**
 * Scores a partial transcript from a simulated voice call.
 *
 * Speech recognition hands one of these over roughly every two seconds while
 * the caller is still mid-sentence. The point is that detection does not have
 * to wait for them to stop talking: by the time the sentence lands, the
 * Guardian has usually already decided, so the decoy can answer at once.
 *
 * What this deliberately does NOT do:
 *
 *   - record a message. The text is not final and would pollute the transcript
 *     and the evidence report with half-sentences.
 *   - store entities. The same account number would otherwise be filed with
 *     the provenance of a fragment, and `occurrences` would count the number
 *     of times the recogniser revised its guess rather than the number of
 *     times it was said.
 *   - produce a decoy reply. The decoy answers finished sentences only.
 *   - move firstSeenAt or lastSeenAt on a session that already exists. Those
 *     are message receive times, and letting partials push lastSeenAt forward
 *     would inflate the engagement duration with silence. (A session that a
 *     partial creates does get its firstSeenAt from that moment, which is
 *     when the call really started.)
 *
 * It DOES write the Guardian's state, because that is the whole point: the
 * hand-off has to be in place before the sentence arrives.
 *
 * @param {object} body   { sessionId, text, metadata }
 * @param {object} deps   { llm, config, events }
 * @returns {Promise<object>} the Guardian's reading of the partial
 */
const handlePartial = async (body, deps = {}) => {
    const { config = {}, events = null } = deps;
    const receivedAt = new Date();

    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!sessionId) throw new PipelineError('sessionId is required.');

    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (text === '') throw new PipelineError('text is required.');

    const metadata = body?.metadata && typeof body.metadata === 'object' ? body.metadata : {};
    const userId = (metadata.userId || body?.userId || trustedContacts.DEFAULT_USER_ID).toString();
    const from = callerIdFrom(metadata, null);

    const { session, created } = await loadOrCreate({
        sessionId, history: [], metadata, receivedAt, userId,
    });

    if (metadata.channel) session.channel = metadata.channel;
    if (metadata.language) session.language = metadata.language;
    if (metadata.locale) session.locale = metadata.locale;

    // Entities from the fragment are passed to the scorer and thrown away. The
    // Guardian needs them to fire the payment-rail and link signals; the
    // session does not want them until the sentence is finished.
    const entities = extractor.extractEntities(text, { sessionId, messageId: null, timestamp: receivedAt });

    // Stage tags, rules only. No model call: this runs every two seconds.
    // They are read, not stored, for the same reason as the entities.
    const partialStages = stages.tagWithRules(text);
    const seenStages = new Set([...(session.scriptStages || []), ...partialStages.map((t) => t.stage)]);
    const scriptStages = stages.STAGES.filter((stage) => seenStages.has(stage));

    const priorTexts = session.messages.filter((m) => m.role === 'scammer').map((m) => m.text);

    const verdict = await guardian.handleMessage({
        session,
        text,
        entities,
        allEntities: [...session.entities, ...entities],
        priorTexts,
        scriptStages,
        // No classifier on a partial, so no transport is needed either.
        llm: null,
        events,
        thresholds: config.guardianThresholds || {},
        from,
        userId,
        messageId: null,
        partial: true,
    });

    // A session created by a partial has no messages in it yet. Saving it keeps
    // the state the Guardian just decided, so the finished sentence arrives at
    // a session that is already engaged.
    await session.save();

    if (events) {
        events.emit(EVENTS.TRANSCRIPT, {
            sessionId,
            text,
            final: false,
            state: verdict.state,
            score: verdict.score,
            at: receivedAt.toISOString(),
        });
    }

    return {
        sessionId,
        partial: true,
        createdSession: created,
        state: verdict.state,
        guardian: {
            state: verdict.state,
            previousState: verdict.previousState,
            changed: verdict.changed,
            takeover: verdict.engagedNow,
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
            trustedContact: verdict.trustedContact,
        },
        alerts: verdict.alerts,
        takeoverNotice: verdict.takeoverNotice,
        scriptStages: { thisPartial: partialStages, session: scriptStages },
        // Read from the fragment and not stored. Shown so an operator can watch
        // identifiers surface as they are spoken.
        entitiesThisPartial: entities,
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

module.exports = {
    handleTurn, handlePartial, markGenuine, PipelineError, loadOrCreate, refreshScriptStages,
};
