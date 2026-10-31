require('dotenv').config();
const logger = require('../utils/logger');

// Global Counter for Round Robin
let currentIndex = 0;

/**
 * Parses keys from environment variable
 * Expects comma-separated string: "key1,key2,key3"
 */
const getKeys = () => {
    const raw = process.env.FAST_ROUTER_KEYS || "";
    return raw.split(',').map(k => k.trim()).filter(k => k.length > 0);
};

const keys = getKeys();
logger.info(`🔑 Key Pool Initialized with ${keys.length} keys.`);

/**
 * Get a key for a session.
 * - Sticky: If session already has a valid key, return it.
 * - Round Robin: If new session, pick next available key.
 */
const getKeyForSession = (sessionId, currentProvider, currentKey) => {
    // 1. Sticky Session Check
    if (currentKey && currentProvider === 'fastrouter') {
        // Validate if key still exists in pool (optional but good for safety)
        if (keys.includes(currentKey)) {
            return { key: currentKey, provider: 'fastrouter', index: keys.indexOf(currentKey) };
        }
    }

    // 2. Round Robin Assignment
    if (keys.length === 0) {
        logger.error("❌ NO API KEYS FOUND IN .ENV!");
        return { key: null, provider: null, index: -1 };
    }

    const assignedKey = keys[currentIndex];
    const assignedIndex = currentIndex;

    // Increment and Wrap
    currentIndex = (currentIndex + 1) % keys.length;

    logger.info(`🔑 Session ${sessionId} -> Assigned Key Index ${assignedIndex} (Round Robin)`);

    return { key: assignedKey, provider: 'fastrouter', index: assignedIndex };
};

module.exports = { getKeyForSession, getKeys };