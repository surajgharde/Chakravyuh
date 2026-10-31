const mongoose = require('mongoose');
const Session = require('./models/Session');
const axios = require('axios');
require('dotenv').config();

const runTest = async () => {
    try {
        console.log("🚀 Starting Key Rotation Test...");

        // Connect to DB to check assigned keys
        await mongoose.connect(process.env.MONGO_URI);
        console.log("✅ DB Connected");

        const sessionA = `test-rot-A-${Date.now()}`;
        const sessionB = `test-rot-B-${Date.now()}`;
        const sessionC = `test-rot-C-${Date.now()}`;

        // 1. Session A (Should get Key Index 0)
        console.log(`\n1️⃣ Creating Session A: ${sessionA}`);
        await axios.post('http://localhost:8080/api/honeypot', {
            sessionId: sessionA,
            message: { text: "Hello A" },
            conversationHistory: []
        }, { headers: { 'x-api-key': 'top_3' } });

        // 2. Session B (Should get Key Index 1)
        console.log(`2️⃣ Creating Session B: ${sessionB}`);
        await axios.post('http://localhost:8080/api/honeypot', {
            sessionId: sessionB,
            message: { text: "Hello B" },
            conversationHistory: []
        }, { headers: { 'x-api-key': 'top_3' } });

        // 3. Session C (Should get Key Index 2)
        console.log(`3️⃣ Creating Session C: ${sessionC}`);
        await axios.post('http://localhost:8080/api/honeypot', {
            sessionId: sessionC,
            message: { text: "Hello C" },
            conversationHistory: []
        }, { headers: { 'x-api-key': 'top_3' } });

        // 4. Session A Again (Should Keep Key Index 0 - Sticky)
        console.log(`4️⃣ Session A Returns: ${sessionA}`);
        await axios.post('http://localhost:8080/api/honeypot', {
            sessionId: sessionA,
            message: { text: "back again" },
            conversationHistory: []
        }, { headers: { 'x-api-key': 'top_3' } });

        // Wait for DB writes
        await new Promise(r => setTimeout(r, 2000));

        // Verify Keys
        const docA = await Session.findOne({ sessionId: sessionA });
        const docB = await Session.findOne({ sessionId: sessionB });
        const docC = await Session.findOne({ sessionId: sessionC });

        const keys = (process.env.FAST_ROUTER_KEYS || "").split(',').map(k => k.trim());

        console.log("\n📊 Results:");
        console.log(`Session A Key: ...${docA.assignedKey.slice(-10)} (Index: ${keys.indexOf(docA.assignedKey)})`);
        console.log(`Session B Key: ...${docB.assignedKey.slice(-10)} (Index: ${keys.indexOf(docB.assignedKey)})`);
        console.log(`Session C Key: ...${docC.assignedKey.slice(-10)} (Index: ${keys.indexOf(docC.assignedKey)})`);

        if (docA.assignedKey !== docB.assignedKey && docB.assignedKey !== docC.assignedKey) {
            console.log("✅ SUCCESS: Keys are different (Rotation Working)");
        } else {
            console.log("❌ FAILURE: Keys are same");
        }

        if (keys.indexOf(docA.assignedKey) === 0) console.log("✅ SUCCESS: Sticky Session Working");

        mongoose.connection.close();

    } catch (error) {
        console.error("❌ Error:", error.message);
        if (mongoose.connection.readyState === 1) mongoose.connection.close();
    }
};

runTest();
