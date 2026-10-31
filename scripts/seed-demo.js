#!/usr/bin/env node
/**
 * Seeds five past sessions so the network view has something in it during a
 * demo.
 *
 * These are synthetic, and they say so: every seeded session carries
 * `seeded: true` and a `seedNote`. They are built by running real transcripts
 * through the real extractor and stage tagger, so the identifiers, provenance
 * and stage tags in them are produced the same way a live session's are. The
 * only thing invented is the conversation itself.
 *
 * Two deliberate overlaps, which is the point of the exercise:
 *   - the UPI id  cyber.verify@okaxis  appears in sessions 1 and 3
 *   - the phone   +919812345678        appears in sessions 2 and 5
 *
 * Usage:  npm run seed
 */

require('dotenv').config();

const { load, ConfigError } = require('../src/config/env');
const db = require('../src/services/db');
const Session = require('../src/models/Session');
const extractor = require('../src/services/extractor');
const stages = require('../src/services/stages');
const guardian = require('../src/agents/guardian');
const intelligence = require('../src/agents/intelligence');
const logger = require('../src/services/logger');

const DAY = 24 * 60 * 60 * 1000;

/**
 * Five past incidents. Each is a list of caller lines with the decoy's replies,
 * so the transcript reads like a real one.
 */
const SEEDS = [
    {
        sessionId: 'seed-digital-arrest-pune',
        userId: 'demo-user',
        userAlias: 'Protected User A1',
        channel: 'Call',
        language: 'English',
        daysAgo: 9,
        turns: [
            ['scammer', 'Madam, this is Inspector Deshmukh from CBI Pune. A parcel in your name was seized with narcotics at the airport.'],
            ['decoy', 'Arre beta, what parcel? I have not sent anything anywhere.'],
            ['scammer', 'A non-bailable warrant is ready. Do not tell anyone and do not disconnect this call.'],
            ['decoy', 'My spectacles are not here, everything is blurry. Please tell me slowly, what should I do?'],
            ['scammer', 'Transfer Rs 2,50,000 to the RBI verification account 50100234567890, IFSC SBIN0001234. It is fully refundable.'],
            ['decoy', 'Haan ji, my app is asking for a short UPI id, the account number is too long for me.'],
            ['scammer', 'Fine. Send it to cyber.verify@okaxis instead. My officer ID is CBI/INSP/44871.'],
            ['decoy', 'Let me write this in my diary. What is the case number I should write?'],
            ['scammer', 'The case number is MUM/CYB/2026/00891. Hurry, you have only 30 minutes.'],
        ],
    },
    {
        sessionId: 'seed-kyc-block-nashik',
        userId: 'demo-user',
        userAlias: 'Protected User A1',
        channel: 'WhatsApp',
        language: 'Hindi',
        daysAgo: 7,
        from: '+919812345678',
        turns: [
            ['scammer', 'Madam aapka bank account KYC expire ho gaya hai, aaj hi account block ho jayega. Turant OTP bataiye.'],
            ['decoy', 'Arre beta, mujhe OTP kahan milta hai? Mera chashma nahin mil raha.'],
            ['scammer', 'Message mein aaya hoga. Jaldi kijiye, mere paas doosre customer bhi hain.'],
            ['decoy', 'Beta main bahut dheere type karti hoon. Aapka number kya hai, main call kar loon?'],
            ['scammer', 'Mera number 9812345678 hai. Verification charge 4500 rupees kyc.update@ybl par bhejiye.'],
            ['decoy', 'App khul hi nahin raha, screen safed ho gayi. Account number kya hai?'],
            ['scammer', 'Account 60200345678901 hai, IFSC HDFC0000123. Mera naam Suresh Patil hai, verification officer.'],
        ],
    },
    {
        sessionId: 'seed-parcel-customs-pune',
        userId: 'demo-user-2',
        userAlias: 'Protected User B7',
        channel: 'Call',
        language: 'English',
        daysAgo: 5,
        turns: [
            ['scammer', 'Madam, this is FedEx customs department. Your parcel has been seized, it contained illegal items.'],
            ['decoy', 'Arre, I have not ordered any parcel beta. My son sends me things sometimes.'],
            ['scammer', 'The customs officer will call you. Do not inform your family about this case, stay on the line.'],
            ['decoy', 'The line went quiet, I missed what you said. Who is calling me?'],
            ['scammer', 'Pay the clearance fee of 18500 immediately to cyber.verify@okaxis to release the parcel.'],
            ['decoy', 'My son will ask me which office this is. What is the address, beta?'],
            ['scammer', 'Our office is at the second floor, Mangal Bhavan, FC Road, Pune 411004. Pay now or you will be arrested.'],
        ],
    },
    {
        sessionId: 'seed-investment-tip',
        userId: 'demo-user-2',
        userAlias: 'Protected User B7',
        channel: 'WhatsApp',
        language: 'Hindi',
        daysAgo: 3,
        turns: [
            ['scammer', 'Madam ji, guaranteed investment tip, 300 percent return in 30 days. Aaj hi paisa bhejiye.'],
            ['decoy', 'Arre beta, itna paisa mere paas kahan hai. Kitna lagana padega?'],
            ['scammer', 'Registration fee sirf 1500 rupees hai. Paisa profit.capital@paytm par bhejiye.'],
            ['decoy', 'Rahul doosri line par call kar raha hai. Account number kya hai?'],
            ['scammer', 'Account number 70300456789012 hai, IFSC ICIC0001234. Mera naam Amit Sharma hai.'],
            ['decoy', 'Main diary mein likh loon. Aapka reference number kya hai?'],
            ['scammer', 'Aapka registration reference REF-55120 hai. Jaldi kijiye, offer aaj tak hai.'],
        ],
    },
    {
        sessionId: 'seed-loan-recovery',
        userId: 'demo-user',
        userAlias: 'Protected User A1',
        channel: 'Call',
        language: 'Marathi',
        daysAgo: 1,
        from: '+919812345678',
        turns: [
            ['scammer', 'Madam, mi loan recovery agent bolat aahe. Tumcha instant loan EMI pending aahe.'],
            ['decoy', 'Arre bala, mi kuthlahi loan ghetla nahi. Kay sangtaay tumhi?'],
            ['scammer', 'Tumchya Aadhaar var loan sanction zala aahe. Konalahi sangu naka, ataach settlement kara.'],
            ['decoy', 'Majha chashma sapadat nahi. Kiti paise bharaiche aahet?'],
            ['scammer', 'Settlement amount 35000 aahe. Majha number 9812345678 aahe, lavkar kara nahitar recovery agent gharee yeil.'],
            ['decoy', 'App ughadat nahi, screen pandhra zala. Khate kramank kay aahe?'],
            ['scammer', 'Khatyat 80400567890123 jama kara, IFSC UTIB0001234. Udya paryant vel aahe.'],
        ],
    },
];

/** Builds one session document by running the real extractor over the transcript. */
const buildSession = async (seed) => {
    const startedAt = new Date(Date.now() - seed.daysAgo * DAY);

    const session = new Session({
        sessionId: seed.sessionId,
        userId: seed.userId,
        userAlias: seed.userAlias,
        counterpartId: seed.from || null,
        channel: seed.channel,
        language: seed.language,
        locale: 'IN',
        firstSeenAt: startedAt,
        lastSeenAt: startedAt,
        guardianState: guardian.STATES.ENDED,
        scamDetected: true,
        seeded: true,
        seedNote: 'Synthetic session, created by scripts/seed-demo.js so the network view '
            + 'is not empty in a demo. The transcript is invented; the identifiers, stage '
            + 'tags and provenance in it were produced by the real extractor.',
    });

    let clock = startedAt.getTime();

    for (const [role, text] of seed.turns) {
        // A plausible gap between messages, so the duration is a real span.
        clock += 20000 + Math.floor(Math.random() * 40000);
        const at = new Date(clock);
        const messageId = session.nextMessageId();

        session.messages.push({ messageId, role, text, ts: null, receivedAt: at });
        session.messageCount += 1;
        if (role === 'scammer') session.scammerMessageCount += 1;
        if (role === 'decoy') session.decoyMessageCount += 1;
        session.lastSeenAt = at;

        if (role !== 'scammer') continue;

        const entities = extractor.extractEntities(text, { sessionId: seed.sessionId, messageId, timestamp: at });
        extractor.mergeInto(session, entities);

        const tagged = stages.tagWithRules(text);
        session.messages[session.messages.length - 1].stages = tagged;

        // Score it the way the Guardian would, so the decision log is real.
        const priorTexts = session.messages
            .filter((m) => m.role === 'scammer')
            .slice(0, -1)
            .map((m) => m.text);

        const scored = guardian.scoreMessage({
            text: [...priorTexts, text].join('\n'),
            entities: session.entities,
            scriptStages: tagged.map((t) => t.stage),
            knownContact: undefined,
        });

        session.guardianLog.push({
            at,
            messageId,
            score: scored.score,
            state: guardian.STATES.DECOY_ACTIVE,
            previousState: guardian.STATES.DECOY_ACTIVE,
            stateChanged: false,
            firedSignals: scored.fired,
            hardSignals: scored.hardSignals,
            classifierLabel: 'unavailable',
            classifierReasons: [],
            notes: ['Seeded session; scored by the rule layer only.'],
            decisionMs: 0,
        });

        session.score = scored.score;
        session.scoreBreakdown = scored.breakdown;
        session.firedSignals = scored.fired;
    }

    // Stage roll-up and classification, as the pipeline does it.
    const seen = new Set();
    for (const message of session.messages) {
        for (const tag of message.stages || []) seen.add(tag.stage);
    }
    session.scriptStages = stages.STAGES.filter((stage) => seen.has(stage));

    const counterpartText = session.messages.filter((m) => m.role === 'scammer').map((m) => m.text).join('\n');
    const scamType = guardian.classifyScamType(counterpartText);
    if (scamType !== 'unknown') session.scamType = scamType;

    session.agentNotes = intelligence.buildAgentNotes(session);
    session.takeoverAt = session.messages[1] ? session.messages[1].receivedAt : startedAt;
    session.handoffAtMessage = 1;

    return session;
};

const run = async () => {
    let config;
    try {
        config = load();
    } catch (error) {
        if (error instanceof ConfigError) {
            console.error(`\nConfiguration error: ${error.message}\n`);
            process.exit(1);
        }
        throw error;
    }

    await db.connect(config);

    const ids = SEEDS.map((s) => s.sessionId);
    const removed = await Session.deleteMany({ sessionId: { $in: ids } });
    if (removed.deletedCount > 0) logger.info(`Replaced ${removed.deletedCount} existing seeded session(s).`);

    for (const seed of SEEDS) {
        const session = await buildSession(seed);
        await session.save();

        const intel = session.intelligence;
        const found = ['upiIds', 'bankAccounts', 'phoneNumbers', 'ifscCodes']
            .flatMap((field) => intel[field] || []);

        console.log(`  ${seed.sessionId.padEnd(30)} ${String(session.score).padStart(3)}  ${session.scamType.padEnd(18)} ${found.length} identifier(s)`);
    }

    const network = require('../src/services/network');
    const graph = await network.build();

    console.log(`\n  ${graph.stats.sessions} sessions, ${graph.stats.identifiers} identifiers, `
        + `${graph.stats.sharedIdentifiers} shared across sessions, ${graph.stats.clusters} cluster(s)\n`);

    for (const cluster of graph.clusters) {
        console.log(`  ${cluster.clusterId}: ${cluster.sessionCount} sessions linked by`);
        for (const link of cluster.linkedBy) {
            console.log(`     ${link.label} ${link.value}  (in ${link.sessionCount} sessions)`);
        }
    }

    console.log('');
    await db.disconnect();
};

if (require.main === module) {
    run().catch((error) => {
        logger.error(`Seeding failed: ${error.stack || error.message}`);
        process.exit(1);
    });
}

module.exports = { SEEDS, buildSession };
