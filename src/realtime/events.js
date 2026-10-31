/**
 * Event transport.
 *
 * The Guardian emits through this interface rather than touching Socket.IO
 * directly, so it can be driven in a test with no server running and the
 * emitted events can be asserted on.
 *
 * Event names are fixed:
 *   guardian.score          every scored message
 *   guardian.state_changed  a state machine transition
 *   guardian.takeover       the decoy has taken the conversation over
 *   guardian.released       the decoy has let go, or was never engaged
 *
 * Plus one transport event for the console:
 *
 *   session.turn            the whole completed turn
 *
 * The four guardian events are the agent's own decisions. session.turn exists
 * so a second screen showing only the intelligence panel can stay live without
 * having sent the message itself - without it, that screen would see scores
 * change but never learn what was extracted.
 */

const EVENTS = {
    SCORE: 'guardian.score',
    STATE_CHANGED: 'guardian.state_changed',
    TAKEOVER: 'guardian.takeover',
    RELEASED: 'guardian.released',
    TURN: 'session.turn',
};

/** Discards everything. Used when no transport is wired up. */
const nullEmitter = () => ({
    emit: () => {},
    events: [],
});

/**
 * An emitter that can be pointed at its real transport later.
 *
 * Needed because of a boot-order constraint: Socket.IO captures whatever
 * request listeners the http server already has when it attaches, and
 * delegates to them for anything that is not its own path. So Express has to be
 * on the server BEFORE Socket.IO attaches - otherwise both handlers answer the
 * same request and the client script comes back empty. But the Express app
 * needs an emitter at construction time. This closes that loop.
 */
const lateBoundEmitter = () => {
    let target = null;
    return {
        emit: (name, payload) => {
            if (target) target.emit(name, payload);
        },
        bind: (transport) => {
            target = transport;
        },
        get bound() {
            return target !== null;
        },
    };
};

/** Records every event in memory. Used by tests and the replay tooling. */
const recordingEmitter = () => {
    const events = [];
    return {
        events,
        emit: (name, payload) => {
            events.push({ name, payload, at: new Date() });
        },
        /** All recorded events of one name. */
        of: (name) => events.filter((e) => e.name === name),
        clear: () => {
            events.length = 0;
        },
    };
};

/**
 * Emits over Socket.IO, into a room per session so one operator console only
 * sees the conversation it is watching.
 */
const socketEmitter = (io) => ({
    events: [],
    emit: (name, payload) => {
        // Room-scoped when the event belongs to a session, broadcast otherwise.
        // Doing both would deliver every event twice to a watching client.
        if (payload && payload.sessionId) {
            io.to(`session:${payload.sessionId}`).emit(name, payload);
            return;
        }
        io.emit(name, payload);
    },
});

/**
 * Attaches a Socket.IO server to an http server and returns an emitter.
 * Clients join a session room by sending `watch` with a sessionId.
 */
const attach = (httpServer, { cors = { origin: '*' } } = {}) => {
    const { Server } = require('socket.io');
    const io = new Server(httpServer, { cors });

    io.on('connection', (socket) => {
        socket.on('watch', (sessionId) => {
            if (typeof sessionId === 'string' && sessionId.trim() !== '') {
                socket.join(`session:${sessionId.trim()}`);
            }
        });
        socket.on('unwatch', (sessionId) => {
            if (typeof sessionId === 'string') socket.leave(`session:${sessionId.trim()}`);
        });
    });

    return { io, emitter: socketEmitter(io) };
};

module.exports = { EVENTS, nullEmitter, lateBoundEmitter, recordingEmitter, socketEmitter, attach };
