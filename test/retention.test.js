/**
 * Data retention.
 *
 * ETHICS.md claims sessions are deleted after a configurable number of days.
 * These are the tests that make that a fact rather than a sentence: a retention
 * promise nobody checks is the easiest thing in a project to quietly break.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const { MongoMemoryServer } = require('mongodb-memory-server');
const { build, DEFAULT_RETENTION_DAYS } = require('../src/config/env');
const retention = require('../src/services/retention');
const Session = require('../src/models/Session');

let mongoServer;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A session whose last message was `daysAgo` days ago. */
const sessionLastSeen = async (sessionId, daysAgo, extra = {}) => {
    const lastSeenAt = new Date(Date.now() - daysAgo * DAY_MS);
    await Session.create({
        sessionId,
        userId: 'retention-user',
        firstSeenAt: lastSeenAt,
        lastSeenAt,
        messages: [{ messageId: 'm1', role: 'scammer', text: 'share the OTP', receivedAt: lastSeenAt }],
        messageCount: 1,
        ...extra,
    });
};

test.before(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
});

test.after(async () => {
    await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
});

test.beforeEach(async () => {
    await Session.deleteMany({});
});

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

test('a session past the window is deleted and a recent one is kept', async () => {
    await sessionLastSeen('old-40d', 40);
    await sessionLastSeen('old-31d', 31);
    await sessionLastSeen('recent-2d', 2);
    await sessionLastSeen('today', 0);

    const result = await retention.sweep({ retentionDays: 30 });

    assert.equal(result.deleted, 2);
    assert.equal(result.skipped, false);

    const left = (await Session.find({}, 'sessionId')).map((s) => s.sessionId).sort();
    assert.deepEqual(left, ['recent-2d', 'today']);
});

test('the window is configurable, and a shorter one deletes more', async () => {
    await sessionLastSeen('d10', 10);
    await sessionLastSeen('d3', 3);
    await sessionLastSeen('d1', 1);

    // Nothing is older than 30 days.
    assert.equal((await retention.sweep({ retentionDays: 30 })).deleted, 0);

    // A seven-day window takes the oldest.
    assert.equal((await retention.sweep({ retentionDays: 7 })).deleted, 1);

    // A two-day window takes one more.
    assert.equal((await retention.sweep({ retentionDays: 2 })).deleted, 1);

    const left = (await Session.find({}, 'sessionId')).map((s) => s.sessionId);
    assert.deepEqual(left, ['d1']);
});

test('the window is keyed on the last message, not on when the session started', async () => {
    // A long engagement that opened 40 days ago and was still running
    // yesterday is a day old as evidence, not a month.
    const longRunning = new Date(Date.now() - 40 * DAY_MS);
    await Session.create({
        sessionId: 'long-engagement',
        userId: 'retention-user',
        firstSeenAt: longRunning,
        lastSeenAt: new Date(Date.now() - 1 * DAY_MS),
        messageCount: 2,
    });

    const result = await retention.sweep({ retentionDays: 30 });

    assert.equal(result.deleted, 0, 'it was swept on its start date rather than its last message');
    assert.ok(await Session.findOne({ sessionId: 'long-engagement' }));
});

test('a seeded demo session is swept like any other', async () => {
    await sessionLastSeen('seed-old', 45, { seeded: true, seedNote: 'demo' });

    assert.equal((await retention.sweep({ retentionDays: 30 })).deleted, 1);
    assert.equal(await Session.findOne({ sessionId: 'seed-old' }), null);
});

// ---------------------------------------------------------------------------
// Switching it off has to be deliberate and visible
// ---------------------------------------------------------------------------

test('a retention of 0 keeps everything, and says it was skipped', async () => {
    await sessionLastSeen('ancient', 400);

    for (const disabled of [0, -1, undefined, null, NaN]) {
        const result = await retention.sweep({ retentionDays: disabled });
        assert.equal(result.skipped, true, `${disabled} should disable the sweep rather than guess`);
        assert.equal(result.deleted, 0);
        assert.equal(result.cutoff, null);
    }

    assert.ok(await Session.findOne({ sessionId: 'ancient' }), 'a disabled sweep deleted something');
});

test('start() warns rather than silently keeping sessions forever', () => {
    // The only setting under which data is kept indefinitely must be loud
    // about it, because it is the one that creates a liability.
    const logger = require('../src/services/logger');
    const warnings = [];
    const original = logger.warn;
    logger.warn = (message) => warnings.push(message);

    try {
        const handle = retention.start({ sessionRetentionDays: 0 });
        handle.stop();
    } finally {
        logger.warn = original;
    }

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /kept indefinitely/i);
});

test('start() runs a sweep immediately and returns a handle that stops the timer', async () => {
    await sessionLastSeen('old-for-start', 60);

    const handle = retention.start({ sessionRetentionDays: 30 });

    // start() kicks off the first sweep without awaiting it, so give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 60));
    handle.stop();

    assert.equal(await Session.findOne({ sessionId: 'old-for-start' }), null,
        'the boot sweep did not run');
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('the retention window comes from the environment with a sane default', () => {
    const base = { API_SECRET_KEY: 'a-long-enough-key' };

    assert.equal(build(base).sessionRetentionDays, DEFAULT_RETENTION_DAYS);
    assert.equal(DEFAULT_RETENTION_DAYS, 30);
    assert.equal(build({ ...base, SESSION_RETENTION_DAYS: '7' }).sessionRetentionDays, 7);
    assert.equal(build({ ...base, SESSION_RETENTION_DAYS: '0' }).sessionRetentionDays, 0);

    // A nonsense value fails closed at boot rather than being rounded into
    // something arbitrary.
    assert.throws(() => build({ ...base, SESSION_RETENTION_DAYS: 'forever' }));
    assert.throws(() => build({ ...base, SESSION_RETENTION_DAYS: '-5' }));
});

test('the cutoff is the window measured back from now', () => {
    const now = new Date('2026-11-01T12:00:00Z').getTime();

    assert.equal(retention.cutoffFor(30, now).toISOString(), '2026-10-02T12:00:00.000Z');
    assert.equal(retention.cutoffFor(1, now).toISOString(), '2026-10-31T12:00:00.000Z');
    assert.equal(retention.cutoffFor(0, now), null);
});

// ---------------------------------------------------------------------------
// What the claim in ETHICS.md actually rests on
// ---------------------------------------------------------------------------

test('a swept session leaves nothing behind', async () => {
    // Not a soft delete, not an archive: the document is gone, with its
    // transcript, its entities and its guard log.
    await sessionLastSeen('gone', 90, {
        entities: [{
            type: 'upiId', raw: 'mule@okaxis', normalized: 'mule@okaxis',
            sessionId: 'gone', messageId: 'm1',
        }],
        guardLog: [{ ruleIds: ['credential_leak'], reasons: ['leaked an OTP'], redactedDraft: 'The OTP is ######' }],
    });

    await retention.sweep({ retentionDays: 30 });

    assert.equal(await Session.countDocuments({ sessionId: 'gone' }), 0);
    assert.equal(await Session.findOne({ 'entities.normalized': 'mule@okaxis' }), null,
        'the extracted identifiers outlived the session');
});
