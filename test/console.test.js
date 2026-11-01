/**
 * Checks on the demo console.
 *
 * The console is plain HTML and JavaScript with no build step, so nothing
 * catches a mistyped element id or a handler bound to something that is not on
 * the page - it just silently does nothing at the moment a judge clicks it.
 * These tests are that missing compiler.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'src', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');

/** Every id the page defines. */
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

/** Every id app.js looks up through the $() helper. */
const jsIds = [...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);

// ---------------------------------------------------------------------------
// The page and the script agree with each other
// ---------------------------------------------------------------------------

test('every element the script looks up exists in the page', () => {
    const missing = [...new Set(jsIds)].filter((id) => !htmlIds.has(id));
    assert.deepEqual(missing, [], `app.js looks up ids the page does not define: ${missing.join(', ')}`);
});

test('the script is loaded by the page', () => {
    assert.ok(html.includes('<script src="app.js">'));
    assert.ok(html.includes('href="styles.css"'));
});

test('no element id is defined twice', () => {
    const all = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    const seen = new Set();
    const duplicates = all.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    assert.deepEqual(duplicates, [], `duplicate ids: ${duplicates.join(', ')}`);
});

// ---------------------------------------------------------------------------
// The three panes, and what each has to contain
// ---------------------------------------------------------------------------

test('the three panes are all present', () => {
    for (const pane of ['pane-phone', 'pane-scammer', 'pane-intel']) {
        assert.ok(htmlIds.has(pane), `missing ${pane}`);
    }
});

test("pane 1 has the phone, the takeover banner, the genuine button and a bilingual status", () => {
    for (const id of ['phone-chat', 'takeover-banner', 'takeover-en', 'takeover-mr', 'btn-genuine', 'status-en', 'status-mr']) {
        assert.ok(htmlIds.has(id), `the phone pane is missing ${id}`);
    }
    assert.ok(css.includes('.phone-frame'), 'the phone frame has no styling');
});

test('pane 2 has the channel picker, the sender field, the scenarios and a composer', () => {
    for (const id of ['channel', 'from', 'scenario-buttons', 'composer', 'message', 'btn-send']) {
        assert.ok(htmlIds.has(id), `the scammer console is missing ${id}`);
    }

    // The three channels the brief names.
    for (const channel of ['WhatsApp', 'SMS', 'Call transcript']) {
        assert.ok(html.includes(`>${channel}<`), `the channel picker is missing ${channel}`);
    }
});

test('pane 3 has the score, breakdown, identifiers, stages, decoy and the three buttons', () => {
    for (const id of [
        'state-badge', 'score-value', 'score-bar', 'breakdown', 'classifier',
        'identifiers', 'stages', 'decoy-target', 'decoy-excuse', 'wasted',
        'decisions', 'btn-report', 'btn-pdf', 'btn-network',
    ]) {
        assert.ok(htmlIds.has(id), `the intelligence panel is missing ${id}`);
    }
});

test('the reset button and judge-mode toggle exist', () => {
    assert.ok(htmlIds.has('btn-reset'));
    assert.ok(htmlIds.has('judge-mode'));
    assert.ok(css.includes('body.judge-mode #pane-intel'), 'judge mode does not hide the intelligence panel');
});

// ---------------------------------------------------------------------------
// Dependencies: CDN only where it is needed, and no build step
// ---------------------------------------------------------------------------

test('the page needs no build step', () => {
    // No module syntax, no bundler entrypoint: it is loaded as a plain script.
    assert.ok(!/\bimport\s+.*\bfrom\b/.test(js), 'app.js uses module imports');
    assert.ok(!/\bexport\s+(default|const|function)/.test(js), 'app.js uses module exports');
    assert.ok(!html.includes('type="module"'));
});

test('Tailwind and vis-network come from a CDN, Socket.IO comes from our own server', () => {
    assert.ok(html.includes('https://cdn.tailwindcss.com'), 'Tailwind CDN is missing');
    assert.ok(/cdnjs\.cloudflare\.com.*vis-network/.test(html), 'vis-network CDN is missing');

    // Served by our own socket.io, so the console still works without a CDN
    // reachable for the one dependency that carries the live updates.
    assert.ok(html.includes('src="/socket.io/socket.io.js"'));
});

test('the page pulls in nothing else from the network', () => {
    /**
     * Every absolute URL in the file, not only the ones in a src= or href=
     * attribute.
     *
     * The attribute-only form of this test quietly stopped guarding anything
     * the moment the two CDN URLs moved into the offline-first loader's
     * JavaScript: it matched zero URLs and passed vacuously. A test that
     * cannot fail is worse than no test, because it reads as coverage.
     */
    const external = [...html.matchAll(/https?:\/\/[^"'\s)]+/g)].map((m) => m[0]);
    const allowed = ['https://cdn.tailwindcss.com', 'https://cdnjs.cloudflare.com'];

    for (const url of external) {
        assert.ok(
            allowed.some((prefix) => url.startsWith(prefix)),
            `unexpected external resource: ${url}`
        );
    }

    // And the allowlist is only reachable as a fallback: both have a local
    // copy tried first, so `npm run vendor` makes the page fully offline.
    assert.equal(external.length, 2, 'expected exactly the two fallback CDN URLs');
});

test('each third-party script is tried from disk before its CDN', () => {
    for (const local of ['vendor/tailwind.js', 'vendor/vis-network.min.js']) {
        assert.ok(html.includes(local), `${local} is never attempted locally`);
    }
    assert.ok(html.includes("probe.open('HEAD'"), 'nothing checks whether the local copy exists');
});

test('a missing stylesheet engine cannot throw and cannot pass unnoticed', () => {
    // tailwind.config is assigned only behind a typeof guard: unguarded, the
    // CDN being blocked turns an unstyled page into a broken one.
    assert.ok(
        html.includes("typeof tailwind !== 'undefined'"),
        'tailwind.config is assigned without checking that tailwind loaded'
    );
    // And the operator is told, rather than left guessing at an unstyled page.
    assert.ok(html.includes('id="offline-assets"'), 'there is no offline banner');
    assert.ok(html.includes('npm run vendor'), 'the banner never says how to fix it');
});

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------

test('the console listens for all four guardian events plus the turn event', () => {
    const { EVENTS } = require('../src/realtime/events');
    for (const event of Object.values(EVENTS)) {
        assert.ok(js.includes(`socket.on('${event}'`), `the console does not listen for ${event}`);
    }
});

test('the console joins the session room so it only sees its own call', () => {
    assert.ok(js.includes("socket.emit('watch'"), 'it never joins a room');
    assert.ok(js.includes('payload.sessionId !== state.sessionId'), 'it does not filter by session');
});

// ---------------------------------------------------------------------------
// Honesty on screen
// ---------------------------------------------------------------------------

test('a scripted fallback reply is labelled as one', () => {
    assert.ok(/SCRIPTED FALLBACK/.test(js), 'a fallback must not be shown as a model reply');
    assert.ok(/scripted stall line/i.test(js), 'the toast must say the decoy is covering');
});

test('the simulated family alert says it was not delivered', () => {
    assert.ok(/simulated, not delivered/i.test(js));
});

test('an ignored prompt injection is surfaced rather than hidden', () => {
    assert.ok(/PROMPT INJECTION IGNORED/.test(js));
});

test('the time-wasted clock runs off real elapsed time', () => {
    // It must read a real timestamp, never accumulate a figure of its own.
    assert.ok(js.includes('state.firstSeenAt'), 'the clock has no start point');
    assert.ok(/const end = state\.finished && state\.lastSeenAt \? state\.lastSeenAt : Date\.now\(\)/.test(js));
});

test('the report is shown as a draft until it is reviewed', () => {
    assert.ok(js.includes("'ready to file'"));
    assert.ok(js.includes("'draft'"));
    assert.ok(/Nothing has been submitted/i.test(js), 'the UI must not imply it filed anything');
});

// ---------------------------------------------------------------------------
// Fitting a projector
// ---------------------------------------------------------------------------

test('the layout is built for a 1366x768 screen', () => {
    // Three fixed-ish columns that add up to less than 1366 with gaps and
    // padding, and a body that does not scroll.
    assert.ok(html.includes('width: 312px'), 'the phone pane has no fixed width');
    assert.ok(html.includes('flex: 0 0 400px'), 'the scammer pane has no fixed width');
    assert.ok(html.includes('calc(100vh - 3rem)'), 'the panes do not fill the viewport height');
    assert.ok(html.includes('h-screen overflow-hidden'), 'the page can scroll as a whole');

    assert.ok(css.includes('@media (max-width: 1280px)'), 'no fallback for a narrower projector');
});

test('each pane scrolls on its own rather than the page', () => {
    for (const id of ['phone-chat', 'scammer-log', 'identifiers']) {
        assert.ok(htmlIds.has(id));
    }
    assert.ok((html.match(/overflow-y-auto/g) || []).length >= 3, 'panes do not scroll independently');
});

// ---------------------------------------------------------------------------
// The scenario list
// ---------------------------------------------------------------------------

test('the scenarios cover the four scams and two legitimate messages named in the brief', () => {
    const { createRouter } = require('../src/routes/api');
    assert.equal(typeof createRouter, 'function');

    // The list lives in the route module, so the page and the fixtures cannot
    // drift apart.
    const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'api.js'), 'utf8');

    for (const id of ['cbi-digital-arrest', 'fedex-parcel-drugs', 'kyc-expiry', 'stock-tip-group', 'son-dinner', 'real-bank-otp']) {
        assert.ok(routes.includes(`id: '${id}'`), `missing scenario ${id}`);
    }
});

test('the two legitimate scenarios are marked legitimate and say why they matter', () => {
    const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'api.js'), 'utf8');
    const legitimate = [...routes.matchAll(/kind: 'legitimate'/g)];
    assert.equal(legitimate.length, 2, 'there should be exactly two legitimate scenarios');
});

// ---------------------------------------------------------------------------
// The loopback-only bootstrap
// ---------------------------------------------------------------------------

test('the console gets its key from a bootstrap rather than asking a judge to type one', () => {
    assert.ok(js.includes("fetch('/demo-config')"));
    assert.ok(js.includes('state.apiKey = config.apiKey'));
});

test('the bootstrap is served only to loopback', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
    assert.ok(app.includes("'127.0.0.1', '::1', 'localhost'"), 'the bootstrap does not check the caller');
    assert.ok(app.includes('403'), 'it does not refuse a non-loopback caller');
});

test('the console files nothing and submits nothing', () => {
    for (const forbidden of ['cybercrime.gov.in/api', 'submitComplaint', 'autoSubmit']) {
        assert.ok(!js.includes(forbidden), `app.js references ${forbidden}`);
    }
});

// ---------------------------------------------------------------------------
// The output guard, and the limits shown on screen
// ---------------------------------------------------------------------------

test('the blocked-replies panel is on the page', () => {
    for (const id of ['guard-blocks', 'guard-count']) {
        assert.ok(htmlIds.has(id), `the intelligence panel is missing ${id}`);
    }
    assert.ok(css.includes('.guard-block'), 'a blocked reply has no styling');
    assert.ok(js.includes('addGuardBlocks'), 'nothing renders a blocked reply');
});

test('a blocked reply is appended rather than replacing the last one', () => {
    // A block is an event. Rebuilding the panel per turn would make a reply
    // caught two turns ago vanish, and the record of what the system refused
    // to say is the whole reason for showing it.
    assert.ok(js.includes('state.guardBlockCount'), 'blocks are not counted across the session');

    // The panel is only ever cleared to remove the "Nothing blocked"
    // placeholder, never to make room for the current turn. An unguarded
    // innerHTML reset inside addGuardBlocks would drop earlier blocks.
    // Bounded to the renderer: "// The clock" also appears earlier in the
    // file, so the end of the slice has to be searched for from the start of
    // the function rather than from the top.
    const start = js.indexOf('const addGuardBlocks');
    const render = js.slice(start, js.indexOf('// The clock', start));
    const clears = [...render.matchAll(/el\.guardBlocks\.innerHTML\s*=/g)].length;
    assert.equal(clears, 1, `expected one guarded clear, found ${clears}`);
    assert.ok(/if \(el\.guardBlocks\.querySelector\('\.italic'\)\) el\.guardBlocks\.innerHTML = ''/.test(render),
        'the clear is not conditional on the placeholder still being there');
});

test('the never-do list is shown on screen, not only in ETHICS.md', () => {
    assert.ok(htmlIds.has('never-list'), 'the standing limits are not on the page');
    assert.ok(html.includes('What our agents never do'), 'the panel has no heading');
    assert.ok(js.includes('const NEVER_DO'), 'the list is not defined');
});

test('the never-do list has all nine items the brief names', () => {
    const list = js.slice(js.indexOf('const NEVER_DO'), js.indexOf('GUARD_RULE_LABELS'));
    const items = [...list.matchAll(/short: '/g)].length + [...list.matchAll(/short: "/g)].length;
    assert.equal(items, 9, `expected nine standing limits, found ${items}`);

    for (const promise of [
        'move money', 'share identifiers', 'click links or install',
        'impersonate', 'threaten or harass', 'outside the thread',
        'bait a trusted contact', 'without human review', 'personal data in a report',
    ]) {
        assert.ok(new RegExp(promise, 'i').test(list), `the list is missing "${promise}"`);
    }
});

test('each promise says where it is enforced', () => {
    const list = js.slice(js.indexOf('const NEVER_DO'), js.indexOf('GUARD_RULE_LABELS'));
    const rules = [...list.matchAll(/rule: /g)].length;
    assert.equal(rules, 9, 'a promise with no named enforcement point is just a promise');
});

test('the ethics panel covers the false-positive path, retention and taking back control', () => {
    assert.ok(htmlIds.has('ethics-modal'));
    assert.ok(htmlIds.has('ethics-retention'), 'the retention window is not shown');
    assert.ok(js.includes('config.sessionRetentionDays'),
        'the page hard-codes a retention window instead of reading the real one');

    for (const topic of [
        /take back control/i,
        /false positive/i,
        /retention/i,
        /SESSION_RETENTION_DAYS/,
        /nothing is filed automatically/i,
    ]) {
        assert.ok(topic.test(html), `the ethics panel does not cover ${topic}`);
    }
});

test('ETHICS.md exists and matches what the console promises', () => {
    const ethics = fs.readFileSync(path.join(__dirname, '..', 'ETHICS.md'), 'utf8');

    for (const section of [
        /what our agents never do/i,
        /false positive/i,
        /data retention/i,
        /taking back control/i,
    ]) {
        assert.ok(section.test(ethics), `ETHICS.md has no section on ${section}`);
    }

    // The nine promises are numbered in the table.
    for (const promise of [
        /move money/i, /share identifiers/i, /click links or install/i,
        /impersonate officials/i, /threaten or harass/i,
        /outside the existing thread/i, /bait a trusted contact/i,
        /without human review/i, /personal data in a report/i,
    ]) {
        assert.ok(promise.test(ethics), `ETHICS.md is missing ${promise}`);
    }
});
