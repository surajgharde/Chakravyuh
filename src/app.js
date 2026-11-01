/**
 * Express app factory. Kept separate from server.js so tests can mount the app
 * on an ephemeral port with an injected LLM transport.
 */

const path = require('node:path');
const express = require('express');
const cors = require('cors');

const { requireApiKey } = require('./middleware/auth');
const { createRouter } = require('./routes/api');
const { LlmClient } = require('./llm/client');
const { nullEmitter } = require('./realtime/events');
const logger = require('./services/logger');

/**
 * @param {object} config  from config/env.js
 * @param {object} [deps]  { llm, events } - an LlmClient and an event emitter,
 *                         or defaults built from config
 */
/**
 * Builds the LLM client the app will use.
 *
 * Three cases, in order: a client injected by a test, the offline scripted
 * transport when FAKE_LLM=1, or the real one. The scripted transport is wired
 * in at the same seam the tests use, so every path through LlmClient - the
 * JSON parsing, the error codes, the retry, the timeout - is identical either
 * way.
 */
const buildLlm = (config, deps) => {
    if (deps.llm) return deps.llm;

    if (config.fakeLlm) {
        const { createFakeTransport } = require('./llm/fakeTransport');
        logger.warn('FAKE_LLM=1: every model call is answered from a script, with no network. '
            + 'Replies are scripted, not generated. This is reported by /health and badged in the console.');
        // A small pause so the console does not look suspiciously instant next
        // to a real run; excluded from every engagement figure, like the
        // decoy's typing delay.
        return new LlmClient(config.llm, { transport: createFakeTransport({ latencyMs: 120 }) });
    }

    return new LlmClient(config.llm);
};

const createApp = (config, deps = {}) => {
    const app = express();
    const llm = buildLlm(config, deps);
    // Without a transport, Guardian events are simply discarded.
    const events = deps.events ?? nullEmitter();

    app.use(cors());
    app.use(express.json({ limit: '256kb' }));

    /**
     * A body that is not valid JSON, or is too large.
     *
     * express.json() throws, and without this the generic handler at the
     * bottom answers 500 - which says "this server is broken" when the truth
     * is "that request was malformed". A caller cannot fix a 500 and can fix a
     * 400, so the distinction is worth the eight lines.
     *
     * Registered immediately after the parser: an error handler only sees what
     * the middleware before it threw.
     */
    const BODY_ERRORS = {
        'entity.parse.failed': [400, 'The request body is not valid JSON.'],
        'entity.too.large': [413, 'The request body is larger than the 256kb limit.'],
        'encoding.unsupported': [415, 'That content encoding is not supported.'],
        'request.aborted': [400, 'The request was aborted before the body arrived.'],
    };

    app.use((err, _req, res, next) => {
        const known = err && BODY_ERRORS[err.type];
        if (!known) return next(err);

        const [status, message] = known;
        logger.warn(`Rejected a bad request body (${err.type}): ${err.message}`);
        return res.status(status).json({ status: 'error', error: message });
    });

    /**
     * Bootstrap for the demo console.
     *
     * Hands the page its API key so a judge never types one. Served ONLY to
     * loopback: on any other interface it 403s, so putting this on a network
     * does not hand the key to whoever asks. The console is a local demo tool.
     */
    app.get('/demo-config', (req, res) => {
        const address = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(address);

        if (!isLoopback) {
            logger.warn(`Refused /demo-config from ${address || 'an unknown address'}.`);
            return res.status(403).json({
                status: 'error',
                error: 'The demo console bootstrap is only served to localhost. '
                    + 'Pass the API key explicitly if you are driving this remotely.',
            });
        }

        res.json({
            status: 'success',
            apiKey: config.apiSecretKey,
            demoMode: config.demoMode,
            llmConfigured: llm.configured,
            thresholds: config.guardianThresholds,
            // So the ethics panel quotes the window this server actually runs
            // with, rather than a number hard-coded into the page.
            sessionRetentionDays: config.sessionRetentionDays,
            // The console badges this. A scripted reply must never be shown as
            // a model reply.
            fakeLlm: config.fakeLlm,
        });
    });

    /**
     * Health. Deliberately the only unauthenticated route.
     *
     * It reports what is actually wired up rather than echoing the
     * configuration, because the thing a deploy health check needs to know is
     * whether a request would succeed. The database is the part that can be
     * configured correctly and still be down, so its live connection state is
     * read rather than assumed.
     *
     * 200 when the system can serve a turn; 503 when it cannot. A host that
     * restarts on a failing health check should restart this.
     */
    app.get('/health', (_req, res) => {
        const mongoose = require('mongoose');

        // 1 = connected, 2 = connecting. Anything else cannot serve a turn,
        // because every route touches a session.
        const dbState = mongoose.connection?.readyState ?? 0;
        const dbReady = dbState === 1;

        const health = {
            status: dbReady ? 'ok' : 'degraded',
            uptimeSeconds: Math.round(process.uptime()),
            version: require('../package.json').version,

            db: {
                ready: dbReady,
                state: ['disconnected', 'connected', 'connecting', 'disconnecting'][dbState] ?? 'unknown',
                kind: config.usesEphemeralDb ? 'in-process' : 'external',
            },

            llm: {
                // Whether a model call can be made at all.
                configured: llm.configured,
                // True when answers come from a script with no network. Said
                // here as well as in the console: a scripted reply must never
                // be mistaken for a model reply, including by an operator
                // reading a health check.
                scripted: Boolean(config.fakeLlm),
                model: config.fakeLlm ? 'scripted (FAKE_LLM=1)' : config.llm.model,
            },

            realtime: Boolean(deps.events),
            sessionRetentionDays: config.sessionRetentionDays,
        };

        // The degraded reasons, so a 503 says what to fix.
        if (!dbReady) {
            health.reasons = [`the database is ${health.db.state}; every route needs a session store`];
        }

        res.status(dbReady ? 200 : 503).json(health);
    });

    /**
     * The demo console's own files, served BEFORE the API key check.
     *
     * The page is static HTML, CSS and JavaScript with no data in it. Putting
     * it behind the key check only means the browser gets a 401 for the page
     * itself, since it cannot send a header for a top-level navigation. Every
     * /api route below is still protected.
     */
    app.use(express.static(path.join(__dirname, 'public')));

    app.use(requireApiKey(config.apiSecretKey));

    app.use('/api', createRouter({ llm, config, events }));

    /**
     * Anything nothing else claimed.
     *
     * A route that does not exist is a 404 with a pointer, rather than
     * Express's default HTML page - which is confusing to receive from
     * something that otherwise only speaks JSON.
     */
    app.use((req, res) => {
        res.status(404).json({
            status: 'error',
            error: `No route for ${req.method} ${req.path}.`,
            hint: 'The HTTP surface is listed at the top of src/routes/api.js.',
        });
    });

    /**
     * The last resort. The stack is logged and the response says nothing about
     * it: an error message can carry a connection string or a key, and this is
     * the one place that has not already decided what is safe to say.
     */
    app.use((err, _req, res, _next) => {
        logger.error(`Unhandled: ${err.stack || err.message}`);
        res.status(500).json({ status: 'error', error: 'Internal error' });
    });

    return app;
};

module.exports = { createApp };
