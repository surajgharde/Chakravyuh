/**
 * The only LLM client in the project.
 *
 * One OpenAI-compatible endpoint configured by LLM_BASE_URL / LLM_API_KEY /
 * LLM_MODEL. No key pool and no provider rotation: a single key, a timeout,
 * and exactly one retry on a failure that looks transient.
 */

const { LlmError, LLM_ERROR_CODES } = require('./errors');
const logger = require('../services/logger');

const MAX_ATTEMPTS = 2; // the initial call plus one retry
const RETRY_BACKOFF_MS = 400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Default transport: the official SDK, pointed at whatever OpenAI-compatible
 * base URL is configured. Loaded lazily so tests can inject a fake transport
 * without the SDK ever being constructed.
 */
const createSdkTransport = (config) => {
    const OpenAI = require('openai');
    const client = new OpenAI({
        baseURL: config.baseUrl,
        apiKey: config.apiKey,
        timeout: config.timeoutMs,
        maxRetries: 0, // retries are handled here, so they stay observable
    });

    return async (request) => {
        const response = await client.chat.completions.create(request);
        return response?.choices?.[0]?.message?.content ?? '';
    };
};

// A provider error worth one more attempt: timeouts, socket resets, 429s and 5xx.
const isTransient = (error) => {
    const status = error?.status ?? error?.response?.status;
    if (status === 429 || (status >= 500 && status < 600)) return true;

    const code = String(error?.code ?? '');
    if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)) return true;

    return /timeout|timed out|socket hang up|aborted/i.test(String(error?.message ?? ''));
};

const isTimeout = (error) => {
    const code = String(error?.code ?? '');
    if (code === 'ETIMEDOUT') return true;
    if (error?.name === 'APIConnectionTimeoutError' || error?.name === 'AbortError') return true;
    return /timeout|timed out/i.test(String(error?.message ?? ''));
};

class LlmClient {
    /**
     * @param {object} config  the `llm` slice of the app config
     * @param {object} [deps]  { transport } — injectable for tests
     */
    constructor(config, deps = {}) {
        this.config = config;
        this.transport = deps.transport ?? null;
        this.sleep = deps.sleep ?? sleep;
    }

    get configured() {
        return Boolean(this.config.apiKey) || Boolean(this.transport);
    }

    #transport() {
        if (!this.transport) this.transport = createSdkTransport(this.config);
        return this.transport;
    }

    /**
     * Sends a chat completion and returns the raw assistant text.
     * Throws LlmError on every failure path.
     */
    async complete({ messages, temperature = 0.7, maxTokens = 400, json = false }) {
        if (!this.configured) {
            throw new LlmError(
                LLM_ERROR_CODES.NOT_CONFIGURED,
                'LLM_API_KEY is not set, so no model call can be made.',
                { attempts: 0 }
            );
        }

        const request = {
            model: this.config.model,
            messages,
            temperature,
            max_tokens: maxTokens,
        };
        if (json) request.response_format = { type: 'json_object' };

        const transport = this.#transport();
        let lastError = null;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
            try {
                const content = await transport(request);
                if (!content || String(content).trim() === '') {
                    throw new LlmError(LLM_ERROR_CODES.EMPTY, 'Model returned an empty response.', { attempts: attempt });
                }
                return String(content);
            } catch (error) {
                lastError = error;

                // An empty response is a real answer, not a transport fault: do not retry.
                if (error instanceof LlmError) throw error;

                const retryable = isTransient(error) && attempt < MAX_ATTEMPTS;
                if (!retryable) {
                    const code = isTimeout(error) ? LLM_ERROR_CODES.TIMEOUT : LLM_ERROR_CODES.TRANSPORT;
                    throw new LlmError(code, `LLM call failed: ${error.message}`, { attempts: attempt, cause: error });
                }

                logger.warn(`LLM attempt ${attempt} failed (${error.message}); retrying once.`);
                await this.sleep(RETRY_BACKOFF_MS);
            }
        }

        // Unreachable in practice; kept so the loop can never fall through silently.
        throw new LlmError(LLM_ERROR_CODES.TRANSPORT, `LLM call failed: ${lastError?.message}`, {
            attempts: MAX_ATTEMPTS,
            cause: lastError,
        });
    }

    /**
     * Same as complete(), but parses the reply as JSON.
     * Tolerates a model that wraps its object in prose or a fenced block.
     */
    async completeJson(options) {
        const raw = await this.complete({ ...options, json: true });

        try {
            return JSON.parse(raw);
        } catch {
            const match = raw.match(/\{[\s\S]*\}/);
            if (match) {
                try {
                    return JSON.parse(match[0]);
                } catch { /* fall through to the error below */ }
            }
            throw new LlmError(
                LLM_ERROR_CODES.BAD_JSON,
                'Model reply could not be parsed as JSON.',
                { attempts: 1 }
            );
        }
    }
}

module.exports = { LlmClient, LlmError, LLM_ERROR_CODES };
