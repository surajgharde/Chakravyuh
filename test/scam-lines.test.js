/**
 * Fifteen realistic lines from scams that actually run in India, in English,
 * Hinglish and Marathi, Devanagari and romanised.
 *
 * Each case asserts what must be extracted and which script stages must be
 * tagged. These are the regression bed for the extractor: a change that breaks
 * a real scam line breaks a test here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const extractor = require('../src/services/extractor');
const stages = require('../src/services/stages');

const CASES = [
    {
        name: '1. digital arrest, opening (English)',
        text: 'Madam, this is Sub Inspector Deshmukh from the Andheri cyber crime branch. '
            + 'A FedEx parcel in your name containing 400 grams of MDMA has been seized at Mumbai customs. '
            + 'FIR number MUM/CYB/2026/00891 is registered against you and a non-bailable warrant is ready.',
        entities: {
            impersonatedAuthority: ['police', 'cyber cell', 'courier', 'customs'],
            caseRef: ['MUM/CYB/2026/00891'],
        },
        stages: ['AUTHORITY_CLAIM', 'ACCUSATION', 'THREAT'],
    },
    {
        name: '2. digital arrest, the ask (English)',
        text: 'Do not disconnect this call and do not inform anyone in your family. '
            + 'Transfer Rs 2,50,000 to the RBI verification account 50100234567890, IFSC SBIN0001234. '
            + 'The amount is fully refundable after clearance.',
        entities: {
            amount: [250000],
            bankAccount: ['50100234567890'],
            ifsc: ['SBIN0001234'],
            impersonatedAuthority: ['RBI'],
        },
        stages: ['ISOLATION', 'PAYMENT_DEMAND', 'VERIFICATION_LURE'],
    },
    {
        name: '3. KYC phishing with an obfuscated link (Hinglish)',
        text: 'Sir aapka SBI account KYC pending hai, aaj hi update karna hoga warna account block ho jayega. '
            + 'Is link par click kijiye hxxp://sbi-kyc[.]in/update',
        entities: {
            url: ['http://sbi-kyc.in/update'],
            impersonatedAuthority: ['bank'],
        },
        stages: ['AUTHORITY_CLAIM', 'THREAT'],
    },
    {
        name: '4. UPI refund trick (Hinglish)',
        text: 'Bhaiya maine galti se aapke account me 5000 bhej diya hai. '
            + 'Kripya refund@okaxis par wapas bhej dijiye, jaldi kijiye please.',
        entities: {
            upiId: ['refund@okaxis'],
        },
        stages: ['PAYMENT_DEMAND'],
    },
    {
        name: '5. card block and OTP (Hindi, Devanagari)',
        text: 'मैं एचडीएफसी बैंक से बोल रहा हूं। आपका डेबिट कार्ड ब्लॉक हो गया है। तुरंत ओटीपी बताओ।',
        entities: {},
        stages: ['AUTHORITY_CLAIM', 'URGENCY', 'CREDENTIAL_REQUEST'],
    },
    {
        name: '6. electricity disconnection (Marathi, Devanagari digits)',
        text: 'नमस्कार, मी महावितरण मधून बोलत आहे. तुमचे वीज बिल भरले नाही, आज रात्री कनेक्शन बंद होईल. '
            + '९८७६५४३२१० या नंबरवर ताबडतोब कॉल करा.',
        entities: {
            phone: ['+919876543210'],
            impersonatedAuthority: ['electricity board'],
        },
        stages: ['CONTACT', 'AUTHORITY_CLAIM', 'URGENCY'],
    },
    {
        name: '7. penalty into an account (Marathi)',
        text: 'दंडाची रक्कम पाच लाख आहे. ती खात्यात 50100234567890 जमा करा आणि कोणालाही सांगू नका.',
        entities: {
            amount: [500000],
            bankAccount: ['50100234567890'],
        },
        stages: ['ISOLATION', 'PAYMENT_DEMAND'],
    },
    {
        name: '8. lottery with an advance fee (English)',
        text: 'Congratulations! You have won Rs 25 lakh in the KBC lucky draw. '
            + 'Pay the processing fee of 18500 rupees to claim your prize. Contact 9876543210 immediately.',
        entities: {
            amount: [2500000, 18500],
            phone: ['+919876543210'],
        },
        stages: ['URGENCY', 'PAYMENT_DEMAND'],
    },
    {
        name: '9. tech support with an apk (English)',
        text: 'Your computer is infected with a dangerous virus. '
            + 'Please install AnyDesk from http://quick-support.site/helper.apk so our technician can fix it.',
        entities: {
            apkLink: ['http://quick-support.site/helper.apk'],
        },
        stages: ['CREDENTIAL_REQUEST'],
    },
    {
        name: '10. crypto investment (English)',
        text: 'Guaranteed 300 percent returns in 30 days. Send 0.5 BTC to 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa '
            + 'or USDT to TQ5NMqJjKPjGGLLFMkqTz6kaFiLBf5H2rN today itself.',
        entities: {
            cryptoWallet: ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'TQ5NMqJjKPjGGLLFMkqTz6kaFiLBf5H2rN'],
        },
        stages: ['URGENCY', 'PAYMENT_DEMAND'],
    },
    {
        name: '11. TRAI SIM misuse with an Aadhaar (English)',
        text: 'This is TRAI. Your Aadhaar 2345 6789 0124 has been misused to issue 17 SIM cards '
            + 'for illegal activity. Your number will be disconnected within 2 hours.',
        entities: {
            aadhaar: ['234567890124'],
            impersonatedAuthority: ['TRAI'],
        },
        stages: ['AUTHORITY_CLAIM', 'ACCUSATION', 'THREAT', 'URGENCY'],
        notEntities: {
            bankAccount: '12 digits near "Aadhaar" is not an account number',
        },
    },
    {
        name: '12. number dictated aloud (English)',
        text: 'Sir, note down the customs officer number: nine eight seven six five four three two one zero. '
            + 'Call within 30 minutes or the case proceeds.',
        entities: {
            phone: ['+919876543210'],
            impersonatedAuthority: ['customs'],
        },
        stages: ['URGENCY'],
    },
    {
        name: '13. job scam with a UPI handle (Hinglish)',
        text: 'Work from home job hai madam, daily 2000 rupees milega. '
            + 'Registration fee 1500 rupees 8899776655@ybl par paytm kar dijiye.',
        entities: {
            upiId: ['8899776655@ybl'],
            amount: [2000, 1500],
        },
        stages: ['PAYMENT_DEMAND'],
    },
    {
        name: '14. hawala accusation (romanised Marathi)',
        text: 'Mi Pune police station madhun bolat aahe. Tumchya khatyat hawala che paise aale aahet. '
            + 'Lagech 1 lakh transfer kara, konala sangu naka.',
        entities: {
            amount: [100000],
            impersonatedAuthority: ['police'],
        },
        stages: ['AUTHORITY_CLAIM', 'ACCUSATION', 'PAYMENT_DEMAND'],
    },
    {
        name: '15. email phishing with a short link (English)',
        text: 'Dear customer, your account is suspended. Reply to support@sbi-verification.com '
            + 'or visit bit.ly/sbi-kyc to reactivate. Reference number REF-889213.',
        entities: {
            email: ['support@sbi-verification.com'],
            url: ['http://bit.ly/sbi-kyc'],
            caseRef: ['REF-889213'],
        },
        stages: ['THREAT'],
        notEntities: {
            upiId: 'an email domain is never a UPI id',
        },
    },
];

const CTX = { sessionId: 'lines', messageId: 'm1', timestamp: new Date('2026-10-31T10:00:00.000Z') };

for (const scenario of CASES) {
    test(scenario.name, () => {
        const entities = extractor.extractEntities(scenario.text, CTX);
        const byType = (type) => entities.filter((e) => e.type === type).map((e) => e.normalized);

        for (const [type, expected] of Object.entries(scenario.entities)) {
            const found = byType(type);
            for (const value of expected) {
                assert.ok(
                    found.includes(value),
                    `expected ${type} ${JSON.stringify(value)}, found ${JSON.stringify(found)}`
                );
            }
        }

        for (const [type, why] of Object.entries(scenario.notEntities || {})) {
            assert.deepEqual(byType(type), [], why);
        }

        const tagged = stages.tagWithRules(scenario.text).map((t) => t.stage);
        for (const stage of scenario.stages) {
            assert.ok(tagged.includes(stage), `expected stage ${stage}, found ${tagged.join(',') || 'none'}`);
        }
    });
}

test('every entity from every line carries full provenance', () => {
    for (const scenario of CASES) {
        for (const entity of extractor.extractEntities(scenario.text, CTX)) {
            assert.equal(entity.sessionId, 'lines', scenario.name);
            assert.equal(entity.messageId, 'm1', scenario.name);
            assert.ok(entity.timestamp instanceof Date, scenario.name);
            assert.ok(entity.sentence.length > 0, scenario.name);
            assert.ok(scenario.text.includes(entity.sentence), `${scenario.name}: sentence must be verbatim`);
            assert.ok(['rules', 'llm'].includes(entity.method), scenario.name);
        }
    }
});

test('legitimate messages yield no payment route and no alarming stages', () => {
    const legitimate = [
        'Sir, your Amazon parcel is at the gate, please come down to collect it.',
        'Beta, I am reaching home by seven, please keep the gate open.',
        'Your prescription is ready for pickup at Apollo Pharmacy till 8 pm.',
        'नमस्कार, तुमची अपॉइंटमेंट उद्या सकाळी दहा वाजता आहे.',
    ];

    for (const text of legitimate) {
        const summary = extractor.summarize(extractor.extractEntities(text, CTX));
        for (const field of ['bankAccounts', 'upiIds', 'cryptoWallets', 'apkLinks']) {
            assert.deepEqual(summary[field], [], `${text} -> ${field}`);
        }

        const tagged = stages.tagWithRules(text).map((t) => t.stage);
        for (const stage of ['ACCUSATION', 'THREAT', 'ISOLATION', 'CREDENTIAL_REQUEST', 'VERIFICATION_LURE']) {
            assert.ok(!tagged.includes(stage), `${text} must not be tagged ${stage}`);
        }
    }
});
