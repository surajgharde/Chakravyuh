require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const apiRoutes = require('./routes/apiRoutes');
const logger = require('./utils/logger');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');

const app = express();
const PORT = process.env.PORT || 8080;

// 1. Enable CORS
app.use(cors());
app.use(express.json());

// 2. Database
connectDB();

// 3. Swagger Configuration
const swaggerOptions = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'Honeypot AI Server',
            version: '1.0.0',
            description: 'API Documentation for the Honeypot AI System',
        },
        // Use relative path "/" for compatibility
        servers: [
            { url: "/" } 
        ],
        components: {
            securitySchemes: {
                ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key' }
            }
        },
        security: [{ ApiKeyAuth: [] }]
    },
    apis: ['./routes/*.js', './server.js'],
};
const swaggerDocs = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));

// 4. Security Middleware
app.use((req, res, next) => {
    // Allow Health Check & Docs
    if (req.path === '/health' || req.path.startsWith('/api-docs')) {
        return next();
    }
    const authKey = req.headers['x-api-key'];
    if (authKey !== process.env.API_SECRET_KEY) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    next();
});

// 5. Routes
app.use('/api', apiRoutes);

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health check endpoint
 *     tags: [System]
 *     responses:
 *       200:
 *         description: Server is running
 */
app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, () => {
    logger.info(`🚀 Honeypot Active on port ${PORT}`);
});