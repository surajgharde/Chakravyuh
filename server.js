#!/usr/bin/env node
/**
 * Entry point.
 *
 * Boot order matters: configuration is validated first, so a missing
 * API_SECRET_KEY stops the process before anything starts listening.
 */

require('dotenv').config();

const { load, ConfigError } = require('./src/config/env');
const db = require('./src/services/db');
const logger = require('./src/services/logger');

const start = async () => {
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

    if (!config.llm.apiKey) {
        logger.warn('LLM_API_KEY is not set. Detection falls back to deterministic rules '
            + 'and the decoy uses scripted replies. Set it for the full system.');
    }

    await db.connect(config);

    const { createApp } = require('./src/app');
    const app = createApp(config);

    const server = app.listen(config.port, () => {
        logger.info(`Chakravyuh listening on http://localhost:${config.port}`);
        logger.info(`Health: http://localhost:${config.port}/health`);
    });

    const shutdown = async (signal) => {
        logger.info(`${signal} received; shutting down.`);
        server.close();
        await db.disconnect();
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
};

start().catch((error) => {
    logger.error(`Failed to start: ${error.stack || error.message}`);
    process.exit(1);
});
