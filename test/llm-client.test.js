const test = require('node:test');
const assert = require('node:assert/strict');

const { LlmClient, LlmError, LLM_ERROR_CODES } = require('../src/llm/client');

const config = { baseUrl: 'https://example.test/v1', apiKey: 'placeholder', model: 'test-model', timeoutMs: 1000 };
const noSleep = () => Promise.resolve();

test('refuses to call when no key is configured', async () => {
    const client = new LlmClient({ ...config, apiKey: '' });
    await assert.rejects(
        () => client.complete({ messages: [] }),
        (error) => {
            assert.ok(error instanceof LlmError);
            assert.equal(error.code, LLM_ERROR_CODES.NOT_CONFIGURED);
            assert.equal(error.recoverable, false);
            return true;
        }
    );
});

test('returns the assistant text on success', async () => {
    const client = new LlmClient(config, { transport: async () => 'hello there' });
    assert.equal(await client.complete({ messages: [] }), 'hello there');
});

test('passes model, temperature and max_tokens through to the transport', async () => {
    let seen = null;
    const client = new LlmClient(config, { transport: async (req) => { seen = req; return 'ok'; } });
    await client.complete({ messages: [{ role: 'user', content: 'hi' }], temperature: 0, maxTokens: 50 });

    assert.equal(seen.model, 'test-model');
    assert.equal(seen.temperature, 0);
    assert.equal(seen.max_tokens, 50);
    assert.equal(seen.response_format, undefined);
});

test('json mode asks the provider for a JSON object', async () => {
    let seen = null;
    const client = new LlmClient(config, { transport: async (req) => { seen = req; return '{"a":1}'; } });
    assert.deepEqual(await client.completeJson({ messages: [] }), { a: 1 });
    assert.deepEqual(seen.response_format, { type: 'json_object' });
});

test('retries exactly once on a transient failure', async () => {
    let attempts = 0;
    const client = new LlmClient(config, {
        sleep: noSleep,
        transport: async () => {
            attempts += 1;
            if (attempts === 1) {
                const error = new Error('socket hang up');
                error.code = 'ECONNRESET';
                throw error;
            }
            return 'recovered';
        },
    });

    assert.equal(await client.complete({ messages: [] }), 'recovered');
    assert.equal(attempts, 2, 'one retry, not a loop');
});

test('gives up after the single retry and reports the attempt count', async () => {
    let attempts = 0;
    const client = new LlmClient(config, {
        sleep: noSleep,
        transport: async () => {
            attempts += 1;
            const error = new Error('service unavailable');
            error.status = 503;
            throw error;
        },
    });

    await assert.rejects(
        () => client.complete({ messages: [] }),
        (error) => {
            assert.equal(error.code, LLM_ERROR_CODES.TRANSPORT);
            assert.equal(error.attempts, 2);
            return true;
        }
    );
    assert.equal(attempts, 2, 'no third attempt');
});

test('a timeout is reported as its own error code', async () => {
    const client = new LlmClient(config, {
        sleep: noSleep,
        transport: async () => {
            const error = new Error('Request timed out.');
            error.code = 'ETIMEDOUT';
            throw error;
        },
    });

    await assert.rejects(
        () => client.complete({ messages: [] }),
        (error) => {
            assert.equal(error.code, LLM_ERROR_CODES.TIMEOUT);
            assert.equal(error.recoverable, true);
            return true;
        }
    );
});

test('a non-transient failure is not retried', async () => {
    let attempts = 0;
    const client = new LlmClient(config, {
        sleep: noSleep,
        transport: async () => {
            attempts += 1;
            const error = new Error('invalid request');
            error.status = 400;
            throw error;
        },
    });

    await assert.rejects(() => client.complete({ messages: [] }), { code: LLM_ERROR_CODES.TRANSPORT });
    assert.equal(attempts, 1, 'a 400 will not succeed on retry');
});

test('an empty response is an error, not a silent empty string', async () => {
    const client = new LlmClient(config, { transport: async () => '   ' });
    await assert.rejects(() => client.complete({ messages: [] }), { code: LLM_ERROR_CODES.EMPTY });
});

test('unparseable JSON surfaces as BAD_JSON', async () => {
    const client = new LlmClient(config, { transport: async () => 'I am not JSON at all.' });
    await assert.rejects(() => client.completeJson({ messages: [] }), { code: LLM_ERROR_CODES.BAD_JSON });
});

test('JSON wrapped in prose is still recovered', async () => {
    const client = new LlmClient(config, {
        transport: async () => 'Here you go:\n```json\n{"intent":"scam"}\n```\n',
    });
    assert.deepEqual(await client.completeJson({ messages: [] }), { intent: 'scam' });
});
