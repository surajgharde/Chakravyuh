const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

// LOG_LEVEL is read directly rather than through config/env.js: the logger is
// imported by the config loader's own dependents and must never fail to load.
const threshold = () => LEVELS[(process.env.LOG_LEVEL || 'info').trim()] ?? LEVELS.info;

const emit = (level, stream, msg) => {
    if (threshold() < LEVELS[level]) return;
    stream(`[${level.toUpperCase()}] ${new Date().toISOString()} - ${msg}`);
};

module.exports = {
    info: (msg) => emit('info', console.log, msg),
    warn: (msg) => emit('warn', console.warn, msg),
    error: (msg) => emit('error', console.error, msg),
    debug: (msg) => emit('debug', console.log, msg),
};
