/**
 * 🕵️‍♂️ Zero-Latency Intelligence Extractor (V2 - Final Round Compliant)
 */
const logger = require('../utils/logger'); // Ensure logger is imported for error handling

const PATTERNS = {
    // Bank: 9-18 digits. 
    bankAccount: /\b\d{9,18}\b/g,

    // Email: Standard email pattern
    email: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,

    // UPI: username@bank
    upiId: /[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}/g,

    // Phone: Matches +91-98... or 98...
    phone: /(?<!\d)(?:\+91|91)?[\-\s]?[6-9]\d{9}\b/g,

    // Links
    url: /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g,

    // 🆕 NEW: Case IDs / Reference Numbers (e.g., REF-1234, CASE#9988, ID: 567)
    caseId: /\b(?:CASE|REF|ID|TICKET|COMPLAINT)\s*[\-#:]?\s*[A-Z0-9]*\d[A-Z0-9]*\b/gi,

    // 🆕 NEW: Policy Numbers (e.g., POL-12345, POLICY: AB123)
    policyNumber: /\b(?:POL|POLICY)\s*[\-#:]?\s*[A-Z0-9]*\d[A-Z0-9]*\b/gi,

    // 🆕 NEW: Order Numbers (e.g., ORD-5544, ORDER#123)
    orderNumber: /\b(?:ORD|ORDER)\s*[\-#:]?\s*[A-Z0-9]*\d[A-Z0-9]*\b/gi,

    // Keywords (General)
    keywords: /\b(otp|cvv|verif|block|kyc|refund|winner|lottery|expir|urgent|suspend|apk|download|upi|cashback|claim)\w*/gi,

    // Classification Categories
    typeBank: /\b(sbi|hdfc|icici|bank|account|blocked|kyc|pan|debit|credit|card|statement|otp)\b/i,
    typeUPI: /\b(upi|paytm|gpay|phonepe|cashback|reward|wallet|pin|receive|scan)\b/i,
    typePhish: /\b(click|link|http|win|offer|deal|expire|free|iphone|lottery|spin)\b/i
};

// Default empty schema for safe returns
const EMPTY_SCHEMA = {
    bankAccounts: [], upiIds: [], emailAddresses: [], phoneNumbers: [],
    phishingLinks: [], caseIds: [], policyNumbers: [], orderNumbers: [],
    suspiciousKeywords: [], scamType: "unknown"
};

const extract = (text) => {
    // 🛡️ ROBUST VALIDATION: Ensure input is a valid string
    if (text === null || text === undefined) return { ...EMPTY_SCHEMA };

    try {
        const cleanText = String(text).trim();
        if (cleanText.length === 0) return { ...EMPTY_SCHEMA };

        let bankAccounts = cleanText.match(PATTERNS.bankAccount) || [];
        let emails = cleanText.match(PATTERNS.email) || [];
        let upis = cleanText.match(PATTERNS.upiId) || [];
        const phoneNumbers = cleanText.match(PATTERNS.phone) || [];

        // 🧹 CLEANUP 1: Remove phone numbers from bank account list
        bankAccounts = bankAccounts.filter(acc => {
            const isMobileLike = /^[6-9]\d{9}$/.test(acc.replace(/\D/g, ''));
            return !isMobileLike;
        });

        // 🧹 CLEANUP 2: Separate Emails from UPIs
        upis = upis.filter(u => !emails.includes(u));

        // 🧠 CLASSIFICATION: Determine Scam Type
        let detectedType = "unknown";
        if (PATTERNS.typeBank.test(cleanText)) detectedType = "bank_fraud";
        else if (PATTERNS.typeUPI.test(cleanText)) detectedType = "upi_fraud";
        else if (PATTERNS.typePhish.test(cleanText)) detectedType = "phishing";

        return {
            bankAccounts: bankAccounts,
            upiIds: upis,
            emailAddresses: emails,
            phoneNumbers: phoneNumbers,
            phishingLinks: cleanText.match(PATTERNS.url) || [],
            caseIds: cleanText.match(PATTERNS.caseId) || [],       // 🆕 Extracted Case IDs
            policyNumbers: cleanText.match(PATTERNS.policyNumber) || [], // 🆕 Extracted Policies
            orderNumbers: cleanText.match(PATTERNS.orderNumber) || [],  // 🆕 Extracted Orders
            suspiciousKeywords: cleanText.match(PATTERNS.keywords) || [],
            scamType: detectedType
        };

    } catch (error) {
        // 🛡️ ERROR HANDLING: Log securely and prevent application crash
        logger.error(`[Intelligence Extractor] Failed to parse text: ${error.message}`);
        return { ...EMPTY_SCHEMA };
    }
};

module.exports = { extract };