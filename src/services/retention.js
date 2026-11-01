/**
 * Data retention.
 *
 * A session holds a transcript of what an elderly person was told during a
 * scam attempt, the identifiers the caller gave, and the times of both. That is
 * sensitive, and keeping it forever is a liability rather than an asset: once a
 * report has been read by the family and filed or dropped, the transcript has
 * no further use.
 *
 * So sessions are deleted after `SESSION_RETENTION_DAYS` (30 by default). The
 * sweep runs once at boot and then on a timer, and logs what it removed.
 *
 * WHY A SWEEP RATHER THAN A TTL INDEX
 *
 * MongoDB can expire documents itself with a TTL index, which would be less
 * code. But the expiry window is baked into the index when it is created, so
 * changing SESSION_RETENTION_DAYS would need the index dropped and rebuilt,
 * and a deployment that had never run the new value would keep silently
 * applying the old one. A sweep reads the current configuration every time it
 * runs, which is what "configurable" has to mean to be worth claiming.
 *
 * Seeded demo sessions are swept like any other. Nothing here is exempt.
 */

const Session = require('../models/Session');
const logger = require('./logger');

/** How often the sweep runs while the process is up. */
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // six hours

/** The cutoff date for a given retention window, or null if disabled. */
const cutoffFor = (days, now = Date.now()) => {
    if (!Number.isFinite(days) || days <= 0) return null;
    return new Date(now - days * 24 * 60 * 60 * 1000);
};

/**
 * Deletes every session last seen before the cutoff.
 *
 * Keyed on `lastSeenAt` rather than `createdAt`: a long engagement that started
 * 31 days ago and was still running yesterday is a day old as evidence, not a
 * month. Returns what it did so a caller can log or assert on it.
 *
 * @param {object} [options]
 * @param {number} [options.retentionDays]
 * @param {Date}   [options.now]
 * @returns {Promise<{deleted: number, cutoff: Date|null, skipped: boolean}>}
 */
const sweep = async ({ retentionDays, now = new Date() } = {}) => {
    const cutoff = cutoffFor(retentionDays, now.getTime());

    if (cutoff === null) {
        return { deleted: 0, cutoff: null, skipped: true };
    }

    const result = await Session.deleteMany({ lastSeenAt: { $lt: cutoff } });
    const deleted = result.deletedCount || 0;

    if (deleted > 0) {
        logger.info(`Retention sweep deleted ${deleted} session(s) last seen before `
            + `${cutoff.toISOString()} (${retentionDays}-day window).`);
    }

    return { deleted, cutoff, skipped: false };
};

/**
 * Runs the sweep at boot and then every six hours.
 *
 * The timer is unref'd so it never holds the process open on its own, and the
 * handle is returned so a caller can stop it.
 *
 * @param {object} config  from config/env.js
 * @returns {{stop: function}}
 */
const start = (config = {}) => {
    const retentionDays = config.sessionRetentionDays;

    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
        logger.warn('SESSION_RETENTION_DAYS is 0: sessions are kept indefinitely. '
            + 'Set it to a number of days so transcripts do not accumulate.');
        return { stop: () => {} };
    }

    logger.info(`Sessions are deleted ${retentionDays} days after they were last seen.`);

    const run = () => sweep({ retentionDays }).catch((error) => {
        logger.error(`Retention sweep failed: ${error.message}`);
    });

    run();

    const timer = setInterval(run, SWEEP_INTERVAL_MS);
    timer.unref?.();

    return { stop: () => clearInterval(timer) };
};

module.exports = { sweep, start, cutoffFor, SWEEP_INTERVAL_MS };
