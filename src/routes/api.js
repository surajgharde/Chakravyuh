/**
 * HTTP surface.
 *
 * POST /api/message                     one inbound message
 * POST /api/sessions/:id/genuine        the "This is genuine" button
 * POST /api/sessions/:id/end            end an engagement
 * GET  /api/sessions/:id                full session state
 * GET  /api/sessions                    recent sessions, newest first
 * GET/POST/DELETE /api/trusted-contacts trusted contacts for a protected user
 *
 * There is no outbound callback. The original repo posted every session to an
 * external scoring endpoint; the report is produced locally instead.
 */

const express = require('express');
const Session = require('../models/Session');
const pipeline = require('../services/pipeline');
const guardian = require('../agents/guardian');
const trustedContacts = require('../services/trustedContacts');
const logger = require('../services/logger');

const toSessionView = (session) => ({
    sessionId: session.sessionId,
    userId: session.userId,
    counterpartId: session.counterpartId,
    state: session.guardianState,
    scamDetected: session.scamDetected,
    scamType: session.scamType,

    // Confidence, shown as what it is: a rule score with its breakdown, next to
    // the classifier's label.
    score: session.score,
    scoreBreakdown: session.scoreBreakdown,
    firedSignals: session.firedSignals,
    classifier: { label: session.classifierLabel, reasons: session.classifierReasons },

    handoffAtMessage: session.handoffAtMessage,
    takeoverAt: session.takeoverAt,
    falsePositive: session.falsePositive,

    channel: session.channel,
    language: session.language,
    locale: session.locale,

    measured: {
        messageCount: session.messageCount,
        scammerMessageCount: session.scammerMessageCount,
        decoyMessageCount: session.decoyMessageCount,
        engagementDurationSeconds: session.engagementDurationSeconds(),
        firstSeenAt: session.firstSeenAt,
        lastSeenAt: session.lastSeenAt,
    },

    intelligence: session.intelligence,
    // The evidence itself: one record per identifier, each carrying the message
    // and the sentence it came from.
    entities: session.entities,
    scriptStages: session.scriptStages,
    agentNotes: session.agentNotes,
    messages: session.messages.map((m) => ({
        messageId: m.messageId,
        role: m.role,
        text: m.text,
        ts: m.ts,
        receivedAt: m.receivedAt,
        stages: m.stages,
    })),
});

const userIdFrom = (req) => (
    req.body?.userId
    || req.query?.userId
    || req.headers['x-user-id']
    || trustedContacts.DEFAULT_USER_ID
).toString();

const createRouter = (deps) => {
    const router = express.Router();

    router.post('/message', async (req, res) => {
        try {
            const result = await pipeline.handleTurn(req.body, deps);
            res.json({ status: 'success', ...result });
        } catch (error) {
            if (error.name === 'PipelineError') {
                return res.status(error.status).json({ status: 'error', error: error.message });
            }
            logger.error(`Turn failed: ${error.stack || error.message}`);
            res.status(500).json({ status: 'error', error: 'Internal error handling message.' });
        }
    });

    /**
     * The "This is genuine" button on the protected user's screen. Ends the
     * engagement at any moment and offers to remember the caller.
     */
    router.post('/sessions/:sessionId/genuine', async (req, res) => {
        try {
            const result = await pipeline.markGenuine(req.params.sessionId, deps);
            res.json({ status: 'success', ...result });
        } catch (error) {
            if (error.name === 'PipelineError') {
                return res.status(error.status).json({ status: 'error', error: error.message });
            }
            logger.error(`Mark-genuine failed: ${error.stack || error.message}`);
            res.status(500).json({ status: 'error', error: 'Internal error.' });
        }
    });

    router.post('/sessions/:sessionId/end', async (req, res) => {
        const session = await Session.findOne({ sessionId: req.params.sessionId });
        if (!session) return res.status(404).json({ status: 'error', error: 'Session not found' });

        const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'ended_by_operator';
        const result = await guardian.endSession({ session, events: deps.events, reason });
        await session.save();

        res.json({ status: 'success', sessionId: session.sessionId, ...result });
    });

    router.get('/sessions', async (req, res) => {
        const filter = req.query.userId ? { userId: req.query.userId } : {};
        const sessions = await Session.find(filter, null, { sort: { lastSeenAt: -1 }, limit: 50 });

        res.json({
            status: 'success',
            count: sessions.length,
            sessions: sessions.map((s) => ({
                sessionId: s.sessionId,
                state: s.guardianState,
                scamDetected: s.scamDetected,
                score: s.score,
                scamType: s.scamType,
                classifierLabel: s.classifierLabel,
                messageCount: s.messageCount,
                entityCount: s.entities.length,
                scriptStages: s.scriptStages,
                engagementDurationSeconds: s.engagementDurationSeconds(),
                lastSeenAt: s.lastSeenAt,
            })),
        });
    });

    router.get('/sessions/:sessionId', async (req, res) => {
        const session = await Session.findOne({ sessionId: req.params.sessionId });
        if (!session) return res.status(404).json({ status: 'error', error: 'Session not found' });
        res.json({ status: 'success', session: toSessionView(session) });
    });

    // --- Trusted contacts ---------------------------------------------------

    router.get('/trusted-contacts', async (req, res) => {
        const contacts = await trustedContacts.list(userIdFrom(req));
        res.json({
            status: 'success',
            count: contacts.length,
            contacts: contacts.map((c) => ({
                identifier: c.identifier,
                raw: c.raw,
                label: c.label,
                relationship: c.relationship,
                addedFrom: c.addedFrom,
            })),
        });
    });

    router.post('/trusted-contacts', async (req, res) => {
        try {
            const contact = await trustedContacts.add(userIdFrom(req), {
                identifier: req.body?.identifier,
                label: req.body?.label,
                relationship: req.body?.relationship,
                addedFrom: req.body?.addedFrom,
            });

            res.status(201).json({
                status: 'success',
                contact: {
                    identifier: contact.identifier,
                    raw: contact.raw,
                    label: contact.label,
                    relationship: contact.relationship,
                    addedFrom: contact.addedFrom,
                },
            });
        } catch (error) {
            if (error.name === 'ValidationError') {
                return res.status(400).json({ status: 'error', error: error.message });
            }
            logger.error(`Adding a trusted contact failed: ${error.message}`);
            res.status(500).json({ status: 'error', error: 'Internal error.' });
        }
    });

    router.delete('/trusted-contacts/:identifier', async (req, res) => {
        const removed = await trustedContacts.remove(userIdFrom(req), req.params.identifier);
        if (!removed) return res.status(404).json({ status: 'error', error: 'Contact not found' });
        res.json({ status: 'success', removed: true });
    });

    return router;
};

module.exports = { createRouter, toSessionView };
