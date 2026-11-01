#!/usr/bin/env node
/**
 * The red-team suite against the real model.
 *
 *   npm run redteam:live
 *
 * The offline suite (test/redteam.test.js) runs the same 44 cases against a
 * deliberately hostile stub, which proves the guard catches a model that
 * misbehaves. This proves the rest of it: that the real model, with the real
 * prompt, does not produce the thing in the first place — and that when it
 * does, the guard still catches it.
 *
 * Both have to exist. A stub cannot tell you whether the prompt works, and the
 * real model cannot be made to misbehave on demand, so neither run alone is
 * evidence of much.
 *
 * It needs LLM_API_KEY and it costs real tokens: 44 cases, two or three model
 * calls each. It is a script rather than a test for exactly that reason —
 * `npm test` must stay free, offline and reproducible.
 *
 * Exits non-zero if any case fails, so CI can run it on a schedule.
 */

require('dotenv').config();

const mongoose = require('mongoose');
const { load, ConfigError } = require('../src/config/env');
const { LlmClient } = require('../src/llm/client');
const { CASES } = require('../test/fixtures/redteam');
const { runCase, printTable } = require('../test/redteam-runner');
const logger = require('../src/services/logger');

/** Sessions from the live run go in their own database and are dropped after. */
const LIVE_DB = 'chakravyuh_redteam_live';

const main = async () => {
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

    const llm = new LlmClient(config.llm);

    if (!llm.configured) {
        console.error('\n  LLM_API_KEY is not set, so there is no real model to test against.');
        console.error('  The offline suite covers the guard: npm test -- test/redteam.test.js\n');
        process.exit(1);
    }

    // One cheap call first. Failing 44 cases one at a time against a dead key
    // wastes several minutes to learn something one request can tell you.
    try {
        await llm.completeJson({
            messages: [
                { role: 'system', content: 'Reply with the JSON {"ok":true} and nothing else.' },
                { role: 'user', content: 'ping' },
            ],
            temperature: 0,
            maxTokens: 20,
        });
    } catch (error) {
        console.error(`\n  The model is not reachable (${error.code}): ${error.message}`);
        console.error('  Nothing was run.\n');
        process.exit(1);
    }

    // The in-process MongoDB is not used here: a live run is slow enough that
    // starting a database for it is the wrong trade. An external MONGO_URI is
    // used if there is one, and otherwise an in-process instance is started.
    let memoryServer = null;
    let uri = config.mongoUri;

    if (!uri) {
        const { MongoMemoryServer } = require('mongodb-memory-server');
        memoryServer = await MongoMemoryServer.create();
        uri = memoryServer.getUri();
    } else {
        // Never run against the real session database: this creates 44
        // sessions and then deletes them.
        uri = uri.replace(/\/[^/?]*(\?|$)/, `/${LIVE_DB}$1`);
    }

    await mongoose.connect(uri);

    // The typing delay is cosmetic and would add minutes across 44 cases.
    const deps = { llm, config: { ...config, demoMode: true }, events: null };

    console.log(`\n  Running ${CASES.length} red-team cases against ${config.llm.model}.`);
    console.log('  This makes real model calls and costs real tokens.\n');

    const results = [];
    for (const [index, testCase] of CASES.entries()) {
        process.stdout.write(`  [${String(index + 1).padStart(2)}/${CASES.length}] ${testCase.id}... `);
        const result = await runCase(testCase, deps, { sessionPrefix: 'rt-live' });
        results.push(result);
        process.stdout.write(`${result.pass ? 'pass' : 'FAIL'} (${result.ms}ms)\n`);
    }

    const summary = printTable(results, {
        title: 'RED-TEAM SUITE',
        model: `real model: ${config.llm.model}`,
    });

    // How often the real model needed catching. This is the number worth
    // watching over time: it is the distance between what the prompt asks for
    // and what the guard has to enforce.
    const needingTheGuard = results.filter((r) => r.observed && r.observed.guardBlocks.length > 0);
    console.log(`  cases where the real model had to be caught  ${needingTheGuard.length}/${results.length}`);
    for (const result of needingTheGuard) {
        // The blocks collected by the runner are the pipeline's shape, which
        // names the rules in `ruleIds`.
        const rules = [...new Set(result.observed.guardBlocks.flatMap((b) => b.ruleIds || []))];
        console.log(`    ${result.id.padEnd(34)} ${rules.join(', ')}`);
    }
    console.log('');

    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    if (memoryServer) await memoryServer.stop();

    if (summary.passed !== summary.total) {
        console.error(`  ${summary.total - summary.passed} case(s) failed against the real model.\n`);
        process.exit(1);
    }
    if (summary.engagedLegit > 0) {
        console.error('  A legitimate caller was baited. This is the one outcome the system must never produce.\n');
        process.exit(1);
    }

    console.log('  All cases passed against the real model.\n');
};

main().catch((error) => {
    logger.error(`Red-team live run failed: ${error.stack || error.message}`);
    process.exit(1);
});
