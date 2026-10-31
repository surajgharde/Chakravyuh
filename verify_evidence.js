const axios = require('axios');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const runTest = async () => {
    try {
        console.log("🚀 Starting Evidence-Based Reporting Test...");

        // Session 1: NO EVIDENCE (Should NOT trigger callback)
        const sessionNoEvidence = `test-no-evidence-${Date.now()}`;
        console.log(`\n📨 Sending Message for Session: ${sessionNoEvidence} (No Keywords)`);
        await axios.post('http://localhost:8080/api/honeypot', {
            sessionId: sessionNoEvidence,
            message: { text: "Hello, how are you?" }, // Innocent text
            conversationHistory: []
        }, { headers: { 'x-api-key': 'top_3' } });
        console.log("✅ Message Sent. Waiting 7s (Should see NO callback log)...");
        await sleep(7000);

        // Session 2: WITH EVIDENCE (Should trigger callback)
        const sessionWithEvidence = `test-with-evidence-${Date.now()}`;
        console.log(`\n📨 Sending Message for Session: ${sessionWithEvidence} (With Keywords)`);
        await axios.post('http://localhost:8080/api/honeypot', {
            sessionId: sessionWithEvidence,
            message: { text: "Send the OTP and Bank Details immediately." }, // Keywords: OTP, Bank
            conversationHistory: []
        }, { headers: { 'x-api-key': 'top_3' } });
        console.log("✅ Message Sent. Waiting 7s (Should see callback log)...");
        await sleep(7000);

        console.log("\n🏁 Test Finished. Check server logs.");

    } catch (error) {
        console.error("❌ Error:", error.message);
    }
};

runTest();
