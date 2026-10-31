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
 */

const EVENTS = {
    SCORE: 'guardian.score',
    STATE_CHANGED: 'guardian.state_changed',
    TAKEOVER: 'guardian.takeover',
    RELEASED: 'guardian.released',
};

/** Discards everything. Used when no transport is wired up. */
const nullEmitter = () => ({
    emit: () => {},
    events: [],
});

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

module.exports = { EVENTS, nullEmitter, recordingEmitter, socketEmitter, attach };
