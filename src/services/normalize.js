/**
 * Every inbound transcript is converted to one internal shape:
 *
 *   { role: 'scammer' | 'decoy' | 'guardian' | 'user', text: string, ts: number|null }
 *
 * Two external shapes are accepted, because the problem statement and the
 * original README disagreed:
 *
 *   { sender, text, timestamp }  - platform/transcript form; `sender` names the
 *                                  real-world speaker, so sender:'user' is the
 *                                  person being protected.
 *   { role, content }            - OpenAI chat form; `role` is a chat position,
 *                                  so role:'user' is our counterparty, i.e. the
 *                                  scammer, and role:'assistant' is our decoy.
 *
 * `ts` is null when the caller supplied no timestamp. It is never back-filled
 * with a guess: duration is measured from server receive times instead.
 */

const INTERNAL_ROLES = ['scammer', 'decoy', 'guardian', 'user'];

// `sender` describes who really spoke.
const SENDER_ROLES = {
    scammer: 'scammer',
    attacker: 'scammer',
    caller: 'scammer',
    fraudster: 'scammer',
    user: 'user',
    victim: 'user',
    owner: 'user',
    decoy: 'decoy',
    agent: 'decoy',
    bot: 'decoy',
    honeypot: 'decoy',
    assistant: 'decoy',
    guardian: 'guardian',
    system: 'guardian',
};

// `role` describes a chat position relative to us.
const CHAT_ROLES = {
    user: 'scammer',
    assistant: 'decoy',
    system: 'guardian',
    tool: 'guardian',
    function: 'guardian',
};

/**
 * Accepts epoch milliseconds (number or numeric string) or an ISO date string.
 * Returns null for anything unparseable rather than inventing a time.
 */
const normalizeTimestamp = (value) => {
    if (value === null || value === undefined || value === '') return null;

    if (typeof value === 'number') return Number.isFinite(value) ? value : null;

    if (value instanceof Date) {
        const ms = value.getTime();
        return Number.isNaN(ms) ? null : ms;
    }

    const raw = String(value).trim();
    if (raw === '') return null;

    if (/^\d+$/.test(raw)) {
        const epoch = Number.parseInt(raw, 10);
        return Number.isFinite(epoch) ? epoch : null;
    }

    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? null : parsed;
};

/**
 * Normalizes one message. Returns null when there is no usable text,
 * so callers can filter without extra guards.
 */
const normalizeMessage = (raw, { defaultRole = 'scammer' } = {}) => {
    if (!raw || typeof raw !== 'object') {
        if (typeof raw === 'string' && raw.trim() !== '') {
            return { role: defaultRole, text: raw.trim(), ts: null };
        }
        return null;
    }

    const text = typeof raw.text === 'string' && raw.text.trim() !== ''
        ? raw.text.trim()
        : typeof raw.content === 'string' ? raw.content.trim() : '';

    if (text === '') return null;

    let role;
    const sender = typeof raw.sender === 'string' ? raw.sender.trim().toLowerCase() : '';
    const chatRole = typeof raw.role === 'string' ? raw.role.trim().toLowerCase() : '';

    if (sender) {
        // `sender` wins: it is the more specific, real-world label.
        role = SENDER_ROLES[sender] ?? defaultRole;
    } else if (chatRole) {
        // CHAT_ROLES is consulted first on purpose: 'user' is a valid internal
        // role too, but in the chat shape it means our counterparty.
        role = CHAT_ROLES[chatRole] ?? (INTERNAL_ROLES.includes(chatRole) ? chatRole : defaultRole);
    } else {
        role = defaultRole;
    }

    return { role, text, ts: normalizeTimestamp(raw.timestamp ?? raw.ts ?? raw.time) };
};

/** Normalizes a whole conversationHistory array, dropping unusable entries. */
const normalizeHistory = (history) => {
    if (!Array.isArray(history)) return [];
    return history.map((msg) => normalizeMessage(msg)).filter(Boolean);
};

/**
 * Maps internal messages onto OpenAI chat roles for a prompt.
 * The scammer is our counterparty ('user'); our decoy is 'assistant'.
 */
const toChatMessages = (messages) => messages
    .filter((m) => m.role === 'scammer' || m.role === 'decoy')
    .map((m) => ({ role: m.role === 'decoy' ? 'assistant' : 'user', content: m.text }));

module.exports = {
    INTERNAL_ROLES,
    normalizeMessage,
    normalizeHistory,
    normalizeTimestamp,
    toChatMessages,
};
