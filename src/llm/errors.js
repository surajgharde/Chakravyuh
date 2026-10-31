/**
 * One error type for every LLM failure, so callers can branch on `code`
 * instead of string-matching provider messages.
 */

const LLM_ERROR_CODES = {
    NOT_CONFIGURED: 'not_configured', // no LLM_API_KEY
    TIMEOUT: 'timeout',               // exceeded timeoutMs on both attempts
    TRANSPORT: 'transport',           // network / HTTP / provider error
    EMPTY: 'empty',                   // provider returned no content
    BAD_JSON: 'bad_json',             // asked for JSON, got something else
};

class LlmError extends Error {
    constructor(code, message, options = {}) {
        super(message);
        this.name = 'LlmError';
        this.code = code;
        this.attempts = options.attempts ?? 1;
        if (options.cause) this.cause = options.cause;
        // True when the caller can reasonably fall back to non-LLM behaviour.
        this.recoverable = code !== LLM_ERROR_CODES.NOT_CONFIGURED;
    }
}

module.exports = { LlmError, LLM_ERROR_CODES };
