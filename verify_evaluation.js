const axios = require('axios');
const mongoose = require('mongoose');
const Session = require('./models/Session');
require('dotenv').config();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const runTest = async () => {
    try {
        console.log("🚀 Starting Evaluation Compliance Test...");
        await mongoose.connect(process.env.MONGO_URI);

        const sessionId = `eval-test-${Date.now()}`;
        const startTime = new Date().toISOString();

        // 1. Turn 1: Bank Fraud Init
        console.log(`\n1️⃣ Turn 1: Sending 'Bank Fraud' Prompt...`);
        await axios.post('http://localhost:8080/api/honeypot', {
            sessionId,
            message: {
                text: "URGENT: Your SBI account is blocked. Share OTP.",
                timestamp: startTime
            },
            conversationHistory: []
        }, { headers: { 'x-api-key': 'top_3' } });

        await sleep(2000);

        // 2. Turn 2: Providing Fake Intel
        console.log(`2️⃣ Turn 2: Providing Fake Phone Number...`);
        const midTime = new Date(Date.now() + 5000).toISOString(); // +5s
        await axios.post('http://localhost:8080/api/honeypot', {
            sessionId,
            message: {
                text: "Call me at +91-9876543210 immediately.",
                timestamp: midTime
            },
            conversationHistory: []
        }, { headers: { 'x-api-key': 'top_3' } });

        console.log("⏳ Waiting 6s for Callback (Debounce is 5s)...");
        await sleep(7000);

        // 3. Verify Database State
        const sessionDoc = await Session.findOne({ sessionId });
        console.log("\n📊 Verification Results:");
        console.log(`- Scam Detected: ${sessionDoc.scamDetected}`);
        console.log(`- Scam Type: ${sessionDoc.scamType} (Expected: bank_fraud/phishing)`);
        console.log(`- Agent Notes: ${sessionDoc.agentNotes ? "✅ Present" : "❌ Missing"}`);
        try {
            console.log(`- Duration: ${Math.floor((sessionDoc.lastMessageTime - sessionDoc.startTime) / 1000)}s`);
            console.log(`- Phone Extracted: ${sessionDoc.intelligence.phoneNumbers.includes("+91-9876543210")}`);
        } catch (e) { console.log(e.message); }

        if (sessionDoc.scamDetected && sessionDoc.scamType !== 'unknown' && sessionDoc.agentNotes) {
            console.log("✅ SUCCESS: System is Evaluation Ready!");
        } else {
            console.log("❌ FAILURE: Missing critical evaluation fields.");
        }

        mongoose.connection.close();

    } catch (error) {
        console.error("❌ Error:", error.message);
        if (mongoose.connection.readyState === 1) mongoose.connection.close();
    }
};

runTest();
