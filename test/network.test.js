const test = require('node:test');
const assert = require('node:assert/strict');

const network = require('../src/services/network');
const extractor = require('../src/services/extractor');

// ---------------------------------------------------------------------------
// Session stand-ins, built through the real extractor
// ---------------------------------------------------------------------------

/** Builds a session from caller lines, extracting identifiers as the pipeline does. */
const sessionFrom = (sessionId, lines, overrides = {}) => {
    const session = {
        sessionId,
        userId: 'demo-user',
        guardianState: 'ENDED',
        scamType: 'digital_arrest',
        channel: 'Call',
        firstSeenAt: new Date('2026-10-20T10:00:00.000Z'),
        score: 85,
        entities: [],
        intelligence: extractor.emptySummary(),
        markModified() {},
        ...overrides,
    };

    lines.forEach((text, index) => {
        extractor.mergeInto(session, extractor.extractEntities(text, {
            sessionId,
            messageId: `m${index + 1}`,
            timestamp: new Date(session.firstSeenAt.getTime() + index * 30000),
        }));
    });

    return session;
};

const A = () => sessionFrom('s-a', [
    'Transfer the money to cyber.verify@okaxis immediately.',
    'My number is 9876543210, call back on it.',
]);

const B = () => sessionFrom('s-b', [
    'Pay the clearance fee to cyber.verify@okaxis to release your parcel.',
]);

const C = () => sessionFrom('s-c', [
    'Send it to a totally different handle, unrelated@ybl.',
]);

// ---------------------------------------------------------------------------
// The required case: a shared UPI id makes one cluster
// ---------------------------------------------------------------------------

test('a UPI id shared by two sessions forms one cluster', () => {
    const graph = network.buildGraph([A(), B()]);

    assert.equal(graph.clusters.length, 1, 'one cluster, not two');

    const [cluster] = graph.clusters;
    assert.equal(cluster.sessionCount, 2);
    assert.deepEqual([...cluster.sessions].sort(), ['s-a', 's-b']);

    const linkedBy = cluster.linkedBy;
    assert.equal(linkedBy.length, 1, 'exactly one identifier links them');
    assert.equal(linkedBy[0].type, 'upiId');
    assert.equal(linkedBy[0].value, 'cyber.verify@okaxis');
    assert.equal(linkedBy[0].sessionCount, 2);
    assert.deepEqual([...linkedBy[0].sessions].sort(), ['s-a', 's-b']);
});

test('the shared identifier is flagged shared, the unshared one is not', () => {
    const graph = network.buildGraph([A(), B()]);

    const upi = graph.nodes.find((n) => n.value === 'cyber.verify@okaxis');
    assert.equal(upi.shared, true);
    assert.equal(upi.sessionCount, 2);

    const phone = graph.nodes.find((n) => n.value === '+919876543210');
    assert.equal(phone.shared, false, 'it only appeared in one session');
    assert.equal(phone.sessionCount, 1);
});

test('an unrelated session is not pulled into the cluster', () => {
    const graph = network.buildGraph([A(), B(), C()]);

    assert.equal(graph.clusters.length, 1);
    assert.ok(!graph.clusters[0].sessions.includes('s-c'));

    const unrelated = graph.nodes.find((n) => n.value === 'unrelated@ybl');
    assert.equal(unrelated.shared, false);
});

test('a single session on its own is an incident, not a network', () => {
    const graph = network.buildGraph([A()]);
    assert.equal(graph.clusters.length, 0, 'nothing is shared, so there is nothing to cluster');
    assert.equal(graph.stats.sharedIdentifiers, 0);
});

test('two identifiers each shared across the same pair of sessions make one cluster', () => {
    const graph = network.buildGraph([
        sessionFrom('s-1', ['Pay to mule@okaxis, my number is 9876543210.']),
        sessionFrom('s-2', ['Pay to mule@okaxis, my number is 9876543210.']),
    ]);

    assert.equal(graph.clusters.length, 1);
    assert.equal(graph.clusters[0].sessionCount, 2);
    assert.equal(graph.clusters[0].linkedBy.length, 2, 'both the UPI and the phone link them');
});

test('a chain of sessions links transitively into one cluster', () => {
    // A shares a UPI with B; B shares a phone with C. All three are one network.
    const graph = network.buildGraph([
        sessionFrom('chain-a', ['Pay to shared@okaxis now.']),
        sessionFrom('chain-b', ['Pay to shared@okaxis, or call 9876543210.']),
        sessionFrom('chain-c', ['Call me on 9876543210 immediately.']),
    ]);

    assert.equal(graph.clusters.length, 1);
    assert.deepEqual([...graph.clusters[0].sessions].sort(), ['chain-a', 'chain-b', 'chain-c']);
});

test('two separate operations stay two separate clusters', () => {
    const graph = network.buildGraph([
        sessionFrom('op1-a', ['Pay to first@okaxis.']),
        sessionFrom('op1-b', ['Pay to first@okaxis.']),
        sessionFrom('op2-a', ['Pay to second@ybl.']),
        sessionFrom('op2-b', ['Pay to second@ybl.']),
    ]);

    assert.equal(graph.clusters.length, 2);
    for (const cluster of graph.clusters) assert.equal(cluster.sessionCount, 2);
});

// ---------------------------------------------------------------------------
// Nodes and edges
// ---------------------------------------------------------------------------

test('nodes cover both the identifiers and the sessions', () => {
    const graph = network.buildGraph([A(), B()]);

    const identifiers = graph.nodes.filter((n) => n.kind === 'identifier');
    const sessions = graph.nodes.filter((n) => n.kind === 'session');

    assert.equal(sessions.length, 2);
    assert.equal(identifiers.length, 2, 'one UPI and one phone');
    assert.deepEqual(sessions.map((s) => s.sessionId).sort(), ['s-a', 's-b']);
});

test('a seen_in edge joins each identifier to each session it appeared in', () => {
    const graph = network.buildGraph([A(), B()]);
    const seenIn = graph.edges.filter((e) => e.kind === 'seen_in');

    const upiEdges = seenIn.filter((e) => e.from === 'id:upiId:cyber.verify@okaxis');
    assert.equal(upiEdges.length, 2);
    assert.deepEqual(upiEdges.map((e) => e.to).sort(), ['session:s-a', 'session:s-b']);
});

test('a seen_together edge joins identifiers from the same session', () => {
    const graph = network.buildGraph([A()]);
    const together = graph.edges.filter((e) => e.kind === 'seen_together');

    assert.equal(together.length, 1, 'the UPI and the phone were in the same session');
    assert.equal(together[0].sessionCount, 1);
});

test('every edge points at nodes that exist', () => {
    const graph = network.buildGraph([A(), B(), C()]);
    const ids = new Set(graph.nodes.map((n) => n.id));

    for (const edge of graph.edges) {
        assert.ok(ids.has(edge.from), `edge from a missing node: ${edge.from}`);
        assert.ok(ids.has(edge.to), `edge to a missing node: ${edge.to}`);
    }
});

test('occurrences are summed across sessions', () => {
    const graph = network.buildGraph([
        sessionFrom('rep-1', ['Pay to mule@okaxis.', 'I said mule@okaxis, hurry.']),
        sessionFrom('rep-2', ['Pay to mule@okaxis.']),
    ]);

    const upi = graph.nodes.find((n) => n.value === 'mule@okaxis');
    assert.equal(upi.occurrences, 3, 'twice in one session, once in the other');
});

// ---------------------------------------------------------------------------
// What does and does not count as a link
// ---------------------------------------------------------------------------

test('an impersonated authority does not link sessions', () => {
    // Half the digital-arrest calls in India say CBI. Clustering on that would
    // merge every unrelated session into one blob.
    const graph = network.buildGraph([
        sessionFrom('auth-1', ['Madam this is CBI, a warrant is ready.']),
        sessionFrom('auth-2', ['Madam this is CBI, your parcel was seized.']),
    ]);

    assert.equal(graph.clusters.length, 0);
    assert.ok(!network.LINKING_TYPES.includes('impersonatedAuthority'));
});

test('a quoted case number does not link sessions', () => {
    assert.ok(!network.LINKING_TYPES.includes('caseRef'));
});

test('an amount does not link sessions', () => {
    const graph = network.buildGraph([
        sessionFrom('amt-1', ['Pay Rs 50,000 now.']),
        sessionFrom('amt-2', ['Pay Rs 50,000 now.']),
    ]);
    assert.equal(graph.clusters.length, 0, 'two people demanding the same round number is a coincidence');
});

test('the linking types are the payment routes and contact points', () => {
    assert.deepEqual(network.LINKING_TYPES, [
        'upiId', 'bankAccount', 'ifsc', 'phone', 'cryptoWallet', 'url', 'apkLink', 'email',
    ]);
    assert.equal(network.SHARED_THRESHOLD, 2);
});

// ---------------------------------------------------------------------------
// Shape and edge cases
// ---------------------------------------------------------------------------

test('an empty graph is a valid graph', () => {
    const graph = network.buildGraph([]);
    assert.deepEqual(graph.nodes, []);
    assert.deepEqual(graph.edges, []);
    assert.deepEqual(graph.clusters, []);
    assert.equal(graph.stats.sessions, 0);
});

test('a session with no identifiers contributes a node and no edges', () => {
    const graph = network.buildGraph([sessionFrom('quiet', ['Hello madam, how are you?'])]);

    assert.equal(graph.nodes.length, 1);
    assert.equal(graph.nodes[0].kind, 'session');
    assert.deepEqual(graph.edges, []);
});

test('the stats match the graph they describe', () => {
    const graph = network.buildGraph([A(), B(), C()]);

    assert.equal(graph.stats.sessions, graph.nodes.filter((n) => n.kind === 'session').length);
    assert.equal(graph.stats.identifiers, graph.nodes.filter((n) => n.kind === 'identifier').length);
    assert.equal(graph.stats.sharedIdentifiers, graph.nodes.filter((n) => n.shared).length);
    assert.equal(graph.stats.clusters, graph.clusters.length);
});

test('clusters come back with the widest one first', () => {
    const graph = network.buildGraph([
        sessionFrom('big-1', ['Pay to wide@okaxis.']),
        sessionFrom('big-2', ['Pay to wide@okaxis.']),
        sessionFrom('big-3', ['Pay to wide@okaxis.']),
        sessionFrom('small-1', ['Pay to narrow@ybl.']),
        sessionFrom('small-2', ['Pay to narrow@ybl.']),
    ]);

    assert.equal(graph.clusters.length, 2);
    assert.equal(graph.clusters[0].sessionCount, 3);
    assert.equal(graph.clusters[1].sessionCount, 2);
});

// ---------------------------------------------------------------------------
// The seeded demo data
// ---------------------------------------------------------------------------

test('the seeded sessions produce the two clusters the demo needs', async () => {
    const { SEEDS, buildSession } = require('../scripts/seed-demo');
    assert.equal(SEEDS.length, 5, 'five past sessions');

    const sessions = [];
    for (const seed of SEEDS) sessions.push(await buildSession(seed));

    const graph = network.buildGraph(sessions);

    assert.equal(graph.stats.sessions, 5);
    assert.equal(graph.clusters.length, 2, 'the two deliberate overlaps');

    const linked = graph.clusters.flatMap((c) => c.linkedBy.map((l) => l.value));
    assert.ok(linked.includes('cyber.verify@okaxis'), 'the shared UPI id');
    assert.ok(linked.includes('+919812345678'), 'the shared phone number');

    for (const cluster of graph.clusters) {
        assert.equal(cluster.sessionCount, 2);
    }
});

test('every seeded session is marked as synthetic', async () => {
    const { SEEDS, buildSession } = require('../scripts/seed-demo');

    for (const seed of SEEDS) {
        const session = await buildSession(seed);
        assert.equal(session.seeded, true, `${seed.sessionId} is not flagged as seeded`);
        assert.ok(session.seedNote.length > 0, 'and says why it exists');
    }
});

test('seeded sessions carry real extracted identifiers, not hand-written ones', async () => {
    const { SEEDS, buildSession } = require('../scripts/seed-demo');
    const session = await buildSession(SEEDS[0]);

    assert.ok(session.entities.length > 0);
    for (const entity of session.entities) {
        // Provenance is what makes an identifier evidence rather than a claim.
        assert.equal(entity.sessionId, SEEDS[0].sessionId);
        assert.ok(entity.messageId, 'points at the message it came from');
        assert.ok(entity.sentence.length > 0, 'quotes the sentence it came from');

        const message = session.messages.find((m) => m.messageId === entity.messageId);
        assert.ok(message, 'the message it points at exists');
        assert.ok(message.text.includes(entity.raw), 'and really contains the value');
    }
});
