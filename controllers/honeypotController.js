const sessionManager = require('../services/sessionManager');
const logger = require('../utils/logger');

exports.processMessage = async (req, res) => {
    try {
        // ✅ FIXED: Extract conversationHistory and metadata
        const { sessionId, message, conversationHistory, metadata } = req.body;

        if (!sessionId || !message || !message.text) {
            return res.status(200).json({ error: "Invalid Payload" });
        }

        // ⏱️ 28s Hard Timeout Protection (Accommodates 19-23s delay + AI time)
        const timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Timeout")), 28000)
        );

        // ✅ FIXED: Pass history and metadata to the manager
        const processing = sessionManager.handleSession(
            sessionId,
            message.text,
            conversationHistory || [],
            message.timestamp,
            metadata || {} // 🆕 Pass metadata
        );

        const reply = await Promise.race([processing, timeout]);

        res.json({
            status: "success",
            reply: reply
        });

    } catch (error) {
        logger.error(`Controller Error: ${error.message}`);

        // Fail-safe response
        res.status(200).json({
            status: "success",
            reply: "I didn't understand that, sorry."
        });
    }
};

const guviCallback = require('../services/guviCallback');
const Session = require('../models/Session');

exports.getCallbackPreview = async (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = await Session.findOne({ sessionId });

        if (!session) {
            return res.status(200).json({ error: "Session not found" });
        }

        const payload = guviCallback.generatePayload(session);
        res.json(payload);
    } catch (error) {
        logger.error(`Preview Error: ${error.message}`);
        res.status(200).json({ error: "Internal Server Error" });
    }
};
