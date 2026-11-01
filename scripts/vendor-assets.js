#!/usr/bin/env node
/**
 * `npm run vendor` — download the console's two third-party scripts into
 * src/public/vendor/ so the page works with no network at all.
 *
 * WHY THIS EXISTS
 *
 * The console loads Tailwind's play CDN and vis-network from cdnjs. That is
 * the right default for a clone that should run on `npm start` with no build
 * step, and it is fine on a working connection. It is wrong in the one
 * situation the rest of this project is built around: a demo on conference
 * Wi-Fi. FAKE_LLM=1 already removes the model from the critical path, and it
 * would be a poor joke to have solved that and then show an unstyled page
 * because a stylesheet host was unreachable.
 *
 * So the page prefers a vendored copy and falls back to the CDN (see the
 * loader in src/public/index.html). This script is what puts the vendored copy
 * there. Run it ONCE, while you still have a connection:
 *
 *     npm run vendor
 *
 * After that the console is fully offline: its own HTML, CSS and JS, the
 * Socket.IO client the server already serves itself, and these two files.
 *
 * The directory is git-ignored. Third-party bundles do not belong in this
 * repository's history, and re-running this is cheaper than carrying 2 MB of
 * someone else's minified output.
 *
 * Nothing here is required. Skip it and the page behaves exactly as before.
 */

const fs = require('node:fs');
const path = require('node:path');

const VENDOR_DIR = path.join(__dirname, '..', 'src', 'public', 'vendor');

/**
 * Pinned by exact version, matching what index.html names in its CDN
 * fallback. An unpinned "latest" would mean the offline copy and the online
 * copy could differ, and then a bug that only reproduces on bad Wi-Fi.
 */
const ASSETS = [
    {
        file: 'tailwind.js',
        url: 'https://cdn.tailwindcss.com/3.4.16',
        minBytes: 100_000,
        note: 'Tailwind play CDN (JIT compiler, runs in the browser)',
    },
    {
        file: 'vis-network.min.js',
        url: 'https://cdnjs.cloudflare.com/ajax/libs/vis-network/9.1.9/dist/vis-network.min.js',
        minBytes: 200_000,
        note: 'vis-network 9.1.9, for the identifier graph',
    },
];

/** Downloads one asset, or throws with a message that says what to do. */
const fetchAsset = async (asset) => {
    const target = path.join(VENDOR_DIR, asset.file);

    const response = await fetch(asset.url, { redirect: 'follow' });
    if (!response.ok) {
        throw new Error(`${asset.url} returned ${response.status} ${response.statusText}`);
    }

    const body = Buffer.from(await response.arrayBuffer());

    /**
     * A captive portal answers 200 with its own login page, which would
     * otherwise be written to disk as "tailwind.js" and fail silently at the
     * only moment it matters. A size floor catches that: the real files are
     * hundreds of kilobytes and a portal page is a few.
     */
    if (body.length < asset.minBytes) {
        throw new Error(
            `${asset.url} returned only ${body.length} bytes, which is far too small. `
            + 'A captive portal or proxy has most likely answered instead of the CDN.'
        );
    }

    fs.writeFileSync(target, body);
    return { target, bytes: body.length };
};

const main = async () => {
    fs.mkdirSync(VENDOR_DIR, { recursive: true });

    console.log('\n  Vendoring the console\'s third-party scripts for offline use.\n');

    let failed = 0;

    for (const asset of ASSETS) {
        process.stdout.write(`  ${asset.file.padEnd(22)} `);
        try {
            const { bytes } = await fetchAsset(asset);
            console.log(`ok  ${(bytes / 1024).toFixed(0)} KB  — ${asset.note}`);
        } catch (error) {
            failed += 1;
            console.log(`FAILED  ${error.message}`);
        }
    }

    if (failed > 0) {
        console.error(
            `\n  ${failed} of ${ASSETS.length} could not be downloaded. The console still works:`
            + '\n  it falls back to the CDN for anything not vendored. Re-run this on a'
            + '\n  better connection before demoing offline.\n'
        );
        process.exit(1);
    }

    console.log(
        '\n  Done. The console now loads these from disk and never touches a CDN.'
        + '\n  Verify with:  curl -s localhost:8080/vendor/tailwind.js | head -c 40\n'
    );
};

main().catch((error) => {
    console.error(`\n  Vendoring failed: ${error.message}\n`);
    process.exit(1);
});
