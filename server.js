#!/usr/bin/env node
/**
 * Entry point.
 *
 * Boot order matters: configuration is validated first, so a missing
 * API_SECRET_KEY stops the process before anything starts listening.
 *
 * `start()` is exported so `npm run demo` can seed the database and then bring
 * the server up in the same process, on the same connection. It only starts
 * listening when this file is the process's entry point, so requiring it never
 * opens a port as a side effect.
 */

require('dotenv').config();

const { load, ConfigError } = require('./src/config/env');
const db = require('./src/services/db');
const logger = require('./src/services/logger');

/**
 * Validates the configuration and starts listening.
 *
 * @param {object} [options]
 * @param {boolean} [options.skipDbConnect] the caller has already connected
 *   (npm run demo seeds first and hands the connection over).
 * @returns {Promise<{server: object, config: object, shutdown: function}>}
 */
const start = async ({ skipDbConnect = false } = {}) => {
    let config;
    try {
        config = load();
    } catch (error) {
        if (error instanceof ConfigError) {
            console.error(`\nConfiguration error: ${error.message}\n`);
            process.exit(1);
        }
        throw error;
    }

    if (config.fakeLlm) {
        logger.warn('FAKE_LLM=1: every model call is answered from a script, with no network. '
            + 'Replies are scripted, not generated. /health reports this and the console badges it.');
    } else if (!config.llm.apiKey) {
        logger.warn('LLM_API_KEY is not set. Detection falls back to deterministic rules '
            + 'and the decoy uses scripted replies. Set it for the full system, or set '
            + 'FAKE_LLM=1 for a demo with no network.');
    }

    if (!skipDbConnect) await db.connect(config);

    // Old transcripts are deleted on a timer, not kept forever. See
    // services/retention.js and ETHICS.md.
    const retention = require('./src/services/retention');
    const retentionSweep = retention.start(config);

    const http = require('node:http');
    const { createApp } = require('./src/app');
    const { attach, lateBoundEmitter } = require('./src/realtime/events');

    // Order matters. Socket.IO takes over the server's request handling and
    // delegates anything that is not its own path to the listeners that were
    // already there, so Express must be attached first. The app needs an
    // emitter before that, hence the late binding.
    const events = lateBoundEmitter();
    const server = http.createServer(createApp(config, { events }));
    const { emitter } = attach(server);
    events.bind(emitter);

    /**
     * A port already in use is the most common way this fails on a laptop, and
     * the default message ("listen EADDRINUSE") does not say what to do about
     * it. Everything else is re-thrown unchanged.
     */
    server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
            console.error(`\nPort ${config.port} is already in use. Something else is on it - `
                + 'another copy of this server, most likely.');
            console.error(`Stop it, or start this one on another port:  PORT=8081 npm start\n`);
            process.exit(1);
        }
        logger.error(`Server error: ${error.stack || error.message}`);
        process.exit(1);
    });

    await new Promise((resolve) => {
        server.listen(config.port, () => {
            logger.info(`Chakravyuh listening on http://localhost:${config.port}`);
            logger.info(`Health: http://localhost:${config.port}/health`);
            logger.info('Guardian events on Socket.IO: guardian.score, guardian.state_changed, '
                + 'guardian.takeover, guardian.released');
            resolve();
        });
    });

    let shuttingDown = false;

    const shutdown = async (signal) => {
        // A second Ctrl-C while the first is still draining would otherwise
        // run the whole teardown twice and log a confusing second round.
        if (shuttingDown) return;
        shuttingDown = true;

        logger.info(`${signal} received; shutting down.`);
        retentionSweep.stop();

        try {
            await new Promise((resolve) => server.close(resolve));
            await db.disconnect();
        } catch (error) {
            logger.error(`Shutdown was not clean: ${error.message}`);
            process.exit(1);
        }

        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    /**
     * A bug anywhere async must not leave the process running in a state
     * nobody can reason about. It is logged with its stack and the process
     * exits, so a host restarts it rather than serving from a broken one.
     */
    process.on('unhandledRejection', (reason) => {
        logger.error(`Unhandled rejection: ${reason instanceof Error ? reason.stack : reason}`);
        process.exit(1);
    });

    process.on('uncaughtException', (error) => {
        logger.error(`Uncaught exception: ${error.stack || error.message}`);
        process.exit(1);
    });

    return { server, config, shutdown };
};

// Only listen when this file is what was run. Requiring it (npm run demo, or a
// test) must not open a port as a side effect.
if (require.main === module) {
    start().catch((error) => {
        logger.error(`Failed to start: ${error.stack || error.message}`);
        process.exit(1);
    });
}

module.exports = { start };
