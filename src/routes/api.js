/**
 * HTTP surface.
 *
 * POST /api/message        one inbound message; returns the decoy reply when
 *                          the Guardian has engaged, and the assessment either way
 * GET  /api/sessions/:id   the full session state, including measured metrics
 * GET  /api/sessions       recent sessions, newest first
 *
 * There is no outbound callback. The original repo posted every session to an
 * external scoring endpoint; the report is produced locally instead.
 */

const express = require('express');
const Session = require('../models/Session');
const pipeline = require('../services/pipeline');
const logger = require('../services/logger');

const toSessionView = (session) => ({
    sessionId: session.sessionId,
    stage: session.stage,
    scamDetected: session.scamDetected,
    confidence: session.confidence,
    scamType: session.scamType,
    signals: session.signals,
    handoffAtMessage: session.handoffAtMessage,
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
    agentNotes: session.agentNotes,
    messages: session.messages.map((m) => ({
        role: m.role,
        text: m.text,
        ts: m.ts,
        receivedAt: m.receivedAt,
    })),
});

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

    router.get('/sessions', async (_req, res) => {
        const sessions = await Session.find({}, null, { sort: { lastSeenAt: -1 }, limit: 50 });
        res.json({
            status: 'success',
            count: sessions.length,
            sessions: sessions.map((s) => ({
                sessionId: s.sessionId,
                stage: s.stage,
                scamDetected: s.scamDetected,
                confidence: s.confidence,
                scamType: s.scamType,
                messageCount: s.messageCount,
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

    return router;
};

module.exports = { createRouter, toSessionView };
