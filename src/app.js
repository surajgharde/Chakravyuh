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
const logger = require('./services/logger');

/**
 * @param {object} config  from config/env.js
 * @param {object} [deps]  { llm } - an LlmClient, or one built from config
 */
const createApp = (config, deps = {}) => {
    const app = express();
    const llm = deps.llm ?? new LlmClient(config.llm);

    app.use(cors());
    app.use(express.json({ limit: '256kb' }));

    // Health is deliberately the only unauthenticated route.
    app.get('/health', (_req, res) => {
        res.json({
            status: 'ok',
            llmConfigured: llm.configured,
            db: config.usesEphemeralDb ? 'in-process' : 'external',
        });
    });

    app.use(requireApiKey(config.apiSecretKey));

    app.use('/api', createRouter({ llm, config }));

    // The operator console lands here in a later phase.
    app.use(express.static(path.join(__dirname, 'public')));

    app.use((err, _req, res, _next) => {
        logger.error(`Unhandled: ${err.stack || err.message}`);
        res.status(500).json({ status: 'error', error: 'Internal error' });
    });

    return app;
};

module.exports = { createApp };
