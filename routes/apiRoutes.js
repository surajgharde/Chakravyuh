const express = require('express');
const router = express.Router();
const controller = require('../controllers/honeypotController');

/**
 * @swagger
 * /api/honeypot:
 *   post:
 *     summary: Process a message from a scammer
 *     description: Processes an incoming message, updates session history, extracts intelligence, and returns an AI-generated reply.
 *     tags: [Honeypot]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - sessionId
 *               - message
 *             properties:
 *               sessionId:
 *                 type: string
 *                 example: "session_12345"
 *               message:
 *                 type: object
 *                 properties:
 *                   text:
 *                     type: string
 *                     example: "Hello, your bank account is blocked."
 *     responses:
 *       200:
 *         description: AI generated reply
 *       401:
 *         description: Unauthorized
 */
router.post('/honeypot', controller.processMessage);

/**
 * @swagger
 * /api/callback-preview/{sessionId}:
 *   get:
 *     summary: Preview the callback payload for a session
 *     description: Returns the exact JSON payload that would be sent to the callback URL. Useful for debugging 422 errors.
 *     tags: [Honeypot]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         schema:
 *           type: string
 *         required: true
 *         description: The ID of the session to preview
 *     responses:
 *       200:
 *         description: The callback payload
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       404:
 *         description: Session not found
 */
router.get('/callback-preview/:sessionId', controller.getCallbackPreview);

module.exports = router;