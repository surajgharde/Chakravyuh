const info = (msg) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`);
const warn = (msg) => console.warn(`[WARN] ${new Date().toISOString()} - ${msg}`);
const error = (msg) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`);

module.exports = { info, warn, error };