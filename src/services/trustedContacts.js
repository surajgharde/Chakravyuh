/**
 * Trusted contacts for a protected user.
 *
 * Reads go through a small in-process cache, because the Guardian consults this
 * on every message and has a 1.5 second budget for the whole decision. The
 * cache is invalidated on every write.
 */

const TrustedContact = require('../models/TrustedContact');
const { normalizePhone } = require('./extractor');
const logger = require('./logger');

const DEFAULT_USER_ID = 'default-user';

/** userId -> Set of normalised identifiers */
const cache = new Map();

/**
 * Normalises an identifier so a contact saved as "98765 43210" matches a
 * caller presented as "+919876543210".
 */
const normalizeIdentifier = (value) => {
    if (value === null || value === undefined) return null;
    const raw = String(value).trim();
    if (raw === '') return null;

    const asPhone = normalizePhone(raw);
    if (asPhone) return asPhone;

    return raw.toLowerCase();
};

const invalidate = (userId) => {
    if (userId) cache.delete(userId);
    else cache.clear();
};

/** All trusted identifiers for a user, as a Set. */
const identifiersFor = async (userId = DEFAULT_USER_ID) => {
    if (cache.has(userId)) return cache.get(userId);

    let identifiers = new Set();
    try {
        const rows = await TrustedContact.find({ userId }, 'identifier');
        identifiers = new Set(rows.map((row) => row.identifier));
    } catch (error) {
        // A database that is unreachable must not make everyone untrusted and
        // it must not crash the turn; it does mean the protection degrades, so
        // it is logged loudly.
        logger.error(`Could not read trusted contacts for ${userId}: ${error.message}`);
    }

    cache.set(userId, identifiers);
    return identifiers;
};

/**
 * Looks up one caller.
 * @returns {Promise<{trusted: boolean, identifier: string|null, contact: object|null}>}
 */
const lookup = async (userId = DEFAULT_USER_ID, callerIdentifier = null) => {
    const identifier = normalizeIdentifier(callerIdentifier);
    if (!identifier) return { trusted: false, identifier: null, contact: null };

    const identifiers = await identifiersFor(userId);
    if (!identifiers.has(identifier)) return { trusted: false, identifier, contact: null };

    let contact = null;
    try {
        contact = await TrustedContact.findOne({ userId, identifier });
    } catch { /* the Set already answered the question that matters */ }

    return { trusted: true, identifier, contact };
};

/** Adds or updates a trusted contact. */
const add = async (userId = DEFAULT_USER_ID, { identifier, label = '', relationship = 'other', addedFrom = 'manual' } = {}) => {
    const normalized = normalizeIdentifier(identifier);
    if (!normalized) {
        const error = new Error('A trusted contact needs an identifier.');
        error.name = 'ValidationError';
        throw error;
    }

    const contact = await TrustedContact.findOneAndUpdate(
        { userId, identifier: normalized },
        {
            $set: { raw: String(identifier), label, relationship, addedFrom },
            $setOnInsert: { userId, identifier: normalized },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    invalidate(userId);
    return contact;
};

const remove = async (userId = DEFAULT_USER_ID, identifier) => {
    const normalized = normalizeIdentifier(identifier);
    if (!normalized) return false;
    const result = await TrustedContact.deleteOne({ userId, identifier: normalized });
    invalidate(userId);
    return result.deletedCount > 0;
};

const list = async (userId = DEFAULT_USER_ID) => TrustedContact.find({ userId }).sort({ createdAt: 1 });

module.exports = {
    lookup,
    add,
    remove,
    list,
    identifiersFor,
    normalizeIdentifier,
    invalidate,
    DEFAULT_USER_ID,
};
