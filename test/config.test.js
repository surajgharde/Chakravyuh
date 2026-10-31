const test = require('node:test');
const assert = require('node:assert/strict');

const { build, ConfigError } = require('../src/config/env');

test('config fails closed when API_SECRET_KEY is missing', () => {
    assert.throws(() => build({}), ConfigError);
    assert.throws(() => build({ API_SECRET_KEY: '' }), ConfigError);
    assert.throws(() => build({ API_SECRET_KEY: '   ' }), ConfigError);
});

test('config rejects a trivially short API_SECRET_KEY', () => {
    assert.throws(() => build({ API_SECRET_KEY: 'short' }), ConfigError);
});

test('config builds with only API_SECRET_KEY set', () => {
    const config = build({ API_SECRET_KEY: 'a-long-enough-key' });
    assert.equal(config.apiSecretKey, 'a-long-enough-key');
    assert.equal(config.port, 8080);
    assert.equal(config.usesEphemeralDb, true, 'empty MONGO_URI means an in-process database');
});

test('reply delay defaults to zero, so no turn is artificially padded', () => {
    const config = build({ API_SECRET_KEY: 'a-long-enough-key' });
    assert.equal(config.replyDelayMs, 0);
});

test('reply delay is honoured when set explicitly', () => {
    const config = build({ API_SECRET_KEY: 'a-long-enough-key', REPLY_DELAY_MS: '1500' });
    assert.equal(config.replyDelayMs, 1500);
});

test('a non-numeric integer setting is rejected rather than silently defaulted', () => {
    assert.throws(() => build({ API_SECRET_KEY: 'a-long-enough-key', PORT: 'eighty' }), ConfigError);
    assert.throws(() => build({ API_SECRET_KEY: 'a-long-enough-key', REPLY_DELAY_MS: '-5' }), ConfigError);
});

test('an external MONGO_URI switches off the in-process database', () => {
    const config = build({ API_SECRET_KEY: 'a-long-enough-key', MONGO_URI: 'mongodb://localhost:27017/x' });
    assert.equal(config.usesEphemeralDb, false);
});

test('LLM settings come from LLM_* variables only', () => {
    const config = build({
        API_SECRET_KEY: 'a-long-enough-key',
        LLM_BASE_URL: 'https://example.test/v1',
        LLM_API_KEY: 'placeholder-key',
        LLM_MODEL: 'some-model',
    });
    assert.equal(config.llm.baseUrl, 'https://example.test/v1');
    assert.equal(config.llm.apiKey, 'placeholder-key');
    assert.equal(config.llm.model, 'some-model');
});
