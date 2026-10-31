/**
 * The per-session facts ledger.
 *
 * A decoy that contradicts itself is the fastest way to be found out: a scammer
 * who hears "my son Rahul in Bengaluru" and then "my son Amit in Mumbai" hangs
 * up. So every claim the persona makes is written down, injected into the next
 * prompt, and each draft reply is checked against it before it is sent.
 *
 * The check is deterministic rather than another model call. Facts live in
 * named slots, each slot has a reader that pulls its value out of free text,
 * and a draft that fills a slot with a value different from the one on record
 * is a contradiction. That makes it testable, instant, and free.
 */

const SLOTS = {
    own_name: {
        label: 'her own name',
        read: (text) => {
            const match = text.match(/\b(?:my name is|i am|this is|mi|माझे नाव)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/);
            return match ? match[1].trim() : null;
        },
    },
    own_age: {
        label: 'her age',
        read: (text) => {
            const match = text.match(/\b(?:i am|i'm|me|मी)\s+(\d{2})\s*(?:years|year|varsh|वर्ष|saal|साल)/i)
                || text.match(/\b(\d{2})\s*(?:years old|varshachi|वर्षांची)/i);
            return match ? match[1] : null;
        },
    },
    own_city: {
        label: 'the city she lives in',
        read: (text) => {
            const match = text.match(/\b(?:i (?:live|stay) in|i am from|from|मी)\s+(Pune|Mumbai|Nagpur|Nashik|Delhi|Bengaluru|Bangalore|Thane|Kolhapur|Solapur|पुणे|मुंबई|नागपूर)\b/i);
            return match ? normalizePlace(match[1]) : null;
        },
    },
    own_locality: {
        label: 'her locality',
        read: (text) => {
            const match = text.match(/\b(Kothrud|Kothrud|Kothrood|Aundh|Deccan|Karve\s*Nagar|Baner|Hadapsar|Shivajinagar|कोथरूड)\b/i);
            return match ? normalizePlace(match[1]) : null;
        },
    },
    own_occupation: {
        label: 'what she used to do',
        read: (text) => {
            if (/\b(?:marathi\s+teacher|teacher of marathi|shikshika|शिक्षिका|मराठी\s*शिक्षक)/i.test(text)) return 'retired Marathi teacher';
            const match = text.match(/\bi (?:was|used to be) (?:a |an )?([a-z]{4,20}(?:\s+[a-z]{4,20})?)\b/i);
            return match ? match[1].toLowerCase().trim() : null;
        },
    },
    husband_status: {
        label: 'her husband',
        read: (text) => {
            if (/\b(?:my )?husband\b[^.?!]{0,40}\b(?:passed away|expired|no more|died|gone|नाही|वारले)/i.test(text)) return 'passed away';
            if (/\b(?:my )?husband\b[^.?!]{0,40}\b(?:will|is|can|has|does|comes|सांगतील|आहेत)\b/i.test(text)) return 'alive';
            return null;
        },
    },
    son_name: {
        label: "her son's name",
        read: (text) => {
            const match = text.match(/\b(?:son|mulga|मुलगा|बेटा)\b[^.?!]{0,20}?\b([A-Z][a-z]{2,15})\b/)
                || text.match(/\b([A-Z][a-z]{2,15})\b[^.?!]{0,15}\b(?:my son|mera beta|माझा मुलगा)/);
            return match ? match[1] : null;
        },
    },
    son_city: {
        label: 'where her son lives',
        read: (text) => {
            const match = text.match(/\bson\b[^.?!]{0,60}?\b(?:in|at|from)\s+(Bengaluru|Bangalore|Mumbai|Pune|Delhi|Hyderabad|Chennai|Dubai|बेंगळुरू|मुंबई)\b/i);
            return match ? normalizePlace(match[1]) : null;
        },
    },
    lives_with: {
        label: 'who she lives with',
        read: (text) => {
            if (/\b(?:i (?:live|stay) alone|alone (?:here|at home)|एकटी)\b/i.test(text)) return 'alone';
            if (/\bi (?:live|stay) with (?:my )?([a-z]{3,15})\b/i.test(text)) {
                return text.match(/\bi (?:live|stay) with (?:my )?([a-z]{3,15})\b/i)[1].toLowerCase();
            }
            return null;
        },
    },
    bank_reference: {
        label: 'which bank is hers',
        read: (text) => {
            // Naming a real bank is itself the problem, so any named bank is
            // recorded as such and will clash with the seeded reference.
            const named = text.match(/\b(SBI|State Bank|HDFC|ICICI|Axis|Kotak|PNB|Punjab National|Bank of Baroda|Canara|Union Bank|Yes Bank|IDFC)\b/i);
            if (named) return `named:${named[1].toLowerCase()}`;
            if (/\bkarve\s*road\b/i.test(text)) return 'the branch near Karve Road';
            return null;
        },
    },
};

const PLACES = {
    bangalore: 'Bengaluru',
    bengaluru: 'Bengaluru',
    बेंगळुरू: 'Bengaluru',
    पुणे: 'Pune',
    मुंबई: 'Mumbai',
    कोथरूड: 'Kothrud',
    kothrood: 'Kothrud',
};

function normalizePlace(value) {
    const key = String(value).trim().toLowerCase().replace(/\s+/g, ' ');
    if (PLACES[key]) return PLACES[key];
    return String(value).trim().replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Builds the opening ledger from the persona file. */
const seed = (persona) => (persona.ledgerSeed || []).map((entry) => ({
    slot: entry.slot,
    value: entry.value,
    source: 'persona',
    turn: 0,
    messageId: null,
    statedAt: new Date(),
}));

/** The current value of each slot, newest claim winning. */
const currentValues = (ledger = []) => {
    const values = new Map();
    for (const entry of ledger) {
        if (entry && entry.slot) values.set(entry.slot, entry.value);
    }
    return values;
};

/**
 * Compares a draft reply against the ledger.
 *
 * @returns {{ok: boolean, conflicts: object[], newClaims: object[]}}
 */
const check = (draft, ledger = []) => {
    const text = String(draft || '');
    const known = currentValues(ledger);

    const conflicts = [];
    const newClaims = [];

    for (const [slot, definition] of Object.entries(SLOTS)) {
        let found = null;
        try {
            found = definition.read(text);
        } catch {
            found = null;
        }
        if (!found) continue;

        const existing = known.get(slot);
        if (existing === undefined) {
            newClaims.push({ slot, value: found });
            continue;
        }

        if (String(existing).toLowerCase() !== String(found).toLowerCase()) {
            conflicts.push({
                slot,
                label: definition.label,
                onRecord: existing,
                inDraft: found,
            });
        }
    }

    return { ok: conflicts.length === 0, conflicts, newClaims };
};

/**
 * Records claims against the ledger. Accepts the model's own ledgerUpdates as
 * well as the slot values read out of the reply, and ignores anything that is
 * not a known slot.
 */
const record = (ledger, claims = [], { turn = 0, messageId = null } = {}) => {
    const known = currentValues(ledger);
    const added = [];

    for (const claim of claims) {
        if (!claim) continue;
        const slot = typeof claim === 'string' ? null : claim.slot;
        const value = typeof claim === 'string' ? claim : claim.value;

        if (!slot || !SLOTS[slot]) continue;
        if (value === undefined || value === null || String(value).trim() === '') continue;
        // An existing slot is not overwritten: the first claim is the truth the
        // persona has to live with from then on.
        if (known.has(slot)) continue;

        const entry = {
            slot,
            value: String(value).trim(),
            source: 'reply',
            turn,
            messageId,
            statedAt: new Date(),
        };
        ledger.push(entry);
        known.set(slot, entry.value);
        added.push(entry);
    }

    return added;
};

/** The ledger rendered for a prompt. */
const forPrompt = (ledger = []) => {
    const values = currentValues(ledger);
    if (values.size === 0) return '(nothing yet)';
    return [...values.entries()]
        .map(([slot, value]) => `- ${slot.replace(/_/g, ' ')}: ${value}`)
        .join('\n');
};

module.exports = { SLOTS, seed, check, record, forPrompt, currentValues, normalizePlace };
