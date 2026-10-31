const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeMessage,
    normalizeHistory,
    normalizeTimestamp,
    toChatMessages,
} = require('../src/services/normalize');

test('accepts the platform shape {sender, text, timestamp}', () => {
    const result = normalizeMessage({
        sender: 'scammer',
        text: 'Your account will be blocked.',
        timestamp: 1770005528731,
    });
    assert.deepEqual(result, { role: 'scammer', text: 'Your account will be blocked.', ts: 1770005528731 });
});

test('accepts the chat shape {role, content}', () => {
    const result = normalizeMessage({ role: 'user', content: 'Verify immediately.' });
    assert.deepEqual(result, { role: 'scammer', text: 'Verify immediately.', ts: null });
});

test('role:assistant is our decoy, role:user is our counterparty', () => {
    assert.equal(normalizeMessage({ role: 'assistant', content: 'Haan beta?' }).role, 'decoy');
    assert.equal(normalizeMessage({ role: 'user', content: 'Pay now' }).role, 'scammer');
});

test('sender:user is the person being protected, not the scammer', () => {
    // The two external shapes disagree about the word "user". `sender` is the
    // real-world speaker, so sender:'user' must map to 'user'.
    assert.equal(normalizeMessage({ sender: 'user', text: 'Why is my account blocked?' }).role, 'user');
});

test('sender wins when both sender and role are present', () => {
    const result = normalizeMessage({ sender: 'user', role: 'user', text: 'hello' });
    assert.equal(result.role, 'user');
});

test('a mixed history normalizes to one internal shape', () => {
    const history = normalizeHistory([
        { sender: 'scammer', text: 'Your bank account will be blocked today.', timestamp: 1770005528731 },
        { sender: 'user', text: 'Why will my account be blocked?', timestamp: 1770005528999 },
        { role: 'assistant', content: 'Beta, I am confused.' },
    ]);

    assert.equal(history.length, 3);
    assert.deepEqual(history.map((m) => m.role), ['scammer', 'user', 'decoy']);
    assert.ok(history.every((m) => typeof m.text === 'string' && 'ts' in m));
});

test('unknown roles fall back to the default rather than being dropped', () => {
    assert.equal(normalizeMessage({ sender: 'unknown-party', text: 'hi' }).role, 'scammer');
    assert.equal(normalizeMessage({ role: 'developer', content: 'hi' }).role, 'scammer');
});

test('messages without usable text are dropped', () => {
    assert.equal(normalizeMessage({ sender: 'scammer', text: '   ' }), null);
    assert.equal(normalizeMessage({ sender: 'scammer' }), null);
    assert.equal(normalizeMessage(null), null);
    assert.equal(normalizeHistory([{ text: '' }, null, { text: 'ok' }]).length, 1);
});

test('a non-array history yields an empty array', () => {
    assert.deepEqual(normalizeHistory(undefined), []);
    assert.deepEqual(normalizeHistory('nope'), []);
});

test('timestamps parse from epoch ms, numeric strings and ISO strings', () => {
    assert.equal(normalizeTimestamp(1770005528731), 1770005528731);
    assert.equal(normalizeTimestamp('1770005528731'), 1770005528731);
    assert.equal(normalizeTimestamp('2026-10-31T10:00:00.000Z'), Date.parse('2026-10-31T10:00:00.000Z'));
});

test('a missing or unparseable timestamp becomes null, never a guess', () => {
    assert.equal(normalizeTimestamp(undefined), null);
    assert.equal(normalizeTimestamp(''), null);
    assert.equal(normalizeTimestamp('not a date'), null);
    assert.equal(normalizeMessage({ sender: 'scammer', text: 'hi' }).ts, null);
});

test('chat mapping keeps only the two speaking sides, in order', () => {
    const messages = [
        { role: 'scammer', text: 'a', ts: null },
        { role: 'guardian', text: 'internal note', ts: null },
        { role: 'decoy', text: 'b', ts: null },
        { role: 'user', text: 'c', ts: null },
    ];
    assert.deepEqual(toChatMessages(messages), [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
    ]);
});
