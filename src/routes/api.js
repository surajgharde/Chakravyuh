/**
 * HTTP surface.
 *
 * POST /api/message                     one inbound message
 * POST /api/partial                     a partial transcript from a voice call;
 *                                       scored, never recorded
 * POST /api/sessions/:id/genuine        the "This is genuine" button
 * POST /api/sessions/:id/end            end an engagement
 * GET  /api/sessions/:id                full session state
 * GET  /api/sessions                    recent sessions, newest first
 * GET  /api/sessions/:id/report         the evidence report, as JSON
 * GET  /api/sessions/:id/report.html    the same report, printable
 * GET  /api/sessions/:id/report.pdf     the same report, as a PDF download
 * POST /api/sessions/:id/report/review  tick "reviewed by family member"
 * GET  /api/network                     identifiers linked across sessions
 * GET  /api/scenarios                   the demo console's scenario buttons
 * POST /api/sessions/:id/reset          delete a session so a demo can be rerun
 * GET/POST/DELETE /api/trusted-contacts trusted contacts for a protected user
 *
 * There is no outbound callback. The original repo posted every session to an
 * external scoring endpoint; the report is produced locally instead.
 */

const express = require('express');
const Session = require('../models/Session');
const pipeline = require('../services/pipeline');
const guardian = require('../agents/guardian');
const intelligence = require('../agents/intelligence');
const network = require('../services/network');
const reportRender = require('../services/reportRender');
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

/**
 * Opening lines for the demo console's scenario buttons.
 *
 * Four scams and two legitimate messages. The legitimate pair is the point of
 * the demo as much as the scams are: it is what shows the Guardian declining
 * to bait a real caller.
 */
const SCENARIOS = [
    {
        id: 'cbi-digital-arrest',
        label: 'CBI digital arrest',
        kind: 'scam',
        channel: 'Call',
        from: '+919812345678',
        language: 'English',
        opening: 'Madam, this is Inspector Deshmukh from CBI Pune. A parcel in your name was '
            + 'seized with narcotics. Do not tell anyone and do not disconnect this call.',
        followUps: [
            'A non-bailable warrant is ready against you. This is a serious matter.',
            'Transfer Rs 2,50,000 to the RBI verification account 50100234567890, IFSC SBIN0001234. It is fully refundable.',
            'Fine, send it to cyber.verify@okaxis instead. My officer ID is CBI/INSP/44871.',
            'The case number is MUM/CYB/2026/00891. You have only 30 minutes.',
        ],
    },
    {
        id: 'fedex-parcel-drugs',
        label: 'FedEx parcel with drugs',
        kind: 'scam',
        channel: 'Call',
        from: '+918877665544',
        language: 'English',
        opening: 'Madam, this is FedEx customs department. A parcel in your name has been '
            + 'seized at Mumbai airport, it contained illegal narcotic substances.',
        followUps: [
            'The customs officer will call you shortly. Do not inform your family about this case.',
            'Pay the clearance fee of 18500 immediately to customs.clear@ybl to release the parcel.',
            'Our office is at the second floor, Mangal Bhavan, FC Road, Pune 411004.',
        ],
    },
    {
        id: 'kyc-expiry',
        label: 'KYC expiry',
        kind: 'scam',
        channel: 'WhatsApp',
        from: '+917766554433',
        language: 'Hindi',
        opening: 'Madam aapka bank account KYC expire ho gaya hai, aaj hi account block ho '
            + 'jayega. Turant OTP bataiye.',
        followUps: [
            'Message mein OTP aaya hoga. Jaldi kijiye, mere paas doosre customer bhi hain.',
            'Verification charge 4500 rupees kyc.update@ybl par bhejiye.',
            'Account 60200345678901 hai, IFSC HDFC0000123. Mera naam Suresh Patil hai.',
        ],
    },
    {
        id: 'stock-tip-group',
        label: 'Stock-tip WhatsApp group',
        kind: 'scam',
        channel: 'WhatsApp',
        from: '+916655443322',
        language: 'Hindi',
        opening: 'Madam ji, namaste. Guaranteed investment tip, 300 percent return in 30 days. '
            + 'Aaj hi paisa bhejiye, offer sirf aaj ke liye hai.',
        followUps: [
            'Bahut log already invest kar chuke hain, aap peeche reh jayengi.',
            'Registration fee sirf 1500 rupees hai. Paisa profit.capital@paytm par bhejiye.',
            'Account number 70300456789012 hai, IFSC ICIC0001234. Mera naam Amit Sharma hai.',
        ],
    },
    {
        id: 'son-dinner',
        label: 'Son asking about dinner',
        kind: 'legitimate',
        channel: 'WhatsApp',
        from: '+919876500001',
        language: 'English',
        opening: 'Maa, what is for dinner today? I will reach home by 8.',
        followUps: [
            'Should I bring something from the market on the way?',
            'Okay, I am leaving the office now.',
        ],
        note: 'A real caller. The Guardian must leave this alone: no takeover, no reply.',
    },
    {
        id: 'real-bank-otp',
        label: 'Real bank OTP SMS',
        kind: 'legitimate',
        channel: 'SMS',
        from: 'VM-SBIINB',
        language: 'English',
        opening: 'Your OTP for a transaction of Rs 5,000 is 884512. Do not share it with '
            + 'anyone. -SBI',
        followUps: [
            'Dear customer, your bank will never ask for your OTP, PIN or CVV. Report any such call to the number printed on your card.',
        ],
        note: 'A genuine bank SMS. It mentions an OTP and money, and still must not be baited.',
    },
];

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
     * A partial transcript from Call mode.
     *
     * Called roughly every two seconds while the scammer is still speaking, so
     * detection does not have to wait for them to finish. It runs the Guardian
     * and nothing else: no message is recorded, no entity stored and no decoy
     * reply produced. See pipeline.handlePartial for exactly what it will and
     * will not do.
     */
    router.post('/partial', async (req, res) => {
        try {
            const result = await pipeline.handlePartial(req.body, deps);
            res.json({ status: 'success', ...result });
        } catch (error) {
            if (error.name === 'PipelineError') {
                return res.status(error.status).json({ status: 'error', error: error.message });
            }
            logger.error(`Partial failed: ${error.stack || error.message}`);
            res.status(500).json({ status: 'error', error: 'Internal error handling the partial transcript.' });
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

    // --- Evidence report ----------------------------------------------------

    /** Loads the session or answers 404. */
    const findSession = async (req, res) => {
        const session = await Session.findOne({ sessionId: req.params.sessionId });
        if (!session) {
            res.status(404).json({ status: 'error', error: 'Session not found' });
            return null;
        }
        return session;
    };

    router.get('/sessions/:sessionId/report', async (req, res) => {
        const session = await findSession(req, res);
        if (!session) return;
        res.json({ status: 'success', report: intelligence.buildReport(session) });
    });

    router.get('/sessions/:sessionId/report.html', async (req, res) => {
        const session = await findSession(req, res);
        if (!session) return;

        const report = intelligence.buildReport(session);
        res.type('html').send(reportRender.toHtml(report));
    });

    router.get('/sessions/:sessionId/report.pdf', async (req, res) => {
        const session = await findSession(req, res);
        if (!session) return;

        const report = intelligence.buildReport(session);

        // ?ready=1 asks for a file to actually hand over. That needs the review
        // tick: an unreviewed report is a draft and must not be presented as
        // something ready to file.
        if (['1', 'true', 'yes'].includes(String(req.query.ready || '').toLowerCase())
            && !report.review.reviewedByFamily) {
            return res.status(409).json({
                status: 'error',
                error: 'This report has not been reviewed by a family member yet, so it cannot be '
                    + 'exported as ready to file. Tick the review box first, or download it without '
                    + '?ready=1 to get the draft.',
                readyToFile: false,
            });
        }

        try {
            const pdf = await reportRender.toPdf(report);
            const suffix = report.review.reviewedByFamily ? '' : '-DRAFT';
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${report.reportId}${suffix}.pdf"`);
            res.send(pdf);
        } catch (error) {
            logger.error(`PDF generation failed: ${error.message}`);
            res.status(500).json({ status: 'error', error: 'Could not generate the PDF.' });
        }
    });

    /**
     * The "Reviewed by family member" tick. Until this is set, the report is a
     * draft and cannot be exported as ready to file.
     */
    router.post('/sessions/:sessionId/report/review', async (req, res) => {
        const session = await findSession(req, res);
        if (!session) return;

        const confirmed = req.body?.reviewedByFamily;
        if (confirmed !== true) {
            return res.status(400).json({
                status: 'error',
                error: 'Send { "reviewedByFamily": true } to confirm that a family member has read the report.',
            });
        }

        intelligence.markReviewed(session, { reviewedBy: req.body?.reviewedBy || 'family member' });
        await session.save();

        res.json({
            status: 'success',
            review: {
                reviewedByFamily: true,
                reviewedAt: session.report.reviewedAt,
                reviewedBy: session.report.reviewedBy,
                readyToFile: true,
            },
            note: 'The report is now marked ready to file. Nothing has been submitted; '
                + 'filing it with 1930 or cybercrime.gov.in is still a decision for the family.',
        });
    });

    // --- Network view -------------------------------------------------------

    router.get('/network', async (req, res) => {
        try {
            const graph = await network.build({
                userId: req.query.userId || null,
                limit: Math.min(Number.parseInt(req.query.limit, 10) || 500, 2000),
            });
            res.json({ status: 'success', ...graph });
        } catch (error) {
            logger.error(`Network graph failed: ${error.message}`);
            res.status(500).json({ status: 'error', error: 'Could not build the network graph.' });
        }
    });

    // --- Demo support -------------------------------------------------------

    /**
     * The scenario buttons on the demo console.
     *
     * Served from here rather than hard-coded in the page, so the opening lines
     * the judges use are the same ones the test fixtures use.
     */
    router.get('/scenarios', (_req, res) => {
        res.json({ status: 'success', scenarios: SCENARIOS });
    });

    /** Clears a session so the same demo can be run again. */
    router.post('/sessions/:sessionId/reset', async (req, res) => {
        const result = await Session.deleteOne({ sessionId: req.params.sessionId });
        res.json({
            status: 'success',
            sessionId: req.params.sessionId,
            deleted: result.deletedCount > 0,
        });
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
