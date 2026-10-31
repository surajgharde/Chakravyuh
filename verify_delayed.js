const axios = require('axios');

const sessionId = `test-delayed-${Date.now()}`;
const payload1 = {
    sessionId: sessionId,
    message: {
        text: "Please contact me at scammer@example.com immediately."
    },
    conversationHistory: []
};
const payload2 = {
    sessionId: sessionId,
    message: {
        text: "Did you get my email? scammer@example.com"
    },
    conversationHistory: [{ role: 'user', content: payload1.message.text }, { role: 'assistant', content: 'Yes' }]
};

async function runTest() {
    try {
        console.log(`🚀 Starting Delayed Report Test for Session: ${sessionId}`);

        console.log("📨 Sending Message 1...");
        await axios.post('http://localhost:8080/api/honeypot', payload1, {
            headers: { 'x-api-key': 'top_3', 'Content-Type': 'application/json' }
        });
        console.log("✅ Message 1 Sent. Check logs for 'Scheduling Report...'");

        console.log("zzz Waiting 5 seconds...");
        await new Promise(r => setTimeout(r, 5000));

        console.log("📨 Sending Message 2...");
        await axios.post('http://localhost:8080/api/honeypot', payload2, {
            headers: { 'x-api-key': 'top_3', 'Content-Type': 'application/json' }
        });
        console.log("✅ Message 2 Sent. Check logs for 'Resetting report timer...'");

        console.log("⏳ Now waiting 25 seconds for the report to trigger...");
        // Wait 25s to allow 15s timer to expire
        await new Promise(r => setTimeout(r, 25000));
        console.log("🏁 Test Finished. Check logs for 'Timer Expired' and 'CALLBACK SUCCESS'.");

    } catch (err) {
        console.error("❌ Error:", err.message);
    }
}

runTest();
