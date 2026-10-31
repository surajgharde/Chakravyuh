const guviCallback = require('./guviCallback');
const Session = require('../models/Session');
const logger = require('../utils/logger');

// Store timeouts in memory: { sessionId: timeoutObject }
const timeouts = {};

// Delay in milliseconds (15 seconds)
const REPORT_DELAY_MS = 5000;

const scheduleReport = (sessionId) => {
    // 1. Clear existing timeout if any (debounce)
    if (timeouts[sessionId]) {
        clearTimeout(timeouts[sessionId]);
        // logger.info(`⏳ Resetting report timer for Session: ${sessionId}`);
    } else {
        // logger.info(`⏰ Scheduling Report for ${sessionId} in ${REPORT_DELAY_MS / 1000}s...`);
    }

    // 2. Set new timeout
    timeouts[sessionId] = setTimeout(async () => {
        await triggerReport(sessionId);
    }, REPORT_DELAY_MS);
};

const triggerReport = async (sessionId) => {
    try {
        delete timeouts[sessionId]; // Cleanup

        // logger.info(`🚀 Timer Expired. Generating Final Report for ${sessionId}...`);

        const session = await Session.findOne({ sessionId });
        if (!session) {
            logger.error(`❌ Session not found during callback: ${sessionId}`);
            return;
        }

        // Only report if scam was actually detected
        if (!session.scamDetected) {
            // logger.info(`ℹ️ Skipping report for ${sessionId} - No scam detected.`);
            return;
        }

        // Send Report
        const success = await guviCallback.sendReport(session);

        if (success) {
            session.reportSent = true;
            await session.save();
            // logger.info(`✅ Report successfully sent and saved for ${sessionId}`);
        } else {
            logger.warn(`⚠️ Report failed for ${sessionId}. Will not retry automatically.`);
        }

    } catch (error) {
        logger.error(`❌ Error in delayed reporting: ${error.message}`);
    }
};

module.exports = { scheduleReport };
