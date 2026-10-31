const axios = require('axios');

const payload = {
    sessionId: `test-${Date.now()}-v2`,
    message: {
        text: "Please contact me at scammer@example.com immediately. My number is 9988776655."
    },
    conversationHistory: []
};

async function runTest() {
    try {
        console.log("Sending payload:", payload);
        const res = await axios.post('http://localhost:8080/api/honeypot', payload, {
            headers: {
                'x-api-key': 'top_3',
                'Content-Type': 'application/json'
            }
        });
        console.log("Response:", res.data);
    } catch (err) {
        console.error("Error:", err.message);
        if (err.response) {
            console.error("Data:", err.response.data);
        }
    }
}

runTest();
