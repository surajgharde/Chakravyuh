const test = require('node:test');
const assert = require('node:assert/strict');

const { requireApiKey } = require('../src/middleware/auth');

const fakeRes = () => {
    const res = { statusCode: null, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    return res;
};

const run = (middleware, headers, path = '/api/message') => {
    const res = fakeRes();
    let passed = false;
    middleware({ headers, path }, res, () => { passed = true; });
    return { passed, res };
};

test('refuses to build an open middleware when no key is configured', () => {
    // The original code compared req header against process.env directly, so an
    // unset API_SECRET_KEY let every request through on `undefined === undefined`.
    assert.throws(() => requireApiKey(''), /empty key/);
    assert.throws(() => requireApiKey(undefined), /empty key/);
    assert.throws(() => requireApiKey('   '), /empty key/);
});

test('a request with no key is rejected', () => {
    const { passed, res } = run(requireApiKey('the-expected-key'), {});
    assert.equal(passed, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'Unauthorized');
});

test('a request with a wrong key is rejected', () => {
    const { passed, res } = run(requireApiKey('the-expected-key'), { 'x-api-key': 'guess' });
    assert.equal(passed, false);
    assert.equal(res.statusCode, 401);
});

test('a key of the right length but wrong value is rejected', () => {
    const { passed } = run(requireApiKey('the-expected-key'), { 'x-api-key': 'the-expected-KEY' });
    assert.equal(passed, false);
});

test('an undefined header value is rejected rather than compared', () => {
    const { passed } = run(requireApiKey('the-expected-key'), { 'x-api-key': undefined });
    assert.equal(passed, false);
});

test('the correct key is accepted', () => {
    const { passed } = run(requireApiKey('the-expected-key'), { 'x-api-key': 'the-expected-key' });
    assert.equal(passed, true);
});

test('health is reachable without a key', () => {
    const { passed } = run(requireApiKey('the-expected-key'), {}, '/health');
    assert.equal(passed, true);
});
