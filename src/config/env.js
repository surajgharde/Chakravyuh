/**
 * Single source of configuration. Validates on load and fails closed:
 * a missing API_SECRET_KEY stops the process instead of letting requests through.
 */

const DEFAULT_PORT = 8080;

/** Sessions older than this are deleted. See sessionRetentionDays below. */
const DEFAULT_RETENTION_DAYS = 30;

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

        /**
         * FAKE_LLM=1 answers every model call from a script, with no network.
         *
         * For a demo on conference Wi-Fi. The system already works without a
         * model - the Guardian falls back to its rules, the decoy to a table of
         * scripted lines - but those forty-odd sentences start repeating inside
         * six turns, which a judge notices. This fills the same seam with
         * answers written by hand.
         *
         * It is reported by /health and /demo-config and badged in the console
         * for as long as it is on, because a scripted reply presented as a
         * model reply would be a worse failure than an offline demo.
         */
        fakeLlm: ['1', 'true', 'yes'].includes(String(raw.FAKE_LLM || '').trim().toLowerCase()),

        // DEMO_MODE=1 removes the decoy's typing delay, so a live demo does not
        // stall while the persona "types". It changes nothing else.
        demoMode: ['1', 'true', 'yes'].includes(String(raw.DEMO_MODE || '').trim().toLowerCase()),

        // Explicit override for the decoy's typing delay, in milliseconds. Left
        // at 0 the decoy picks a natural 1-3 seconds itself. Either way the
        // pause is reported separately and never counted toward any engagement
        // metric.
        replyDelayMs: toInt(raw.REPLY_DELAY_MS, 0),

        // Guardian thresholds on the 0-100 rule score. A hand-off additionally
        // requires a hard signal, which no threshold can switch off.
        guardianThresholds: {
            decoy: toInt(raw.GUARDIAN_DECOY_THRESHOLD, 60),
            suspicious: toInt(raw.GUARDIAN_SUSPICIOUS_THRESHOLD, 30),
            release: toInt(raw.GUARDIAN_RELEASE_THRESHOLD, 30),
        },

        /**
         * How long a session is kept before it is deleted, in days.
         *
         * A transcript of a scam call is sensitive: it holds what an elderly
         * person was told, when, and by whom. Keeping it forever is a
         * liability, so a sweep deletes anything older than this (see
         * services/retention.js). `0` disables the sweep, which is the only
         * setting under which a session is kept indefinitely - and that is a
         * deliberate choice someone has to make, not the default.
         */
        sessionRetentionDays: toInt(raw.SESSION_RETENTION_DAYS, DEFAULT_RETENTION_DAYS),

        logLevel: (raw.LOG_LEVEL || 'info').trim(),
    };
};

const load = (raw = process.env) => build(raw);

module.exports = { build, load, ConfigError, DEFAULT_RETENTION_DAYS };
