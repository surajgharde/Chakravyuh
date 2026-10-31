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
const createApp = (config, deps = {}) => {
    const app = express();
    const llm = deps.llm ?? new LlmClient(config.llm);
    // Without a transport, Guardian events are simply discarded.
    const events = deps.events ?? nullEmitter();

    app.use(cors());
    app.use(express.json({ limit: '256kb' }));

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
        });
    });

    // Health is deliberately the only unauthenticated route.
    app.get('/health', (_req, res) => {
        res.json({
            status: 'ok',
            llmConfigured: llm.configured,
            db: config.usesEphemeralDb ? 'in-process' : 'external',
            realtime: Boolean(deps.events),
        });
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

    app.use((err, _req, res, _next) => {
        logger.error(`Unhandled: ${err.stack || err.message}`);
        res.status(500).json({ status: 'error', error: 'Internal error' });
    });

    return app;
};

module.exports = { createApp };
