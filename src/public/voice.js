/**
 * Speech in and speech out, behind an adapter.
 *
 * Call mode needs two things from the platform: turn a microphone into text,
 * and turn text into audio. Both are done here by the browser's Web Speech
 * API, which is the only engine that needs no server, no key and no build
 * step - and which, today, means Chrome.
 *
 * Neither of those is a decision the rest of the console should know about, so
 * both sit behind a named interface. A server-side engine (Whisper for the
 * recogniser, a hosted voice for the speaker) can be registered under a second
 * name later and selected with one string, with nothing in app.js changing.
 * No such engine is written here.
 *
 * THE INTERFACES
 *
 *   Recognizer
 *     available   boolean    is this engine usable in this browser
 *     listening   boolean
 *     lang        string     a BCP-47 tag; 'en-IN', 'hi-IN', 'mr-IN'
 *     start()                begins listening; safe to call twice
 *     stop()                 stops after the current utterance
 *     abort()                stops now and drops the current utterance
 *     onpartial(text)        a revised guess at a sentence still being spoken
 *     onfinal(text)          the recogniser has committed to a sentence
 *     onspeechstart()        someone began speaking (barge-in hangs off this)
 *     onstatus(state, note)  'idle' | 'listening' | 'error'
 *
 *   Speaker
 *     available   boolean
 *     speaking    boolean
 *     speak(text, { lang })  queues one utterance; resolves when it finishes
 *     cancel()               stops immediately, drops anything queued
 *     voiceFor(lang)         which voice this engine would use, for the UI
 *     onstart(text) / onend()
 *
 * WHAT THIS IS NOT
 *
 * There is no telephony here and nothing dials out. The microphone is the
 * laptop's; the audio goes to the laptop's speakers. And the speaker only ever
 * uses a voice the platform already ships - no voice of any real person is
 * sampled, modelled or reproduced.
 *
 * ONE THING TO KNOW ABOUT THE BROWSER RECOGNISER
 *
 * Chrome's implementation is not local. It streams microphone audio to
 * Google's speech service and streams text back. That is a good reason for the
 * adapter to exist and a good reason to say so on screen, which Call mode
 * does.
 */

(() => {
    'use strict';

    // -----------------------------------------------------------------------
    // Languages Call mode offers
    // -----------------------------------------------------------------------

    /**
     * The three the decoy can hold a conversation in. `decoy` is the name the
     * Decoy agent uses for the same language, so a reply can be spoken in
     * whatever it actually chose to answer in rather than whatever the
     * microphone was set to.
     */
    const LANGUAGES = [
        { tag: 'en-IN', label: 'English (India)', decoy: 'English' },
        { tag: 'hi-IN', label: 'हिंदी / Hindi', decoy: 'Hindi' },
        { tag: 'mr-IN', label: 'मराठी / Marathi', decoy: 'Marathi' },
    ];

    /** Decoy language name -> the tag to speak it with. */
    const tagForDecoyLanguage = (name) => {
        const found = LANGUAGES.find((l) => l.decoy === name);
        return found ? found.tag : 'en-IN';
    };

    // -----------------------------------------------------------------------
    // Browser recogniser
    // -----------------------------------------------------------------------

    const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition || null;

    /**
     * The Web Speech recogniser, wrapped to behave like something a long call
     * can be held on.
     *
     * Two things it does not do on its own:
     *
     *   1. It stops by itself. `continuous` means "do not stop after one
     *      sentence", not "never stop" - a few seconds of silence, or a
     *      network hiccup, and `onend` fires. So this restarts it for as long
     *      as the call is meant to be live, and only reports 'idle' when the
     *      caller actually hung up.
     *
     *   2. It reports every revision of the current sentence as a fresh
     *      result list rather than a delta. So the interim text is rebuilt
     *      from the whole list each time, and only the pieces marked final are
     *      handed over as finished sentences.
     */
    class BrowserRecognizer {
        constructor() {
            this.name = 'browser';
            this.available = SpeechRecognitionImpl !== null;
            this.listening = false;
            this.lang = 'en-IN';

            this.onpartial = () => {};
            this.onfinal = () => {};
            this.onspeechstart = () => {};
            this.onstatus = () => {};

            // Set while the call is meant to be live, which is what tells an
            // `onend` apart from a hang-up.
            this._wanted = false;
            this._impl = null;
        }

        start() {
            if (!this.available) {
                this.onstatus('error', 'This browser has no Web Speech recogniser. Call mode needs Chrome.');
                return;
            }
            this._wanted = true;
            this._spin();
        }

        stop() {
            this._wanted = false;
            if (this._impl) this._impl.stop();
        }

        abort() {
            this._wanted = false;
            if (this._impl) this._impl.abort();
            this.listening = false;
            this.onstatus('idle', '');
        }

        /** Builds a recogniser and starts it. One per stretch of listening. */
        _spin() {
            if (!this._wanted || this.listening) return;

            const impl = new SpeechRecognitionImpl();
            this._impl = impl;
            impl.lang = this.lang;
            impl.continuous = true;
            impl.interimResults = true;
            impl.maxAlternatives = 1;

            impl.onstart = () => {
                this.listening = true;
                this.onstatus('listening', '');
            };

            impl.onspeechstart = () => this.onspeechstart();

            impl.onresult = (event) => {
                let interim = '';

                for (let i = event.resultIndex; i < event.results.length; i += 1) {
                    const result = event.results[i];
                    const text = (result[0] && result[0].transcript ? result[0].transcript : '').trim();
                    if (text === '') continue;

                    if (result.isFinal) this.onfinal(text);
                    else interim = `${interim} ${text}`.trim();
                }

                if (interim !== '') this.onpartial(interim);
            };

            impl.onerror = (event) => {
                // 'no-speech' and 'aborted' are routine on a call with pauses
                // in it. Only the rest are worth putting on screen.
                if (event.error === 'no-speech' || event.error === 'aborted') return;

                if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
                    this._wanted = false;
                    this.onstatus('error', 'Microphone permission was refused. Allow the mic and start the call again.');
                    return;
                }
                this.onstatus('error', `Recogniser error: ${event.error}`);
            };

            impl.onend = () => {
                this.listening = false;
                this._impl = null;

                if (this._wanted) {
                    // Chrome ends a session on silence. Pick it straight back up:
                    // the call has not finished, the caller just paused.
                    setTimeout(() => this._spin(), 150);
                    return;
                }
                this.onstatus('idle', '');
            };

            try {
                impl.start();
            } catch (error) {
                // start() on an instance that is already running throws rather
                // than being a no-op. Harmless.
                this.onstatus('error', `Could not start listening: ${error.message}`);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Browser speaker
    // -----------------------------------------------------------------------

    /**
     * Hints for finding a female Indian voice among whatever the platform
     * happens to ship. These are the names of synthetic voices in Windows,
     * macOS, Android and Chrome's own set - not people.
     */
    const FEMALE_HINTS = /\b(female|woman|heera|kalpana|swara|lekha|aditi|raveena|neerja|veena|isha|google हिन्दी|google मराठी)\b/i;
    const MALE_HINTS = /\b(male|man|hemant|madhur|ravi|manohar|rishi|prabhat)\b/i;

    class BrowserSpeaker {
        constructor() {
            this.name = 'browser';
            this.available = typeof window.speechSynthesis !== 'undefined'
                && typeof window.SpeechSynthesisUtterance !== 'undefined';
            this.speaking = false;

            // Slightly slower than default. The decoy is an unhurried woman in
            // her seventies, and a scammer is listening for exactly that.
            this.rate = 0.88;
            this.pitch = 1.0;

            this.onstart = () => {};
            this.onend = () => {};

            this._current = null;
            this._voices = [];

            if (this.available) this._loadVoices();
        }

        /**
         * The voice list is populated asynchronously, and in Chrome it is
         * empty until `voiceschanged` fires at least once.
         */
        _loadVoices() {
            const read = () => {
                this._voices = window.speechSynthesis.getVoices() || [];
            };
            read();
            window.speechSynthesis.addEventListener('voiceschanged', read);
        }

        /**
         * Picks a voice for a language tag, preferring an Indian female one.
         *
         * In order: a female voice in the exact language; any voice in the
         * exact language; a female Indian voice in another Indian language;
         * any Indian voice; then nothing, which leaves the platform default.
         *
         * Returns the chosen voice, or null, so the UI can say which one it
         * found rather than implying a voice that is not there.
         */
        voiceFor(lang) {
            if (!this.available) return null;
            if (this._voices.length === 0) this._voices = window.speechSynthesis.getVoices() || [];

            const voices = this._voices;
            const feminine = (v) => FEMALE_HINTS.test(v.name) && !MALE_HINTS.test(v.name);
            const exact = voices.filter((v) => (v.lang || '').replace('_', '-').toLowerCase() === lang.toLowerCase());
            const indian = voices.filter((v) => /[-_]IN$/i.test(v.lang || ''));

            return exact.find(feminine)
                || exact.find((v) => !MALE_HINTS.test(v.name))
                || exact[0]
                || indian.find(feminine)
                || indian.find((v) => !MALE_HINTS.test(v.name))
                || indian[0]
                || null;
        }

        /**
         * Speaks one line.
         *
         * Resolves when the audio finishes, or immediately if it was cancelled,
         * so a caller can await it without a barge-in leaving a dangling
         * promise.
         */
        speak(text, { lang = 'en-IN' } = {}) {
            const body = String(text || '').trim();
            if (!this.available || body === '') return Promise.resolve({ spoken: false });

            // Anything still playing is stale by definition: the decoy only
            // ever has one thing to say at a time.
            this.cancel();

            return new Promise((resolve) => {
                const utterance = new window.SpeechSynthesisUtterance(body);
                utterance.lang = lang;
                utterance.rate = this.rate;
                utterance.pitch = this.pitch;

                const voice = this.voiceFor(lang);
                if (voice) utterance.voice = voice;

                let settled = false;
                const finish = (spoken) => {
                    if (settled) return;
                    settled = true;
                    this.speaking = false;
                    this._current = null;
                    this.onend();
                    resolve({ spoken, voice: voice ? voice.name : null });
                };

                utterance.onstart = () => {
                    this.speaking = true;
                    this.onstart(body);
                };
                utterance.onend = () => finish(true);
                utterance.onerror = () => finish(false);

                this._current = utterance;
                window.speechSynthesis.speak(utterance);
            });
        }

        cancel() {
            if (!this.available) return;
            if (this.speaking || this._current) {
                // `cancel` fires onend on the utterance, which settles the
                // promise speak() handed out.
                window.speechSynthesis.cancel();
            }
            this.speaking = false;
            this._current = null;
        }
    }

    // -----------------------------------------------------------------------
    // Echo suppression
    // -----------------------------------------------------------------------

    /**
     * Whether a transcript is the decoy's own voice coming back in.
     *
     * On a laptop with no headphones the microphone hears the speakers, so the
     * decoy's reply gets transcribed as something the scammer said - and would
     * be scored, and answered. Nothing in the Web Speech API distinguishes the
     * two, so this compares the text: if most of what was heard is already in
     * the line being spoken, it is the echo.
     *
     * The threshold is deliberately high. Dropping a real sentence is worse
     * than scoring an echo, and a scammer repeating the decoy's own words back
     * at her is not the interesting part of the call.
     */
    const isEcho = (heard, spoken) => {
        const words = (text) => String(text || '')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .split(/\s+/)
            .filter((w) => w.length > 2);

        const heardWords = words(heard);
        if (heardWords.length === 0) return false;

        const spokenWords = new Set(words(spoken));
        if (spokenWords.size === 0) return false;

        const overlap = heardWords.filter((w) => spokenWords.has(w)).length;
        return overlap / heardWords.length >= 0.7;
    };

    // -----------------------------------------------------------------------
    // Registry
    // -----------------------------------------------------------------------

    /**
     * Engines by name. A server-side pair would be registered here as
     * `server: { recognizer: ..., speaker: ... }` and chosen by name; nothing
     * else in the console would change.
     */
    const ENGINES = {
        browser: {
            label: 'Browser (Web Speech API)',
            recognizer: () => new BrowserRecognizer(),
            speaker: () => new BrowserSpeaker(),
        },
    };

    const create = (engine = 'browser') => {
        const chosen = ENGINES[engine] || ENGINES.browser;
        return {
            engine: ENGINES[engine] ? engine : 'browser',
            label: chosen.label,
            recognizer: chosen.recognizer(),
            speaker: chosen.speaker(),
        };
    };

    window.ChakravyuhVoice = {
        LANGUAGES,
        ENGINES,
        create,
        isEcho,
        tagForDecoyLanguage,
        // Exposed so a page can explain what is missing before offering a
        // button that cannot work.
        support: {
            get stt() { return SpeechRecognitionImpl !== null; },
            get tts() { return typeof window.speechSynthesis !== 'undefined'; },
        },
    };
})();
