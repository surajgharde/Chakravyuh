/**
 * MongoDB is optional.
 *
 * MONGO_URI set   -> connect to it.
 * MONGO_URI empty -> start an in-process MongoDB (mongodb-memory-server) so the
 *                    demo runs on one laptop with nothing installed. Data is
 *                    discarded when the process exits.
 */

const mongoose = require('mongoose');
const logger = require('./logger');

let memoryServer = null;

const connect = async (config) => {
    let uri = config.mongoUri;

    if (!uri) {
        // Required lazily: the package downloads a MongoDB binary on first use,
        // and a run with a real MONGO_URI should never pay that cost.
        const { MongoMemoryServer } = require('mongodb-memory-server');
        logger.info('MONGO_URI is empty - starting an in-process MongoDB for this run.');
        memoryServer = await MongoMemoryServer.create();
        uri = memoryServer.getUri();
    }

    await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
    });

    logger.info(config.mongoUri ? 'MongoDB connected.' : 'In-process MongoDB ready (data is not persisted).');

    return { uri, ephemeral: !config.mongoUri };
};

const disconnect = async () => {
    await mongoose.disconnect();
    if (memoryServer) {
        await memoryServer.stop();
        memoryServer = null;
    }
};

module.exports = { connect, disconnect };
