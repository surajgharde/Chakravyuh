/**
 * Call mode: the Guardian's partial-transcript path, the speech adapter, and
 * the console's call controls.
 *
 * Three groups, in order of how much they can break:
 *
 *   1. The Guardian on a partial. A partial is a weaker, one-way decision, and
 *      every one of those limits is load-bearing: a fragment that could
 *      release an engagement, or lower a warning, would make the user's screen
 *      flicker between states inside a single breath.
 *
 *   2. The adapter in voice.js. Loaded into a sandbox with a fake `window`, so
 *      the voice-selection and echo-suppression logic is tested rather than
 *      read.
 *
 *   3. The console. Same reasoning as console.test.js: the page has no build
 *      step, so nothing but a test catches a control wired to an id that is
 *      not there.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const guardian = require('../src/agents/guardian');
const extractor = require('../src/services/extractor');
const stages = require('../src/services/stages');
const trustedContacts = require('../src/services/trustedContacts');
const { recordingEmitter, EVENTS } = require('../src/realtime/events');
const { LlmClient } = require('../src/llm/client');

// No database in this file, so every caller is simply unknown.
trustedContacts.invalidate();

// ---------------------------------------------------------------------------
// 1. The Guardian on a partial transcript
// ---------------------------------------------------------------------------

/** Half of the sentence a digital-arrest call opens with. */
const PARTIAL_SCAM = 'Madam this is Inspector Deshmukh from CBI, a parcel in your name was '
    + 'seized with narcotics, do not tell anyone and do not disconnect this call, share the OTP';

const fakeSession = (overrides = {}) => ({
    sessionId: 's-call',
    userId: 'u1',
    guardianState: guardian.STATES.MONITORING,
    messageCount: 0,
    decoyMessageCount: 0,
    firstSeenAt: new Date(),
    counterpartId: null,
    classifierLabel: 'unavailable',
    classifierReasons: [],
    guardianLog: [],
    ...overrides,
});

const score = (text, options = {}) => guardian.handleMessage({
    session: options.session ?? fakeSession(),
    text,
    entities: extractor.extractEntities(text, { sessionId: 's-call', messageId: null, timestamp: new Date() }),
    scriptStages: stages.tagWithRules(text).map((t) => t.stage),
    userId: 'u1',
    ...options,
});

/** An LLM that fails the test if the Guardian calls it. */
const forbiddenLlm = () => new LlmClient(
    { baseUrl: 'x', apiKey: 'placeholder', model: 'm', timeoutMs: 200 },
    {
        transport: async () => {
            assert.fail('the classifier was called on a partial transcript');
        },
    }
);

const llmSaying = (payload) => new LlmClient(
    { baseUrl: 'x', apiKey: 'placeholder', model: 'm', timeoutMs: 200 },
    { transport: async () => JSON.stringify(payload) }
);

test('a partial transcript can hand off before the sentence is finished', async () => {
    const session = fakeSession();
    const verdict = await score(PARTIAL_SCAM, { session, partial: true });

    assert.equal(verdict.state, guardian.STATES.DECOY_ACTIVE);
    assert.ok(verdict.engagedNow, 'the hand-off has to happen on the partial, not after it');
    assert.equal(session.guardianState, guardian.STATES.DECOY_ACTIVE,
        'the state must be written, or the finished sentence arrives at a session that is still monitoring');
    assert.ok(verdict.partial, 'the verdict says which kind of decision it was');
});

test('a partial never calls the classifier', async () => {
    // One partial every two seconds times a model call each would cost more
    // than the rest of the call put together, to judge an unfinished sentence.
    const verdict = await score(PARTIAL_SCAM, { partial: true, llm: forbiddenLlm() });
    assert.equal(verdict.classifier.available, false);
    assert.match(verdict.classifier.note, /partial/i);
});

test('a finished message does still call the classifier', async () => {
    const verdict = await score(PARTIAL_SCAM, { llm: llmSaying({ label: 'scam', reasons: ['demands an OTP'] }) });
    assert.equal(verdict.classifier.available, true);
    assert.equal(verdict.classifier.label, 'scam');
});

test('the hard-signal gate still applies to a partial', async () => {
    // Authority claim, urgency and a link: three soft signals a real utility
    // SMS also produces. A partial must not be a way around the gate.
    const soft = 'This is from the electricity board, your connection will be disconnected today, '
        + 'see https://mseb-billing.example.in for details.';
    const verdict = await score(soft, { partial: true });

    assert.notEqual(verdict.state, guardian.STATES.DECOY_ACTIVE);
    assert.equal(verdict.hardSignals.length, 0);
});

test('a partial raises the state but never lowers it', async () => {
    const session = fakeSession({ guardianState: guardian.STATES.SUSPICIOUS });

    // A fragment with nothing alarming in it at all.
    const verdict = await score('madam, actually, one minute', { session, partial: true });

    assert.equal(verdict.state, guardian.STATES.SUSPICIOUS, 'the warning must not vanish mid-sentence');
    assert.ok(verdict.notes.some((n) => /never lowers the state/i.test(n)),
        'and it must say why it held');
});

test('a partial never releases an engaged session', async () => {
    const session = fakeSession({ guardianState: guardian.STATES.DECOY_ACTIVE });

    // Quiet text plus a 'legit' label is exactly what releases a finished
    // message. On a fragment it must not.
    const verdict = await score('okay madam, thank you', {
        session,
        partial: true,
        llm: llmSaying({ label: 'legit', reasons: ['an ordinary closing line'] }),
    });

    assert.equal(verdict.state, guardian.STATES.DECOY_ACTIVE);
    assert.equal(verdict.released, false);
});

test('a finished message can still release an engaged session', async () => {
    const session = fakeSession({ guardianState: guardian.STATES.DECOY_ACTIVE });
    const verdict = await score('Maa, what is for dinner today? I will reach home by 8.', {
        session,
        llm: llmSaying({ label: 'legit', reasons: ['an ordinary family message'] }),
    });

    assert.equal(verdict.state, guardian.STATES.LEGIT);
    assert.ok(verdict.released);
});

test('a partial leaves the stored classifier verdict alone', async () => {
    const session = fakeSession({
        classifierLabel: 'scam',
        classifierReasons: ['demands an OTP'],
    });

    await score(PARTIAL_SCAM, { session, partial: true });

    assert.equal(session.classifierLabel, 'scam',
        'a report must quote the label reached on a finished sentence, not "unavailable"');
    assert.deepEqual(session.classifierReasons, ['demands an OTP']);
});

test('a partial is logged only when it moved the state, and is marked as one', async () => {
    const session = fakeSession();

    // First partial: MONITORING -> DECOY_ACTIVE. Worth a line.
    await score(PARTIAL_SCAM, { session, partial: true });
    assert.equal(session.guardianLog.length, 1);
    assert.equal(session.guardianLog[0].partial, true);
    assert.equal(session.guardianLog[0].stateChanged, true);
    assert.equal(session.guardianLog[0].messageId, null,
        'there is no message to point at: the sentence was not finished');

    // Three more partials of the same sentence change nothing, and must not
    // bury the decision that mattered.
    await score(`${PARTIAL_SCAM} immediately`, { session, partial: true });
    await score(`${PARTIAL_SCAM} immediately madam`, { session, partial: true });
    await score(`${PARTIAL_SCAM} immediately madam please`, { session, partial: true });

    assert.equal(session.guardianLog.length, 1, 'a partial that changed nothing is not logged');
});

test('a finished message is always logged, and is not marked partial', async () => {
    const session = fakeSession();
    await score(PARTIAL_SCAM, { session });
    await score('and the case number is MUM/CYB/2026/00891', { session });

    assert.equal(session.guardianLog.length, 2);
    assert.ok(session.guardianLog.every((entry) => entry.partial === false));
});

test('every event from a partial says it came from one', async () => {
    const events = recordingEmitter();
    await score(PARTIAL_SCAM, { session: fakeSession(), partial: true, events });

    const emitted = events.of(EVENTS.SCORE).concat(
        events.of(EVENTS.STATE_CHANGED),
        events.of(EVENTS.TAKEOVER)
    );
    assert.ok(emitted.length >= 3, 'a hand-off emits a score, a transition and a takeover');
    for (const event of emitted) {
        assert.equal(event.payload.partial, true, `${event.name} does not say it was a partial`);
    }
});

test('a terminal session is not re-escalated by a partial', async () => {
    for (const terminal of [guardian.STATES.ENDED, guardian.STATES.LEGIT, guardian.STATES.FALSE_POSITIVE]) {
        const session = fakeSession({ guardianState: terminal });
        const verdict = await score(PARTIAL_SCAM, { session, partial: true });
        assert.equal(verdict.state, terminal, `a partial restarted a ${terminal} session`);
    }
});

// ---------------------------------------------------------------------------
// 2. The speech adapter
// ---------------------------------------------------------------------------

const PUBLIC = path.join(__dirname, '..', 'src', 'public');
const voiceSource = fs.readFileSync(path.join(PUBLIC, 'voice.js'), 'utf8');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');

/**
 * Runs voice.js against a fake browser.
 *
 * `voices` is the list speechSynthesis will claim to have, which is how the
 * voice-selection order gets tested without a browser.
 */
const loadVoice = ({ stt = true, tts = true, voices = [] } = {}) => {
    const window = {
        setTimeout,
        clearTimeout,
    };

    if (stt) {
        window.webkitSpeechRecognition = function Recognition() {
            this.start = () => {};
            this.stop = () => {};
            this.abort = () => {};
        };
    }
    if (tts) {
        window.speechSynthesis = {
            getVoices: () => voices,
            addEventListener: () => {},
            speak: () => {},
            cancel: () => {},
        };
        window.SpeechSynthesisUtterance = function Utterance(text) {
            this.text = text;
        };
    }

    const context = vm.createContext({ window, setTimeout, clearTimeout });
    context.window.window = context.window;
    vm.runInContext(voiceSource, context);
    return window.ChakravyuhVoice;
};

const voiceOf = (name, lang) => ({ name, lang });

test('voice.js exposes the adapter and nothing browser-specific leaks past it', () => {
    const api = loadVoice();
    assert.ok(api, 'voice.js did not publish an adapter');
    assert.equal(typeof api.create, 'function');

    const engine = api.create('browser');
    // The two interfaces the rest of the console is written against.
    for (const method of ['start', 'stop', 'abort']) {
        assert.equal(typeof engine.recognizer[method], 'function', `the recogniser has no ${method}()`);
    }
    for (const method of ['speak', 'cancel', 'voiceFor']) {
        assert.equal(typeof engine.speaker[method], 'function', `the speaker has no ${method}()`);
    }
    for (const hook of ['onpartial', 'onfinal', 'onstatus']) {
        assert.equal(typeof engine.recognizer[hook], 'function', `the recogniser has no ${hook} hook`);
    }
    assert.equal(engine.recognizer.available, true);
    assert.equal(engine.speaker.available, true);
});

test('an unknown engine falls back to the browser rather than returning nothing', () => {
    // The point of the registry is that a server-side engine can be added
    // later. Asking for one that is not registered must not break the page.
    const engine = loadVoice().create('server');
    assert.equal(engine.engine, 'browser');
    assert.ok(engine.recognizer);
    assert.ok(engine.speaker);
});

test('no server-side engine is registered yet, and the seam is the only way one would be', () => {
    const api = loadVoice();
    assert.equal(Object.keys(api.ENGINES).join(','), 'browser',
        'this phase registers the browser engine only');
});

test('a browser with no Web Speech recogniser reports itself unavailable', () => {
    const api = loadVoice({ stt: false });
    assert.equal(api.support.stt, false);
    assert.equal(api.create('browser').recognizer.available, false);
});

test('Call mode offers exactly the three languages the decoy speaks', () => {
    const api = loadVoice();
    // Joined rather than deep-compared: the arrays come back from the sandbox
    // realm, where even an identical array is not reference-equal to one here.
    assert.equal(api.LANGUAGES.map((l) => l.tag).join(','), 'en-IN,hi-IN,mr-IN');
    assert.equal(api.LANGUAGES.map((l) => l.decoy).join(','), 'English,Hindi,Marathi');
});

test('the reply is spoken in the language the decoy chose, not the microphone setting', () => {
    const api = loadVoice();
    assert.equal(api.tagForDecoyLanguage('Marathi'), 'mr-IN');
    assert.equal(api.tagForDecoyLanguage('Hindi'), 'hi-IN');
    assert.equal(api.tagForDecoyLanguage('English'), 'en-IN');
    // The decoy could in principle report something else; a tag is still needed.
    assert.equal(api.tagForDecoyLanguage('Klingon'), 'en-IN');
});

test('an Indian female voice is preferred, in the language asked for', () => {
    const api = loadVoice({
        voices: [
            voiceOf('Microsoft David - English (United States)', 'en-US'),
            voiceOf('Microsoft Ravi - English (India)', 'en-IN'),
            voiceOf('Microsoft Heera - English (India)', 'en-IN'),
            voiceOf('Microsoft Hemant - Hindi (India)', 'hi-IN'),
            voiceOf('Microsoft Kalpana - Hindi (India)', 'hi-IN'),
        ],
    });
    const speaker = api.create('browser').speaker;

    assert.equal(speaker.voiceFor('en-IN').name, 'Microsoft Heera - English (India)');
    assert.equal(speaker.voiceFor('hi-IN').name, 'Microsoft Kalpana - Hindi (India)');
});

test('with no voice in that language, another Indian voice is used before a foreign one', () => {
    const api = loadVoice({
        voices: [
            voiceOf('Microsoft Zira - English (United States)', 'en-US'),
            voiceOf('Microsoft Heera - English (India)', 'en-IN'),
        ],
    });
    const chosen = api.create('browser').speaker.voiceFor('mr-IN');
    assert.equal(chosen.name, 'Microsoft Heera - English (India)');
});

test('with no Indian voice at all, it returns null rather than pretending', () => {
    const api = loadVoice({ voices: [voiceOf('Microsoft Zira - English (United States)', 'en-US')] });
    assert.equal(api.create('browser').speaker.voiceFor('en-IN'), null,
        'the UI has to be able to say it fell back to the platform default');
});

test('the decoy speaks slightly slower than default', () => {
    const speaker = loadVoice().create('browser').speaker;
    assert.ok(speaker.rate < 1, `rate is ${speaker.rate}`);
    assert.ok(speaker.rate > 0.7, 'but not so slow it sounds broken');
});

test("the decoy's own voice coming back through the mic is recognised as an echo", () => {
    const { isEcho } = loadVoice();
    const spoken = 'Haan beta, I am trying but my eyes are weak, which number should I type?';

    assert.equal(isEcho('which number should I type', spoken), true);
    assert.equal(isEcho('haan beta I am trying but my eyes are weak', spoken), true);
});

test('a real interruption is not mistaken for an echo', () => {
    const { isEcho } = loadVoice();
    const spoken = 'Haan beta, I am trying but my eyes are weak, which number should I type?';

    assert.equal(isEcho('madam listen to me carefully, transfer the money now', spoken), false);
    assert.equal(isEcho('no no, first share the OTP', spoken), false);
    // Nothing being spoken means nothing can be an echo.
    assert.equal(isEcho('which number should I type', ''), false);
    assert.equal(isEcho('', spoken), false);
});

// ---------------------------------------------------------------------------
// 3. The console's call controls
// ---------------------------------------------------------------------------

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

test('the call controls are all on the page', () => {
    for (const id of ['btn-call', 'call-lang', 'call-status', 'call-timer', 'call-mute', 'call-badge']) {
        assert.ok(htmlIds.has(id), `Call mode is missing ${id}`);
    }
});

test('the live transcript appears on all three panes', () => {
    assert.ok(htmlIds.has('phone-live'), 'the phone pane has no live transcript');
    assert.ok(htmlIds.has('call-live'), 'the scammer console has no live transcript');
    assert.ok(htmlIds.has('intel-live'), 'the intelligence panel has no live transcript');
});

test('the page says on screen that the call is simulated and nothing is dialled', () => {
    assert.match(html, /SIMULATED CALL/);
    assert.match(html, /no telephony/i);
    assert.match(html, /simulated call, your laptop mic/i);
});

test('nothing in the project dials out or integrates telephony', () => {
    const sources = [appJs, voiceSource, html];
    for (const forbidden of ['twilio', 'plivo', 'exotel', 'sip:', 'tel:', 'RTCPeerConnection']) {
        for (const source of sources) {
            assert.ok(!source.toLowerCase().includes(forbidden.toLowerCase()),
                `a source file references ${forbidden}`);
        }
    }
});

test('voice.js is loaded before app.js, which is the only order that works', () => {
    assert.ok(html.includes('<script src="voice.js">'), 'voice.js is not loaded');
    assert.ok(html.indexOf('voice.js') < html.indexOf('"app.js"'), 'app.js would run first');
});

/** Source with comments removed, for assertions about what the code does. */
const withoutComments = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

test('app.js goes through the adapter and never touches the Web Speech API itself', () => {
    // The whole point of the seam: swapping in a server-side engine must be a
    // change in voice.js and nowhere else. Comments are stripped first, since
    // the comments in app.js do name the API they are describing.
    const code = withoutComments(appJs);
    for (const api of ['webkitSpeechRecognition', 'SpeechRecognition', 'speechSynthesis', 'SpeechSynthesisUtterance']) {
        assert.ok(!code.includes(api), `app.js reaches past the adapter for ${api}`);
    }
    assert.ok(code.includes('window.ChakravyuhVoice'), 'app.js does not use the adapter');
});

test('partials go to the Guardian roughly every two seconds', () => {
    assert.ok(appJs.includes('PARTIAL_INTERVAL_MS = 2000'), 'the partial cadence is not ~2s');
    assert.ok(/setInterval\(sendPartial, PARTIAL_INTERVAL_MS\)/.test(appJs), 'nothing sends partials on a timer');
    assert.ok(appJs.includes("api('/api/partial'"), 'partials never reach the Guardian');
});

test('a final transcript is sent as a live message so the decoy can answer', () => {
    assert.ok(/send\(text, \{ live: true \}\)/.test(appJs), 'a finished sentence is not sent as a live turn');
    assert.ok(appJs.includes('engine.speaker.speak('), 'the reply is never spoken');
});

test('the decoy stops talking when the scammer starts', () => {
    assert.ok(appJs.includes('engine.speaker.cancel()'), 'nothing can stop the decoy mid-sentence');
    assert.ok(/isEcho/.test(appJs), 'barge-in would fire on the decoy\'s own voice');
});

test('the console listens for the live transcript so a second screen sees it', () => {
    assert.ok(appJs.includes(`socket.on('${EVENTS.TRANSCRIPT}'`), 'the transcript event is not handled');
});

test('a partial is shown as a partial and never enables the report', () => {
    // applyPartial exists precisely so a fragment cannot light up the report
    // buttons or move the engagement clock.
    assert.ok(appJs.includes('const applyPartial'), 'partials are applied through applyTurn');
    const applyPartial = appJs.slice(appJs.indexOf('const applyPartial'), appJs.indexOf('const sendPartial'));
    assert.ok(!applyPartial.includes('btnReport'), 'a partial enables the report button');
    assert.ok(!applyPartial.includes('firstSeenAt'), 'a partial touches the engagement clock');
});

test('Call mode tells the user it needs Chrome instead of failing silently', () => {
    assert.match(appJs, /Call mode needs Chrome/);
    assert.ok(appJs.includes('el.btnCall.disabled = true'), 'an unusable button is left enabled');
});

test('the page still pulls in nothing else from the network', () => {
    // Call mode adds no CDN: the Web Speech API is in the browser.
    const external = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
    const allowed = ['https://cdn.tailwindcss.com', 'https://cdnjs.cloudflare.com'];
    for (const url of external) {
        assert.ok(allowed.some((prefix) => url.startsWith(prefix)), `unexpected external resource: ${url}`);
    }
});

test('voice.js needs no build step either', () => {
    assert.ok(!/\bimport\s+.*\bfrom\b/.test(voiceSource), 'voice.js uses module imports');
    assert.ok(!/\bexport\s+(default|const|function)/.test(voiceSource), 'voice.js uses module exports');
});

test('no voice of any real person is reproduced', () => {
    // Only names the platform's own synthetic voices, and only to pick one.
    for (const forbidden of ['clone', 'voiceprint', 'elevenlabs', 'resemble.ai', 'speaker embedding']) {
        assert.ok(!voiceSource.toLowerCase().includes(forbidden.toLowerCase()),
            `voice.js references ${forbidden}`);
    }
    // The sentence is wrapped across two comment lines in the source.
    assert.match(voiceSource.replace(/\s*\n\s*\*\s*/g, ' '),
        /no voice of any real person is sampled, modelled or reproduced/i);
});

// ---------------------------------------------------------------------------
// A spoken turn drops the two things that cost the most wall-clock time
// ---------------------------------------------------------------------------

test('a live turn has no typing delay', () => {
    const decoy = require('../src/agents/decoy');
    assert.equal(decoy.typingDelayMs({ live: true }), 0, 'nobody types during a phone call');

    // And a typed turn still gets one, so this did not quietly disable it.
    const typed = decoy.typingDelayMs({});
    assert.ok(typed >= 1000 && typed <= 3000, `a typed reply still waits (got ${typed}ms)`);
});

test('a live turn skips the stage tagger\'s model call but keeps its rules', async () => {
    const text = 'A non-bailable warrant is ready against you. Transfer the money now.';
    const tagged = await stages.tag(text, { llm: forbiddenLlm(), useLlm: false });

    assert.ok(tagged.length > 0, 'the stage rules still run on a spoken turn');
    assert.ok(tagged.every((tag) => tag.method === 'rules'));
});

test('the pipeline passes both of those through from one flag', () => {
    const pipeline = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'pipeline.js'), 'utf8');
    assert.ok(pipeline.includes('const live = body?.live === true'), 'the live flag is never read');
    assert.ok(pipeline.includes('useLlm: !live'), 'a live turn still waits on the stage tagger');
    assert.ok(pipeline.includes('config: { ...config, live }'), 'a live turn still waits on the typing delay');
    assert.equal(typeof require('../src/services/pipeline').handlePartial, 'function');
});
