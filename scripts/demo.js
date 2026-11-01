#!/usr/bin/env node
/**
 * `npm run demo` — seed the database, then start the server.
 *
 * One command, because a demo should not need two terminals and a remembered
 * order. The seeding runs first and the server starts in the same process on
 * the same connection, so there is no window where the console is up but the
 * network graph is empty.
 *
 * It is `npm start` with a seed in front of it. Anything that would stop the
 * server stops here too and for the same reason; nothing is retried or
 * swallowed to make a demo look like it worked.
 */

require('dotenv').config();

const logger = require('../src/services/logger');

const main = async () => {
    const { run: seed } = require('./seed-demo');

    // keepConnection: the server is about to use this same connection, so it
    // is handed over rather than torn down and rebuilt a moment later.
    await seed({ keepConnection: true });

    // start() validates the config again, which is cheap and keeps the two
    // entry points honest: `npm run demo` must fail in exactly the places
    // `npm start` fails.
    const { start } = require('../server');
    await start({ skipDbConnect: true });
};

main().catch((error) => {
    logger.error(`Demo startup failed: ${error.stack || error.message}`);
    process.exit(1);
});
