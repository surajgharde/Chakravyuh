/**
 * Single source of configuration. Validates on load and fails closed:
 * a missing API_SECRET_KEY stops the process instead of letting requests through.
 */

const DEFAULT_PORT = 8080;
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

class ConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConfigError';
    }
}

const toInt = (raw, fallback) => {
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const parsed = Number.parseInt(String(raw).trim(), 10);
    if (Number.isNaN(parsed) || parsed < 0) {
        throw new ConfigError(`Expected a non-negative integer, received "${raw}"`);
    }
    return parsed;
};

/**
 * Builds the config object from a raw environment bag.
 * Exported separately from load() so tests can exercise validation
 * without touching process.env or exiting the process.
 */
const build = (raw = {}) => {
    const apiSecretKey = (raw.API_SECRET_KEY || '').trim();

    if (!apiSecretKey) {
        throw new ConfigError(
            'API_SECRET_KEY is not set. The API refuses to start without it, ' +
            'because an unset key would otherwise let every request through. ' +
            'Set it in .env (see .env.example).'
        );
    }

    if (apiSecretKey.length < 8) {
        throw new ConfigError('API_SECRET_KEY must be at least 8 characters.');
    }

    const mongoUri = (raw.MONGO_URI || '').trim();

    return {
        port: toInt(raw.PORT, DEFAULT_PORT),
        apiSecretKey,

        // Empty mongoUri means "spin up an in-process MongoDB" (see services/db.js).
        mongoUri,
        usesEphemeralDb: mongoUri === '',

        llm: {
            baseUrl: (raw.LLM_BASE_URL || DEFAULT_BASE_URL).trim(),
            apiKey: (raw.LLM_API_KEY || '').trim(),
            model: (raw.LLM_MODEL || DEFAULT_MODEL).trim(),
            timeoutMs: toInt(raw.LLM_TIMEOUT_MS, 20000),
        },

        // Artificial pause before a decoy reply. Defaults to 0: it exists only so a
        // live demo can look less robotic, is reported separately, and is never
        // counted toward any engagement metric.
        replyDelayMs: toInt(raw.REPLY_DELAY_MS, 0),

        logLevel: (raw.LOG_LEVEL || 'info').trim(),
    };
};

const load = (raw = process.env) => build(raw);

module.exports = { build, load, ConfigError };
