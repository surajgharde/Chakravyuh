/**
 * Cross-session identifier linking.
 *
 * One scam call is an incident. The same UPI id turning up in two unrelated
 * calls is an operation, and that is the thing worth reporting. This builds a
 * graph over every normalised identifier the extractor has ever recorded and
 * flags the clusters where one is shared.
 *
 * Nodes are identifiers and sessions. Edges are "this identifier was seen in
 * this session" and "these two identifiers were seen together". Clusters are
 * connected components that contain at least one identifier appearing in two
 * or more sessions.
 */

const Session = require('../models/Session');

/**
 * Identifier types that can link two sessions.
 *
 * Deliberately narrow. An impersonated authority ("CBI") or a quoted case
 * number is not a link: half the digital-arrest calls in India say CBI, and
 * clustering on that would merge every unrelated session into one blob.
 */
const LINKING_TYPES = [
    'upiId',
    'bankAccount',
    'ifsc',
    'phone',
    'cryptoWallet',
    'url',
    'apkLink',
    'email',
];

/** How many sessions an identifier must appear in before it is a link. */
const SHARED_THRESHOLD = 2;

const TYPE_LABELS = {
    phone: 'Phone',
    upiId: 'UPI ID',
    bankAccount: 'Bank account',
    ifsc: 'IFSC',
    cryptoWallet: 'Crypto wallet',
    url: 'Link',
    apkLink: 'APK link',
    email: 'Email',
};

const identifierNodeId = (type, value) => `id:${type}:${value}`;
const sessionNodeId = (sessionId) => `session:${sessionId}`;

/**
 * Builds the graph from a list of sessions.
 *
 * Kept separate from the database read so it can be tested against plain
 * objects with no Mongo running.
 *
 * @param {object[]} sessions
 * @returns {object} { nodes, edges, clusters, stats }
 */
const buildGraph = (sessions = []) => {
    /** identifier node id -> { type, value, sessions:Set, occurrences, firstSeenAt } */
    const identifiers = new Map();
    /** session id -> summary */
    const sessionNodes = new Map();

    for (const session of sessions) {
        const entities = (session.entities || []).filter((e) => LINKING_TYPES.includes(e.type));

        sessionNodes.set(session.sessionId, {
            id: sessionNodeId(session.sessionId),
            kind: 'session',
            sessionId: session.sessionId,
            label: session.sessionId,
            state: session.guardianState,
            scamType: session.scamType || 'unknown',
            channel: session.channel || 'unknown',
            startedAt: session.firstSeenAt ? new Date(session.firstSeenAt).toISOString() : null,
            score: session.score ?? 0,
            identifierCount: entities.length,
        });

        for (const entity of entities) {
            const nodeId = identifierNodeId(entity.type, entity.normalized);
            if (!identifiers.has(nodeId)) {
                identifiers.set(nodeId, {
                    id: nodeId,
                    kind: 'identifier',
                    type: entity.type,
                    label: TYPE_LABELS[entity.type] || entity.type,
                    value: entity.normalized,
                    sessions: new Set(),
                    occurrences: 0,
                    firstSeenAt: entity.timestamp ? new Date(entity.timestamp).toISOString() : null,
                });
            }

            const node = identifiers.get(nodeId);
            node.sessions.add(session.sessionId);
            node.occurrences += entity.occurrences || 1;

            const seenAt = entity.timestamp ? new Date(entity.timestamp).toISOString() : null;
            if (seenAt && (!node.firstSeenAt || seenAt < node.firstSeenAt)) node.firstSeenAt = seenAt;
        }
    }

    // --- edges ------------------------------------------------------------
    const edges = [];

    // identifier -> session
    for (const node of identifiers.values()) {
        for (const sessionId of node.sessions) {
            edges.push({
                id: `${node.id}--${sessionNodeId(sessionId)}`,
                kind: 'seen_in',
                from: node.id,
                to: sessionNodeId(sessionId),
            });
        }
    }

    // identifier <-> identifier, when they turned up in the same session
    const coOccurrence = new Map();
    for (const session of sessions) {
        const inSession = (session.entities || [])
            .filter((e) => LINKING_TYPES.includes(e.type))
            .map((e) => identifierNodeId(e.type, e.normalized));

        const unique = [...new Set(inSession)].sort();
        for (let i = 0; i < unique.length; i += 1) {
            for (let j = i + 1; j < unique.length; j += 1) {
                const key = `${unique[i]}--${unique[j]}`;
                if (!coOccurrence.has(key)) {
                    coOccurrence.set(key, { from: unique[i], to: unique[j], sessions: new Set() });
                }
                coOccurrence.get(key).sessions.add(session.sessionId);
            }
        }
    }

    for (const [key, link] of coOccurrence) {
        edges.push({
            id: key,
            kind: 'seen_together',
            from: link.from,
            to: link.to,
            sessionCount: link.sessions.size,
            sessions: [...link.sessions],
        });
    }

    // --- nodes ------------------------------------------------------------
    const identifierNodes = [...identifiers.values()].map((node) => ({
        id: node.id,
        kind: node.kind,
        type: node.type,
        label: node.label,
        value: node.value,
        sessionCount: node.sessions.size,
        sessions: [...node.sessions],
        occurrences: node.occurrences,
        firstSeenAt: node.firstSeenAt,
        // This is the flag that matters: the same payment route in two
        // different conversations is one operation, not two incidents.
        shared: node.sessions.size >= SHARED_THRESHOLD,
    }));

    const nodes = [...identifierNodes, ...sessionNodes.values()];

    // --- clusters ---------------------------------------------------------
    const clusters = findClusters(identifierNodes, coOccurrence);

    return {
        nodes,
        edges,
        clusters,
        stats: {
            sessions: sessionNodes.size,
            identifiers: identifierNodes.length,
            sharedIdentifiers: identifierNodes.filter((n) => n.shared).length,
            clusters: clusters.length,
            linkingTypes: LINKING_TYPES,
            sharedThreshold: SHARED_THRESHOLD,
        },
    };
};

/**
 * Connected components over the identifier graph, keeping only those that hold
 * at least one shared identifier.
 *
 * Union-find rather than a recursive walk: a demo graph is small, but a real one
 * is not, and a stack overflow in the middle of a report is not a good look.
 */
const findClusters = (identifierNodes, coOccurrence) => {
    const parent = new Map();
    for (const node of identifierNodes) parent.set(node.id, node.id);

    const find = (id) => {
        let root = id;
        while (parent.get(root) !== root) root = parent.get(root);
        // Path compression.
        let walk = id;
        while (parent.get(walk) !== root) {
            const next = parent.get(walk);
            parent.set(walk, root);
            walk = next;
        }
        return root;
    };

    const union = (a, b) => {
        const rootA = find(a);
        const rootB = find(b);
        if (rootA !== rootB) parent.set(rootA, rootB);
    };

    // Two identifiers seen in the same session belong together...
    for (const link of coOccurrence.values()) union(link.from, link.to);

    // ...and so do two identifiers that share a session even without a direct
    // co-occurrence edge, which is what happens when a session has exactly one.
    const bySession = new Map();
    for (const node of identifierNodes) {
        for (const sessionId of node.sessions) {
            if (!bySession.has(sessionId)) bySession.set(sessionId, []);
            bySession.get(sessionId).push(node.id);
        }
    }
    for (const ids of bySession.values()) {
        for (let i = 1; i < ids.length; i += 1) union(ids[0], ids[i]);
    }

    // A shared identifier also joins the sessions it appears in, transitively:
    // two sessions linked by one UPI id are one cluster.
    const groups = new Map();
    for (const node of identifierNodes) {
        const root = find(node.id);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(node);
    }

    const clusters = [];
    let index = 0;

    for (const members of groups.values()) {
        const shared = members.filter((m) => m.shared);
        if (shared.length === 0) continue; // a single incident, not a network

        const sessionIds = [...new Set(members.flatMap((m) => m.sessions))];
        index += 1;

        clusters.push({
            clusterId: `cluster-${index}`,
            sessionCount: sessionIds.length,
            sessions: sessionIds,
            identifierCount: members.length,
            // What links them, which is what a report should lead with.
            linkedBy: shared.map((m) => ({
                type: m.type,
                label: m.label,
                value: m.value,
                sessionCount: m.sessionCount,
                sessions: m.sessions,
            })),
            identifiers: members.map((m) => ({ type: m.type, value: m.value, sessionCount: m.sessionCount })),
            note: `${shared.length} identifier(s) appear in ${sessionIds.length} separate sessions.`,
        });
    }

    return clusters.sort((a, b) => b.sessionCount - a.sessionCount);
};

/** Builds the graph from everything in the database. */
const build = async ({ userId = null, limit = 500 } = {}) => {
    const filter = userId ? { userId } : {};
    const sessions = await Session.find(filter, 'sessionId entities guardianState scamType channel firstSeenAt score userId')
        .sort({ firstSeenAt: 1 })
        .limit(limit);

    return buildGraph(sessions);
};

module.exports = { build, buildGraph, findClusters, LINKING_TYPES, SHARED_THRESHOLD, TYPE_LABELS };
