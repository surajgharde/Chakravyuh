/**
 * API key check.
 *
 * Fails closed in both directions:
 *   - the process refuses to start without API_SECRET_KEY (config/env.js), so
 *     this middleware can never be handed an empty expected key;
 *   - a request with a missing, malformed or wrong key is rejected.
 *
 * The original code compared against process.env directly, which meant an unset
 * key made `undefined === undefined` true for any request without the header.
 */

const crypto = require('node:crypto');

/** Length-safe comparison, so a wrong key cannot be narrowed down by timing. */
const matches = (provided, expected) => {
    const a = Buffer.from(String(provided));
    const b = Buffer.from(String(expected));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
};

const PUBLIC_PATHS = ['/health'];

const requireApiKey = (expectedKey) => {
    if (!expectedKey || String(expectedKey).trim() === '') {
        // Defence in depth: this should already be impossible.
        throw new Error('requireApiKey was given an empty key; refusing to build an open middleware.');
    }

    return (req, res, next) => {
        if (PUBLIC_PATHS.includes(req.path)) return next();

        const provided = req.headers['x-api-key'];
        if (typeof provided !== 'string' || provided === '' || !matches(provided, expectedKey)) {
            return res.status(401).json({ status: 'error', error: 'Unauthorized' });
        }

        return next();
    };
};

module.exports = { requireApiKey, PUBLIC_PATHS };
