const mongoose = require('mongoose');
const logger = require('../utils/logger');

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI, {
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
            maxPoolSize: 50 // Handle parallel requests
        });
        logger.info(`✅ MongoDB Connected`);
    } catch (error) {
        logger.error(`❌ DB Connection Error: ${error.message}`);
        // Do not exit; allow server to try handling requests via memory cache if possible
    }
};

module.exports = connectDB;