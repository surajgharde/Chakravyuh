/**
 * Renders a report as a printable HTML page or a PDF.
 *
 * Both read the same report object the API serves, so the three formats cannot
 * drift apart. Neither renderer computes anything: if a number is not in the
 * report, it is not on the page.
 *
 * Until a family member has ticked that they have read it, both formats are
 * stamped DRAFT and say plainly that the report is not ready to file.
 */

const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const rupees = (value) => (value === null || value === undefined
    ? '-'
    : `Rs ${Number(value).toLocaleString('en-IN')}`);

const when = (value) => (value ? String(value).replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : '-');

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const STYLE = `
:root {
  --ink: #1a1a1a; --muted: #5c5c5c; --line: #d8d4cd; --bg: #ffffff;
  --accent: #8c2f14; --flag: #fff4e8; --ok: #1f6f43;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 13px/1.55 "Segoe UI", system-ui, -apple-system, sans-serif;
  padding-block: 28px; padding-left: 20px; padding-right: 20px;
}
main { max-width: 820px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 2px; letter-spacing: -0.01em; }
h2 {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.09em;
  color: var(--muted); margin: 26px 0 8px; padding-bottom: 4px;
  border-bottom: 1px solid var(--line); font-weight: 700;
}
.sub { color: var(--muted); margin: 0 0 18px; font-size: 12px; }
table { width: 100%; border-collapse: collapse; margin: 0 0 6px; font-size: 12px; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-weight: 700; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
code, .mono { font-family: "Cascadia Mono", Consolas, monospace; font-size: 11.5px; }
.kv { display: grid; grid-template-columns: 180px 1fr; gap: 2px 14px; font-size: 12px; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; }
.draft {
  background: var(--flag); border: 1px solid var(--accent); color: var(--accent);
  padding: 10px 14px; margin: 0 0 18px; font-weight: 700; font-size: 12px;
}
.ready { background: #eef7f1; border: 1px solid var(--ok); color: var(--ok); }
.quote { color: var(--muted); font-style: italic; }
ol { padding-left: 18px; margin: 0; }
li { margin-bottom: 7px; }
.hash { word-break: break-all; background: #f5f3f0; padding: 7px 9px; border: 1px solid var(--line); }
.review { border: 1px solid var(--line); padding: 12px 14px; margin-top: 10px; }
.review label { display: flex; gap: 9px; align-items: flex-start; font-size: 12px; }
.pill {
  display: inline-block; padding: 1px 7px; border: 1px solid var(--line);
  border-radius: 9px; font-size: 11px; color: var(--muted);
}
.transcript { font-size: 12px; }
.transcript tr.decoy td { background: #fafaf8; }
footer { margin-top: 30px; padding-top: 10px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; }
@media print {
  body { padding: 0; font-size: 11.5px; }
  h2 { page-break-after: avoid; }
  table, .review { page-break-inside: auto; }
  tr { page-break-inside: avoid; }
}
@media (max-width: 560px) {
  .kv { grid-template-columns: 1fr; }
  .kv dt { margin-top: 6px; font-weight: 600; }
}
`;

const table = (headers, rows) => {
    if (rows.length === 0) return '<p class="quote">Nothing recorded.</p>';
    return `<table>
<thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
<tbody>${rows.map((row) => `<tr>${row.join('')}</tr>`).join('')}</tbody>
</table>`;
};

const td = (value, cls = '') => `<td${cls ? ` class="${cls}"` : ''}>${escapeHtml(value ?? '-')}</td>`;

/** The printable page. Self-contained: no external CSS, fonts or scripts. */
const toHtml = (report) => {
    const reviewed = report.review.reviewedByFamily;

    const banner = reviewed
        ? `<div class="draft ready">READY TO FILE &mdash; reviewed by ${escapeHtml(report.review.reviewedBy || 'a family member')} on ${when(report.review.reviewedAt)}</div>`
        : '<div class="draft">DRAFT &mdash; NOT READY TO FILE. A family member must read this report and confirm before it is filed. Nothing has been submitted anywhere.</div>';

    const identifiers = table(
        ['Type', 'Value', 'First seen', 'Times said', 'What was said'],
        report.suspectIdentifiers.map((row) => [
            td(row.label),
            `<td class="mono">${escapeHtml(row.value)}</td>`,
            td(when(row.firstSeenAt)),
            td(row.timesRepeated, 'num'),
            `<td class="quote">&ldquo;${escapeHtml(row.excerpt)}&rdquo;</td>`,
        ])
    );

    const amounts = table(
        ['Amount', 'As said', 'First seen', 'Times said'],
        report.moneyDemanded.amounts.map((row) => [
            td(rupees(row.rupees), 'num'),
            `<td class="mono">${escapeHtml(row.asWritten)}</td>`,
            td(when(row.firstSeenAt)),
            td(row.timesRepeated, 'num'),
        ])
    );

    const stageRows = table(
        ['#', 'Stage', 'First seen', 'Example'],
        report.scriptStages.map((row, index) => [
            td(index + 1, 'num'),
            td(row.stage),
            td(when(row.firstSeenAt)),
            `<td class="quote">&ldquo;${escapeHtml(row.example)}&rdquo;</td>`,
        ])
    );

    const decisions = table(
        ['Time', 'Msg', 'Score', 'State', 'Signals'],
        report.guardianDecisionLog.map((row) => [
            td(when(row.at)),
            td(row.messageId),
            td(row.score, 'num'),
            td(row.stateChanged ? `${row.previousState} -> ${row.state}` : row.state),
            `<td class="mono">${escapeHtml((row.firedSignals || []).join(', ') || '-')}</td>`,
        ])
    );

    const transcript = table(
        ['Time', 'Who', 'Message'],
        report.transcript.map((line) => [
            `<td>${escapeHtml(when(line.at))}</td>`,
            `<td>${escapeHtml(line.speaker)}</td>`,
            `<td>${escapeHtml(line.text)}</td>`,
        ])
    ).replace('<table>', '<table class="transcript">');

    const portal = report.forCybercrimePortal;
    const portalRows = [
        ['Incident date', portal.incidentDate],
        ['Incident time', portal.incidentTime],
        ['Category', portal.category],
        ['Where it happened', portal.whereDidItHappen],
        ['Suspect mobile number(s)', (portal.suspectMobileNumbers || []).join(', ')],
        ['Suspect UPI ID(s)', (portal.suspectUpiIds || []).join(', ')],
        ['Suspect bank account(s)', (portal.suspectBankAccounts || []).join(', ')],
        ['Suspect IFSC code(s)', (portal.suspectIfscCodes || []).join(', ')],
        ['Suspect website(s)', (portal.suspectWebsites || []).join(', ')],
        ['Amount involved', rupees(portal.amountInvolved)],
        ['Amount lost', `${rupees(portal.amountLost)} — ${portal.amountLostNote}`],
    ];

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Evidence report ${escapeHtml(report.reportId)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>Scam call evidence report</h1>
  <p class="sub">
    ${escapeHtml(report.reportId)} &middot; generated ${when(report.generatedAt)} &middot;
    <span class="pill">${escapeHtml(report.classification.category)}</span>
  </p>

  ${banner}

  <h2>Summary</h2>
  <p>${escapeHtml(report.agentNotes)}</p>

  <h2>The call</h2>
  <dl class="kv">
    <dt>Protected user</dt><dd>${escapeHtml(report.protectedUser.alias)}</dd>
    <dt>Channel</dt><dd>${escapeHtml(report.session.channel)}</dd>
    <dt>Started</dt><dd>${when(report.session.startedAt)}</dd>
    <dt>Ended</dt><dd>${when(report.session.endedAt)}</dd>
    <dt>Duration</dt><dd>${escapeHtml(report.session.durationHuman)} (${report.session.durationSeconds}s, measured)</dd>
    <dt>Messages</dt><dd>${report.session.messageCounts.total} total &middot; ${report.session.messageCounts.fromCaller} from the caller &middot; ${report.session.messageCounts.fromDecoy} from the decoy</dd>
    <dt>Category</dt><dd>${escapeHtml(report.classification.category)}</dd>
    <dt>Impersonated</dt><dd>${escapeHtml(report.classification.authoritiesImpersonated.map((a) => a.authority).join(', ') || 'none claimed')}</dd>
    <dt>Payment requested by</dt><dd>${escapeHtml(report.paymentChannelsRequested.map((c) => c.label).join(', ') || 'none requested')}</dd>
  </dl>

  <h2>Suspect identifiers</h2>
  ${identifiers}

  <h2>Money demanded</h2>
  ${amounts}

  <h2>Script, in the order it was used</h2>
  ${stageRows}

  <h2>What to do now</h2>
  <ol>
    ${report.recommendedActions.map((a) => `<li><strong>${escapeHtml(a.action)}.</strong> ${escapeHtml(a.detail)}</li>`).join('')}
  </ol>

  <h2>For cybercrime.gov.in</h2>
  <p class="sub">${escapeHtml(portal.note)}</p>
  <dl class="kv">
    ${portalRows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v || '-')}</dd>`).join('')}
    <dt>Description</dt><dd>${escapeHtml(portal.description)}</dd>
  </dl>

  <h2>Guardian decision log</h2>
  ${decisions}

  <h2>Transcript</h2>
  ${transcript}

  <h2>Integrity</h2>
  <p class="sub">${escapeHtml(report.transcriptHash.note)}</p>
  <div class="hash mono">SHA-256: ${escapeHtml(report.transcriptHash.value)}</div>

  <h2>Review before filing</h2>
  <div class="review">
    <label>
      <input type="checkbox" ${reviewed ? 'checked disabled' : 'disabled'}>
      <span>
        <strong>Reviewed by family member.</strong>
        ${reviewed
        ? `Confirmed by ${escapeHtml(report.review.reviewedBy || 'a family member')} on ${when(report.review.reviewedAt)}.`
        : 'Not yet confirmed. Tick this in the dashboard to mark the report ready to file.'}
      </span>
    </label>
  </div>

  <footer>
    ${escapeHtml(report.disclosure.note)}
    Report version ${report.reportVersion}.
  </footer>
</main>
</body>
</html>`;
};

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const PDF_MARGIN = 48;

/**
 * Renders the report to a PDF buffer.
 *
 * pdfkit builds the document in-process, so there is no headless browser and no
 * network access involved in producing a file.
 */
const toPdf = (report) => new Promise((resolve, reject) => {
    let PDFDocument;
    try {
        PDFDocument = require('pdfkit');
    } catch (error) {
        reject(new Error(`PDF generation needs pdfkit: ${error.message}`));
        return;
    }

    const doc = new PDFDocument({
        size: 'A4',
        margin: PDF_MARGIN,
        info: {
            Title: `Scam call evidence report ${report.reportId}`,
            Author: 'Chakravyuh',
            Subject: report.classification.category,
            Keywords: 'cyber fraud, evidence, 1930',
        },
    });

    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const width = doc.page.width - PDF_MARGIN * 2;
    const reviewed = report.review.reviewedByFamily;

    const heading = (text) => {
        if (doc.y > doc.page.height - 120) doc.addPage();
        doc.moveDown(0.8);
        doc.fontSize(8.5).fillColor('#5c5c5c').font('Helvetica-Bold').text(text.toUpperCase(), { characterSpacing: 0.7 });
        doc.moveTo(PDF_MARGIN, doc.y + 1).lineTo(PDF_MARGIN + width, doc.y + 1).strokeColor('#d8d4cd').lineWidth(0.5).stroke();
        doc.moveDown(0.5);
        doc.fontSize(9.5).fillColor('#1a1a1a').font('Helvetica');
    };

    const field = (label, value) => {
        if (doc.y > doc.page.height - 80) doc.addPage();
        doc.fontSize(9).fillColor('#5c5c5c').font('Helvetica').text(`${label}  `, { continued: true });
        doc.fillColor('#1a1a1a').text(String(value ?? '-'));
    };

    const bullet = (text) => {
        if (doc.y > doc.page.height - 80) doc.addPage();
        doc.fontSize(9).fillColor('#1a1a1a').text(`•  ${text}`, { indent: 4, align: 'left' });
        doc.moveDown(0.15);
    };

    // --- title ---
    doc.fontSize(16).fillColor('#1a1a1a').font('Helvetica-Bold').text('Scam call evidence report');
    doc.fontSize(9).fillColor('#5c5c5c').font('Helvetica')
        .text(`${report.reportId}  ·  generated ${when(report.generatedAt)}  ·  ${report.classification.category}`);
    doc.moveDown(0.7);

    // --- the draft / ready stamp ---
    const stampText = reviewed
        ? `READY TO FILE — reviewed by ${report.review.reviewedBy || 'a family member'} on ${when(report.review.reviewedAt)}`
        : 'DRAFT — NOT READY TO FILE. A family member must read and confirm this report. Nothing has been submitted anywhere.';
    const stampColor = reviewed ? '#1f6f43' : '#8c2f14';
    const stampFill = reviewed ? '#eef7f1' : '#fff4e8';

    const stampHeight = doc.heightOfString(stampText, { width: width - 16 }) + 14;
    doc.rect(PDF_MARGIN, doc.y, width, stampHeight).fillAndStroke(stampFill, stampColor);
    doc.fillColor(stampColor).fontSize(8.5).font('Helvetica-Bold')
        .text(stampText, PDF_MARGIN + 8, doc.y + 7, { width: width - 16 });
    doc.moveDown(1.2);
    doc.font('Helvetica').fillColor('#1a1a1a');

    // --- summary ---
    heading('Summary');
    doc.fontSize(9.5).text(report.agentNotes, { width, align: 'left' });

    // --- the call ---
    heading('The call');
    field('Protected user', report.protectedUser.alias);
    field('Channel', report.session.channel);
    field('Started', when(report.session.startedAt));
    field('Ended', when(report.session.endedAt));
    field('Duration', `${report.session.durationHuman} (${report.session.durationSeconds}s, measured)`);
    field('Messages', `${report.session.messageCounts.total} total, `
        + `${report.session.messageCounts.fromCaller} from the caller, `
        + `${report.session.messageCounts.fromDecoy} from the decoy`);
    field('Impersonated', report.classification.authoritiesImpersonated.map((a) => a.authority).join(', ') || 'none claimed');
    field('Payment requested by', report.paymentChannelsRequested.map((c) => c.label).join(', ') || 'none requested');

    // --- identifiers ---
    heading('Suspect identifiers');
    if (report.suspectIdentifiers.length === 0) {
        doc.fontSize(9).fillColor('#5c5c5c').text('Nothing recorded.');
    } else {
        for (const row of report.suspectIdentifiers) {
            if (doc.y > doc.page.height - 110) doc.addPage();
            doc.fontSize(9).fillColor('#1a1a1a').font('Helvetica-Bold').text(`${row.label}: ${row.value}`);
            doc.font('Helvetica').fontSize(8.5).fillColor('#5c5c5c')
                .text(`first seen ${when(row.firstSeenAt)} in ${row.firstSeenInMessage}, said ${row.timesRepeated} time(s)`);
            doc.fontSize(8.5).fillColor('#3a3a3a').text(`“${row.excerpt}”`, { width, indent: 6 });
            doc.moveDown(0.35);
        }
    }

    // --- money ---
    heading('Money demanded');
    if (report.moneyDemanded.amounts.length === 0) {
        doc.fontSize(9).fillColor('#5c5c5c').text('No amount was named.');
    } else {
        for (const amount of report.moneyDemanded.amounts) {
            bullet(`${rupees(amount.rupees)} — said as “${amount.asWritten}”, ${amount.timesRepeated} time(s)`);
        }
    }

    // --- script ---
    heading('Script, in the order it was used');
    report.scriptStages.forEach((stage, index) => {
        if (doc.y > doc.page.height - 100) doc.addPage();
        doc.fontSize(9).fillColor('#1a1a1a').font('Helvetica-Bold').text(`${index + 1}. ${stage.stage}`);
        doc.font('Helvetica').fontSize(8.5).fillColor('#3a3a3a').text(`“${stage.example}”`, { width, indent: 6 });
        doc.moveDown(0.3);
    });

    // --- actions ---
    heading('What to do now');
    for (const action of report.recommendedActions) bullet(`${action.action}. ${action.detail}`);

    // --- portal ---
    doc.addPage();
    heading('For cybercrime.gov.in');
    doc.fontSize(8.5).fillColor('#5c5c5c').text(report.forCybercrimePortal.note, { width });
    doc.moveDown(0.4);
    const portal = report.forCybercrimePortal;
    field('Incident date', portal.incidentDate);
    field('Incident time', portal.incidentTime);
    field('Category', portal.category);
    field('Where it happened', portal.whereDidItHappen);
    field('Suspect mobile', (portal.suspectMobileNumbers || []).join(', ') || '-');
    field('Suspect UPI', (portal.suspectUpiIds || []).join(', ') || '-');
    field('Suspect account', (portal.suspectBankAccounts || []).join(', ') || '-');
    field('Suspect IFSC', (portal.suspectIfscCodes || []).join(', ') || '-');
    field('Suspect website', (portal.suspectWebsites || []).join(', ') || '-');
    field('Amount involved', rupees(portal.amountInvolved));
    field('Amount lost', `${rupees(portal.amountLost)} — ${portal.amountLostNote}`);
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor('#5c5c5c').text('Description');
    doc.fontSize(9).fillColor('#1a1a1a').text(portal.description, { width });

    // --- guardian log ---
    heading('Guardian decision log');
    for (const entry of report.guardianDecisionLog) {
        if (doc.y > doc.page.height - 90) doc.addPage();
        const transition = entry.stateChanged ? `${entry.previousState} -> ${entry.state}` : entry.state;
        doc.fontSize(8.5).fillColor('#1a1a1a')
            .text(`${when(entry.at)}  ${entry.messageId}  score ${entry.score}  ${transition}`);
        if ((entry.firedSignals || []).length > 0) {
            doc.fontSize(8).fillColor('#5c5c5c').text(`   ${entry.firedSignals.join(', ')}`, { width });
        }
    }

    // --- transcript ---
    doc.addPage();
    heading('Transcript');
    for (const line of report.transcript) {
        if (doc.y > doc.page.height - 90) doc.addPage();
        doc.fontSize(8).fillColor('#5c5c5c').text(`${when(line.at)}  ${line.speaker}`);
        doc.fontSize(9).fillColor('#1a1a1a').text(line.text, { width, indent: 6 });
        doc.moveDown(0.3);
    }

    // --- integrity ---
    heading('Integrity');
    doc.fontSize(8.5).fillColor('#5c5c5c').text(report.transcriptHash.note, { width });
    doc.moveDown(0.3);
    doc.fontSize(8.5).fillColor('#1a1a1a').font('Courier')
        .text(`SHA-256: ${report.transcriptHash.value}`, { width });
    doc.font('Helvetica');

    // --- review ---
    heading('Review before filing');
    doc.fontSize(9).fillColor('#1a1a1a').text(
        reviewed
            ? `[x] Reviewed by family member — ${report.review.reviewedBy || 'a family member'}, ${when(report.review.reviewedAt)}.`
            : '[ ] Reviewed by family member — not yet confirmed. This report is a draft.',
        { width }
    );
    doc.moveDown(0.4);
    doc.fontSize(8).fillColor('#5c5c5c').text(report.disclosure.note, { width });

    doc.end();
});

module.exports = { toHtml, toPdf, escapeHtml };
