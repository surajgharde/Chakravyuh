const axios = require('axios');

const payload = {
    sessionId: `test-backup-${Date.now()}`,
    message: {
        text: "I am from the bank. Give me your password now."
    },
    conversationHistory: []
};

async function runTest() {
    try {
        console.log("🚀 Sending request to trigger backup...");
        // Use a valid key format, but the server will try FastRouter first.
        // We expect FastRouter to fail (due to our manual break) and Open AI to succeed.
        const res = await axios.post('http://localhost:8080/api/honeypot', payload, {
            headers: {
                'x-api-key': 'top_3',
                'Content-Type': 'application/json'
            }
        });
        console.log("✅ Response Received:", res.data);
        console.log("👉 Check logs for 'FASTROUTER FAILURE' and 'Switching to Backup Provider'.");
    } catch (err) {
        console.error("❌ Error:", err.message);
        if (err.response) console.error(err.response.data);
    }
}

runTest();
