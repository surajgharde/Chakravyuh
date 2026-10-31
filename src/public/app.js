/**
 * The demo console.
 *
 * Plain JavaScript, no build step. It talks to the API over fetch and listens
 * on Socket.IO, so every pane updates live without a refresh.
 *
 * Two screens: open the page normally for the operator view, and
 * `?view=intel` on a second screen for the intelligence panel on its own.
 * Both stay live off the same socket events.
 */

(() => {
    'use strict';

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    const state = {
        apiKey: null,
        sessionId: null,
        userId: 'demo-user',
        scenario: null,
        followUpIndex: 0,
        // The clock the "time wasted" counter runs off. Set from the first
        // message's receive time, so it is real elapsed time, not a guess.
        firstSeenAt: null,
        lastSeenAt: null,
        engaged: false,
        finished: false,
        seenIdentifiers: new Set(),
        scenarios: [],
    };

    const $ = (id) => document.getElementById(id);

    const el = {
        sessionId: $('session-id'),
        connDot: $('conn-dot'),
        connLabel: $('conn-label'),
        llmBadge: $('llm-badge'),
        demoBadge: $('demo-badge'),
        judgeMode: $('judge-mode'),
        btnReset: $('btn-reset'),

        phoneCaller: $('phone-caller'),
        phoneChannel: $('phone-channel'),
        phoneClock: $('phone-clock'),
        takeoverBanner: $('takeover-banner'),
        takeoverEn: $('takeover-en'),
        takeoverMr: $('takeover-mr'),
        phoneAlerts: $('phone-alerts'),
        phoneChat: $('phone-chat'),
        statusEn: $('status-en'),
        statusMr: $('status-mr'),
        btnGenuine: $('btn-genuine'),

        scenarioButtons: $('scenario-buttons'),
        scenarioNote: $('scenario-note'),
        channel: $('channel'),
        from: $('from'),
        scammerLog: $('scammer-log'),
        composer: $('composer'),
        message: $('message'),
        btnSend: $('btn-send'),
        btnNext: $('btn-next'),
        sendState: $('send-state'),

        stateBadge: $('state-badge'),
        scoreBar: $('score-bar'),
        scoreMark: $('score-mark'),
        scoreValue: $('score-value'),
        classifier: $('classifier'),
        wasted: $('wasted'),
        breakdown: $('breakdown'),
        identifiers: $('identifiers'),
        identifierCount: $('identifier-count'),
        stages: $('stages'),
        decoyTarget: $('decoy-target'),
        decoyExcuse: $('decoy-excuse'),
        decoyLanguage: $('decoy-language'),
        decoySource: $('decoy-source'),
        decoyFlags: $('decoy-flags'),
        decisions: $('decisions'),
        thDecoy: $('th-decoy'),
        thSusp: $('th-susp'),

        btnReport: $('btn-report'),
        btnPdf: $('btn-pdf'),
        btnNetwork: $('btn-network'),

        networkModal: $('network-modal'),
        networkCanvas: $('network-canvas'),
        networkStats: $('network-stats'),
        networkClusters: $('network-clusters'),
        btnNetworkClose: $('btn-network-close'),

        reportModal: $('report-modal'),
        reportFrame: $('report-frame'),
        reportStatus: $('report-status'),
        reviewed: $('reviewed'),
        btnReportClose: $('btn-report-close'),

        toasts: $('toasts'),
    };

    // ---------------------------------------------------------------------
    // Small helpers
    // ---------------------------------------------------------------------

    const STATE_STYLE = {
        MONITORING: 'border-line text-muted bg-paper',
        SUSPICIOUS: 'border-amber text-amber bg-amber/10',
        DECOY_ACTIVE: 'border-moss text-moss bg-moss/10',
        ENDED: 'border-line text-muted bg-paper',
        LEGIT: 'border-moss text-moss bg-moss/10',
        FALSE_POSITIVE: 'border-brick text-brick bg-brick/10',
    };

    const STATUS_TEXT = {
        MONITORING: {
            en: 'Guardian is watching this conversation.',
            mr: 'गार्डियन हे संभाषण पाहत आहे.',
        },
        SUSPICIOUS: {
            en: 'This looks suspicious. Do not share any OTP, PIN or bank details.',
            mr: 'हे संशयास्पद वाटते. कोणताही ओटीपी, पिन किंवा बँक तपशील देऊ नका.',
        },
        DECOY_ACTIVE: {
            en: 'Guardian is handling this. You do not need to do anything.',
            mr: 'गार्डियन हे सांभाळत आहे. तुम्हाला काहीही करण्याची गरज नाही.',
        },
        ENDED: {
            en: 'The call has finished. A report is ready for your family.',
            mr: 'कॉल संपला आहे. तुमच्या कुटुंबासाठी अहवाल तयार आहे.',
        },
        LEGIT: {
            en: 'This caller looks genuine. Guardian has stepped back.',
            mr: 'हा कॉल खरा वाटतो. गार्डियन मागे हटले आहे.',
        },
        FALSE_POSITIVE: {
            en: 'You said this caller is genuine. Guardian has stopped.',
            mr: 'तुम्ही सांगितले की हा कॉल खरा आहे. गार्डियन थांबले आहे.',
        },
    };

    const ALARMING_STAGES = ['ACCUSATION', 'THREAT', 'ISOLATION', 'CREDENTIAL_REQUEST', 'VERIFICATION_LURE'];

    const TARGET_LABELS = {
        upiId: 'UPI ID',
        bankAccount: 'account + IFSC',
        phone: 'phone number',
        caseRef: 'case / FIR number',
        callerName: 'their name',
        officeAddress: 'office address',
        officerId: 'officer ID',
        none: 'nothing (keeping them talking)',
    };

    const IDENTIFIER_LABELS = {
        phoneNumbers: 'phone',
        upiIds: 'UPI ID',
        bankAccounts: 'account',
        ifscCodes: 'IFSC',
        cryptoWallets: 'wallet',
        phishingLinks: 'link',
        apkLinks: 'APK',
        emailAddresses: 'email',
        caseRefs: 'case ref',
        amountsDemanded: 'amount',
        impersonatedAuthorities: 'claims to be',
        aadhaarNumbers: 'Aadhaar',
        panNumbers: 'PAN',
    };

    const mmss = (totalSeconds) => {
        const safe = Math.max(0, Math.floor(totalSeconds));
        const m = String(Math.floor(safe / 60)).padStart(2, '0');
        const s = String(safe % 60).padStart(2, '0');
        return `${m}:${s}`;
    };

    const newSessionId = () => `demo-${Date.now().toString(36)}`;

    const toast = (message, kind = 'warn', ttl = 6000) => {
        const node = document.createElement('div');
        node.className = `toast toast-${kind}`;
        node.textContent = message;
        el.toasts.append(node);
        setTimeout(() => {
            node.style.transition = 'opacity .3s';
            node.style.opacity = '0';
            setTimeout(() => node.remove(), 300);
        }, ttl);
    };

    const api = async (path, options = {}) => {
        const response = await fetch(path, {
            ...options,
            headers: {
                'content-type': 'application/json',
                'x-api-key': state.apiKey,
                ...(options.headers || {}),
            },
        });
        if (!response.ok && response.status !== 409) {
            let detail = `${response.status}`;
            try {
                detail = (await response.json()).error || detail;
            } catch { /* keep the status */ }
            throw new Error(detail);
        }
        return response;
    };

    // ---------------------------------------------------------------------
    // The phone pane
    // ---------------------------------------------------------------------

    const addPhoneBubble = (text, who, meta) => {
        const wrap = document.createElement('div');
        wrap.className = 'flex flex-col';

        const bubble = document.createElement('div');
        bubble.className = `bubble ${who === 'them' ? 'bubble-them' : 'bubble-us bubble-decoy'}`;
        bubble.textContent = text;
        wrap.append(bubble);

        if (meta) {
            const line = document.createElement('div');
            line.className = `bubble-meta ${who === 'them' ? '' : 'justify-end'}`;
            line.textContent = meta;
            wrap.append(line);
        }

        el.phoneChat.append(wrap);
        el.phoneChat.scrollTop = el.phoneChat.scrollHeight;
    };

    const renderAlerts = (alerts) => {
        el.phoneAlerts.innerHTML = '';
        for (const alert of alerts || []) {
            if (alert.audience !== 'user') continue;
            if (alert.kind === 'takeover_notice') continue; // shown as the banner

            const node = document.createElement('div');
            node.className = `phone-alert phone-alert-${alert.severity === 'warning' ? 'warn' : 'info'}`;
            node.innerHTML = '';
            const en = document.createElement('div');
            en.className = 'font-semibold';
            en.textContent = alert.text.en;
            const mr = document.createElement('div');
            mr.className = 'opacity-80 mt-0.5';
            mr.textContent = alert.text.mr;
            node.append(en, mr);
            el.phoneAlerts.append(node);
        }

        // A family alert is simulated. Say so, rather than implying a message
        // was actually delivered to anybody.
        const family = (alerts || []).find((a) => a.audience === 'family');
        if (family) toast(`Family alert (simulated, not delivered): ${family.text.en}`, 'warn', 7000);
    };

    const setStatus = (guardianState) => {
        const text = STATUS_TEXT[guardianState] || STATUS_TEXT.MONITORING;
        el.statusEn.textContent = text.en;
        el.statusMr.textContent = text.mr;
    };

    const showTakeover = (notice) => {
        if (!notice) {
            el.takeoverBanner.classList.add('hidden');
            return;
        }
        el.takeoverEn.textContent = notice.en;
        el.takeoverMr.textContent = notice.mr;
        el.takeoverBanner.classList.remove('hidden');
    };

    // ---------------------------------------------------------------------
    // The intelligence pane
    // ---------------------------------------------------------------------

    const renderState = (guardianState) => {
        el.stateBadge.textContent = guardianState;
        el.stateBadge.className = `mt-0.5 inline-block text-[12px] font-bold px-2 py-1 rounded border ${
            STATE_STYLE[guardianState] || STATE_STYLE.MONITORING}`;
    };

    const renderScore = (score, breakdown, classifier, thresholds) => {
        el.scoreValue.textContent = score;
        el.scoreBar.style.width = `${Math.min(100, score)}%`;

        const engageAt = (thresholds && thresholds.decoy) || 60;
        const warnAt = (thresholds && thresholds.suspicious) || 30;
        el.thDecoy.textContent = engageAt;
        el.thSusp.textContent = warnAt;
        el.scoreMark.style.left = `${engageAt}%`;

        el.scoreBar.classList.remove('bg-amber', 'bg-brick', 'bg-moss');
        if (score >= engageAt) el.scoreBar.classList.add('bg-brick');
        else if (score >= warnAt) el.scoreBar.classList.add('bg-amber');
        else el.scoreBar.classList.add('bg-moss');

        if (classifier) {
            const reasons = (classifier.reasons || []).join('; ');
            el.classifier.textContent = `classifier: ${classifier.label}${reasons ? ` — ${reasons}` : ''}`;
        }

        el.breakdown.innerHTML = '';
        if (!breakdown || breakdown.length === 0) {
            el.breakdown.innerHTML = '<div class="text-[10.5px] text-muted italic">No signals fired.</div>';
            return;
        }

        for (const line of breakdown) {
            const row = document.createElement('div');
            row.className = 'signal-row';

            const weight = document.createElement('span');
            weight.className = `signal-weight ${
                line.weight < 0 ? 'signal-minus' : (line.hard ? 'signal-hard' : 'signal-soft')}`;
            weight.textContent = line.weight > 0 ? `+${line.weight}` : `${line.weight}`;

            const label = document.createElement('span');
            label.textContent = line.label || line.id;
            if (line.hard) label.className = 'font-semibold';

            const why = document.createElement('span');
            why.className = 'text-muted truncate';
            why.textContent = line.description ? `— ${line.description}` : '';

            row.append(weight, label, why);
            el.breakdown.append(row);
        }
    };

    const renderIdentifiers = (intelligence) => {
        const rows = [];
        for (const [field, values] of Object.entries(intelligence || {})) {
            if (!Array.isArray(values) || values.length === 0) continue;
            if (field === 'suspiciousKeywords') continue;
            for (const value of values) {
                rows.push({ field, value, key: `${field}:${value}` });
            }
        }

        el.identifierCount.textContent = rows.length;

        if (rows.length === 0) {
            el.identifiers.innerHTML = '<div class="text-[11px] text-muted italic">Nothing yet.</div>';
            return;
        }

        el.identifiers.innerHTML = '';
        for (const row of rows) {
            const node = document.createElement('div');
            // Only animate what has not been shown before, so the panel does
            // not flash its whole contents on every turn.
            node.className = state.seenIdentifiers.has(row.key) ? 'ident-row' : 'ident-row';
            if (state.seenIdentifiers.has(row.key)) node.style.animation = 'none';
            state.seenIdentifiers.add(row.key);

            const type = document.createElement('span');
            type.className = 'ident-type';
            type.textContent = IDENTIFIER_LABELS[row.field] || row.field;

            const value = document.createElement('span');
            value.className = 'ident-value';
            value.textContent = typeof row.value === 'number'
                ? `Rs ${row.value.toLocaleString('en-IN')}`
                : row.value;

            node.append(type, value);
            el.identifiers.append(node);
        }
    };

    const renderStages = (sessionStages) => {
        if (!sessionStages || sessionStages.length === 0) {
            el.stages.innerHTML = '<div class="text-[11px] text-muted italic">Nothing yet.</div>';
            return;
        }

        el.stages.innerHTML = '';
        sessionStages.forEach((stage, index) => {
            const chip = document.createElement('span');
            chip.className = `stage-chip${ALARMING_STAGES.includes(stage) ? ' alarming' : ''}`;
            chip.textContent = `${index + 1}. ${stage}`;
            el.stages.append(chip);
        });
    };

    const renderDecoy = (decoy) => {
        if (!decoy) {
            el.decoyTarget.textContent = '— (not engaged)';
            el.decoyExcuse.textContent = '—';
            el.decoyLanguage.textContent = '—';
            el.decoySource.textContent = '—';
            el.decoyFlags.innerHTML = '';
            return;
        }

        el.decoyTarget.textContent = TARGET_LABELS[decoy.targetAsked] || decoy.targetAsked;
        el.decoyExcuse.textContent = decoy.excuseUsed === 'none'
            ? '— (none this turn)'
            : decoy.excuseUsed.replace(/_/g, ' ');
        el.decoyLanguage.textContent = decoy.language;
        el.decoySource.textContent = decoy.source === 'llm' ? 'model' : 'scripted fallback';

        el.decoyFlags.innerHTML = '';
        const flag = (text, kind) => {
            const node = document.createElement('span');
            node.className = `flag flag-${kind}`;
            node.textContent = text;
            el.decoyFlags.append(node);
        };

        if (decoy.source === 'fallback') flag('SCRIPTED FALLBACK', 'warn');
        if (decoy.injectionAttempt) flag('PROMPT INJECTION IGNORED', 'bad');
        if ((decoy.pressure || []).length > 0) flag(`PRESSURE: ${decoy.pressure.join(', ')}`, 'bad');
        if (decoy.contradictionsRejected > 0) flag(`${decoy.contradictionsRejected} REDRAFT`, 'warn');
        if (decoy.guard && decoy.guard.verdict !== 'pass') flag(`GUARD: ${decoy.guard.verdict}`, 'bad');
    };

    const addDecision = (entry) => {
        if (el.decisions.querySelector('.italic')) el.decisions.innerHTML = '';

        const node = document.createElement('div');
        node.className = 'flex gap-2';

        const score = document.createElement('span');
        score.className = 'tabular-nums font-bold w-6 text-right shrink-0';
        score.textContent = entry.score;

        const text = document.createElement('span');
        text.className = 'truncate';
        text.textContent = entry.stateChanged
            ? `${entry.from} -> ${entry.to}`
            : (entry.signals || []).join(', ') || entry.state;

        node.append(score, text);
        el.decisions.append(node);
        el.decisions.scrollTop = el.decisions.scrollHeight;
    };

    // ---------------------------------------------------------------------
    // The clock
    // ---------------------------------------------------------------------

    /**
     * Ticks the real elapsed time since the first message.
     *
     * While the conversation is live this counts up from the first message's
     * receive time. Once it finishes it freezes at the measured span. It is
     * never advanced by anything other than the clock.
     */
    const tick = () => {
        if (!state.firstSeenAt) return;
        const end = state.finished && state.lastSeenAt ? state.lastSeenAt : Date.now();
        const seconds = (end - state.firstSeenAt) / 1000;
        el.wasted.textContent = mmss(seconds);
        el.phoneClock.textContent = mmss(seconds);
    };
    setInterval(tick, 1000);

    // ---------------------------------------------------------------------
    // Applying a turn
    // ---------------------------------------------------------------------

    const applyTurn = (turn) => {
        const guardianState = turn.state;

        renderState(guardianState);
        setStatus(guardianState);

        if (turn.guardian) {
            renderScore(turn.guardian.score, turn.guardian.breakdown, turn.guardian.classifier, turn.guardian.thresholds);

            if (turn.guardian.classifier && turn.guardian.classifier.available === false
                && turn.guardian.classifier.note && /exceeded|unavailable/i.test(turn.guardian.classifier.note)) {
                toast(`Classifier unavailable (${turn.guardian.classifier.note}). The rule layer decided on its own.`, 'warn');
            }
        }

        renderIdentifiers(turn.intelligence);
        renderStages(turn.scriptStages && turn.scriptStages.session);
        renderDecoy(turn.decoy);
        renderAlerts(turn.alerts);
        showTakeover(turn.takeoverNotice);

        state.engaged = guardianState === 'DECOY_ACTIVE';
        el.btnGenuine.disabled = !state.engaged;
        el.btnReport.disabled = false;
        el.btnPdf.disabled = false;

        if (['ENDED', 'LEGIT', 'FALSE_POSITIVE'].includes(guardianState)) {
            state.finished = true;
            state.lastSeenAt = Date.now();
        }

        // An LLM that fell over shows as a toast while the decoy covers.
        if (turn.decoy && turn.decoy.source === 'fallback') {
            toast('The model is unavailable — the decoy is covering with a scripted stall line.', 'warn');
        }
        if (turn.decoy && turn.decoy.injectionAttempt) {
            toast('That message tried to inject instructions. It was ignored.', 'bad');
        }

        tick();
    };

    const addScammerLogEntry = (sent, turn) => {
        const node = document.createElement('div');
        node.className = 'border border-line rounded bg-white p-2';

        const mine = document.createElement('div');
        mine.className = 'text-[11.5px]';
        mine.textContent = sent;
        node.append(mine);

        const outcome = document.createElement('div');
        outcome.className = 'mt-1.5 pt-1.5 border-t border-line text-[11px]';

        if (turn.reply) {
            outcome.innerHTML = '';
            const who = document.createElement('span');
            who.className = 'text-muted';
            who.textContent = 'she replied: ';
            const said = document.createElement('span');
            said.textContent = turn.reply;
            outcome.append(who, said);
        } else {
            outcome.className += ' text-muted italic';
            outcome.textContent = `no reply — Guardian is ${turn.state}`;
        }

        node.append(outcome);
        el.scammerLog.append(node);
        el.scammerLog.scrollTop = el.scammerLog.scrollHeight;
    };

    // ---------------------------------------------------------------------
    // Sending
    // ---------------------------------------------------------------------

    const send = async (text) => {
        const body = text.trim();
        if (body === '') return;

        el.btnSend.disabled = true;
        el.sendState.textContent = 'sending...';

        const sentAt = Date.now();
        if (!state.firstSeenAt) state.firstSeenAt = sentAt;

        addPhoneBubble(body, 'them', `${el.channel.value} · ${el.from.value}`);
        el.phoneCaller.textContent = el.from.value || 'Unknown number';
        el.phoneChannel.textContent = el.channel.value;

        try {
            const response = await api('/api/message', {
                method: 'POST',
                body: JSON.stringify({
                    sessionId: state.sessionId,
                    message: { sender: 'scammer', text: body, timestamp: sentAt },
                    metadata: {
                        channel: el.channel.value,
                        language: (state.scenario && state.scenario.language) || 'English',
                        locale: 'IN',
                        from: el.from.value,
                        userId: state.userId,
                    },
                }),
            });

            const turn = await response.json();
            applyTurn(turn);
            addScammerLogEntry(body, turn);

            if (turn.reply) {
                addPhoneBubble(turn.reply, 'us', `Guardian replied as Sudha · ${turn.decoy.language}`);
            }

            el.message.value = '';
            el.sendState.textContent = '';
        } catch (error) {
            toast(`Send failed: ${error.message}`, 'bad');
            el.sendState.textContent = 'failed';
        } finally {
            el.btnSend.disabled = false;
            el.message.focus();
        }
    };

    // ---------------------------------------------------------------------
    // Scenarios
    // ---------------------------------------------------------------------

    const loadScenario = (scenario) => {
        state.scenario = scenario;
        state.followUpIndex = 0;

        el.channel.value = scenario.channel;
        el.from.value = scenario.from;
        el.message.value = scenario.opening;

        el.scenarioNote.classList.toggle('hidden', !scenario.note);
        el.scenarioNote.textContent = scenario.note || '';

        el.btnNext.classList.toggle('hidden', (scenario.followUps || []).length === 0);
        el.btnNext.textContent = `Next scripted line (1/${(scenario.followUps || []).length})`;

        el.message.focus();
    };

    const renderScenarioButtons = () => {
        el.scenarioButtons.innerHTML = '';
        for (const scenario of state.scenarios) {
            const button = document.createElement('button');
            const scam = scenario.kind === 'scam';
            button.type = 'button';
            button.className = 'text-left text-[11px] px-2 py-1.5 rounded border transition-colors '
                + (scam
                    ? 'border-brick/40 text-brick hover:bg-brick/10'
                    : 'border-moss/50 text-moss hover:bg-moss/10');
            button.textContent = scenario.label;
            button.title = scenario.note || scenario.opening;
            button.addEventListener('click', () => loadScenario(scenario));
            el.scenarioButtons.append(button);
        }
    };

    // ---------------------------------------------------------------------
    // Report and network
    // ---------------------------------------------------------------------

    /**
     * Loads the printable report into the iframe.
     *
     * Fetched and handed over as srcdoc rather than set as a src: an iframe
     * cannot send the x-api-key header, and putting the key in a query string
     * would mean weakening the auth middleware and leaking the key into logs
     * and browser history.
     */
    const loadReportFrame = async () => {
        const response = await api(`/api/sessions/${state.sessionId}/report.html`);
        el.reportFrame.srcdoc = await response.text();
    };

    const openReport = async () => {
        const { report } = await (await api(`/api/sessions/${state.sessionId}/report`)).json();

        el.reviewed.checked = report.review.reviewedByFamily;
        el.reportStatus.textContent = report.review.readyToFile ? 'ready to file' : 'draft';
        el.reportStatus.className = `text-[11px] ${report.review.readyToFile ? 'text-moss' : 'text-brick'} font-semibold`;

        await loadReportFrame();
        el.reportModal.classList.remove('hidden');
    };

    const downloadPdf = async () => {
        try {
            const response = await api(`/api/sessions/${state.sessionId}/report.pdf?ready=1`);

            if (response.status === 409) {
                const body = await response.json();
                toast(body.error, 'warn', 9000);
                // The draft is still downloadable; only "ready to file" is gated.
                const draft = await api(`/api/sessions/${state.sessionId}/report.pdf`);
                saveBlob(await draft.blob(), `${state.sessionId}-DRAFT.pdf`);
                return;
            }

            saveBlob(await response.blob(), `${state.sessionId}.pdf`);
            toast('Report downloaded, marked ready to file.', 'ok');
        } catch (error) {
            toast(`Could not download the PDF: ${error.message}`, 'bad');
        }
    };

    const saveBlob = (blob, filename) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
    };

    let networkInstance = null;

    const openNetwork = async () => {
        el.networkModal.classList.remove('hidden');
        el.networkStats.textContent = 'loading...';

        try {
            const graph = await (await api('/api/network')).json();

            el.networkStats.textContent = `${graph.stats.sessions} sessions · `
                + `${graph.stats.identifiers} identifiers · `
                + `${graph.stats.sharedIdentifiers} shared · ${graph.stats.clusters} cluster(s)`;

            // Clusters list.
            el.networkClusters.innerHTML = '';
            if (graph.clusters.length === 0) {
                el.networkClusters.innerHTML = '<div class="text-[11px] text-muted italic">'
                    + 'No identifier appears in more than one session yet. Run <code>npm run seed</code> '
                    + 'to load five past sessions.</div>';
            }
            for (const cluster of graph.clusters) {
                const card = document.createElement('div');
                card.className = 'border border-brick/40 bg-brick/5 rounded p-2';
                card.innerHTML = `<div class="text-[11px] font-bold text-brick">${cluster.sessionCount} sessions linked</div>`;
                for (const link of cluster.linkedBy) {
                    const row = document.createElement('div');
                    row.className = 'text-[10.5px] mt-1';
                    row.innerHTML = `<span class="text-muted">${link.label}</span> `
                        + `<span class="font-mono font-semibold">${link.value}</span>`;
                    card.append(row);
                }
                el.networkClusters.append(card);
            }

            // The graph itself.
            const nodes = graph.nodes.map((node) => {
                if (node.kind === 'session') {
                    return {
                        id: node.id,
                        label: node.sessionId.replace(/^seed-/, ''),
                        shape: 'box',
                        color: { background: '#f3f1ed', border: '#b9b3a8' },
                        font: { size: 11, color: '#5c5c5c' },
                    };
                }
                return {
                    id: node.id,
                    label: `${node.label}\n${node.value}`,
                    shape: 'dot',
                    size: node.shared ? 18 : 10,
                    color: node.shared
                        ? { background: '#8c3b1e', border: '#6b2c15' }
                        : { background: '#c9c3b9', border: '#a9a299' },
                    font: { size: node.shared ? 12 : 10, color: node.shared ? '#8c3b1e' : '#6b6760' },
                };
            });

            const edges = graph.edges.map((edge) => ({
                from: edge.from,
                to: edge.to,
                dashes: edge.kind === 'seen_together',
                color: { color: edge.kind === 'seen_together' ? '#d8d4cd' : '#b9b3a8' },
                width: edge.kind === 'seen_in' ? 1.5 : 1,
            }));

            if (networkInstance) networkInstance.destroy();
            networkInstance = new vis.Network(
                el.networkCanvas,
                { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) },
                {
                    physics: { stabilization: { iterations: 220 }, barnesHut: { springLength: 130 } },
                    interaction: { hover: true },
                    nodes: { borderWidth: 1.5 },
                }
            );
        } catch (error) {
            el.networkStats.textContent = `could not load: ${error.message}`;
        }
    };

    // ---------------------------------------------------------------------
    // Reset
    // ---------------------------------------------------------------------

    const reset = async () => {
        if (state.sessionId) {
            try {
                await api(`/api/sessions/${state.sessionId}/reset`, { method: 'POST' });
            } catch { /* a session that was never created is fine */ }
        }

        state.sessionId = newSessionId();
        state.followUpIndex = 0;
        state.firstSeenAt = null;
        state.lastSeenAt = null;
        state.engaged = false;
        state.finished = false;
        state.seenIdentifiers.clear();

        el.sessionId.textContent = state.sessionId;
        el.phoneChat.innerHTML = '';
        el.phoneAlerts.innerHTML = '';
        el.scammerLog.innerHTML = '';
        el.decisions.innerHTML = '<div class="text-[11px] text-muted italic font-sans">Nothing yet.</div>';
        el.phoneCaller.textContent = 'No call';
        el.phoneChannel.textContent = '—';
        el.phoneClock.textContent = '00:00';
        el.wasted.textContent = '00:00';

        showTakeover(null);
        renderState('MONITORING');
        setStatus('MONITORING');
        renderScore(0, [], { label: '—', reasons: [] }, null);
        renderIdentifiers({});
        renderStages([]);
        renderDecoy(null);

        el.btnGenuine.disabled = true;
        el.btnReport.disabled = true;
        el.btnPdf.disabled = true;

        if (socket) socket.emit('watch', state.sessionId);
        toast('Reset. New session started.', 'ok', 2500);
    };

    // ---------------------------------------------------------------------
    // Socket.IO
    // ---------------------------------------------------------------------

    let socket = null;

    const connect = () => {
        socket = io();

        socket.on('connect', () => {
            el.connDot.className = 'w-2 h-2 rounded-full bg-moss';
            el.connLabel.textContent = 'live';
            if (state.sessionId) socket.emit('watch', state.sessionId);
        });

        socket.on('disconnect', () => {
            el.connDot.className = 'w-2 h-2 rounded-full bg-brick';
            el.connLabel.textContent = 'disconnected';
        });

        socket.on('guardian.score', (payload) => {
            if (payload.sessionId !== state.sessionId) return;
            renderScore(payload.score, payload.breakdown, payload.classifier, payload.thresholds);
            addDecision({ score: payload.score, state: payload.state, signals: payload.firedSignals });
        });

        socket.on('guardian.state_changed', (payload) => {
            if (payload.sessionId !== state.sessionId) return;
            renderState(payload.to);
            setStatus(payload.to);
            addDecision({ score: payload.score, stateChanged: true, from: payload.from, to: payload.to });
        });

        socket.on('guardian.takeover', (payload) => {
            if (payload.sessionId !== state.sessionId) return;
            showTakeover(payload.notice);
            toast('Guardian has taken over the conversation.', 'ok', 4000);
        });

        socket.on('guardian.released', (payload) => {
            if (payload.sessionId !== state.sessionId) return;
            showTakeover(null);
            toast(`Guardian released the conversation (${payload.reason}).`, 'ok', 4000);
        });

        /**
         * The whole turn. This is what keeps a second screen live: a window
         * showing only the intelligence panel never sends a message itself, so
         * without this it would see scores move but never learn what was
         * extracted.
         */
        socket.on('session.turn', (turn) => {
            if (turn.sessionId !== state.sessionId) return;
            if (!state.firstSeenAt) state.firstSeenAt = new Date(turn.incoming.at).getTime();

            // The sending window has already applied this.
            if (intelOnly) {
                applyTurn(turn);
                return;
            }
            renderIdentifiers(turn.intelligence);
            renderStages(turn.scriptStages && turn.scriptStages.session);
        });
    };

    // ---------------------------------------------------------------------
    // Wiring
    // ---------------------------------------------------------------------

    // Read before connect() runs, because the socket handlers close over it.
    const params = new URLSearchParams(location.search);
    const intelOnly = params.get('view') === 'intel';

    el.composer.addEventListener('submit', (event) => {
        event.preventDefault();
        send(el.message.value);
    });

    el.message.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            send(el.message.value);
        }
    });

    el.btnNext.addEventListener('click', () => {
        const followUps = (state.scenario && state.scenario.followUps) || [];
        if (state.followUpIndex >= followUps.length) {
            toast('That is the last scripted line. Type your own from here.', 'warn', 3500);
            return;
        }
        el.message.value = followUps[state.followUpIndex];
        state.followUpIndex += 1;
        el.btnNext.textContent = `Next scripted line (${Math.min(state.followUpIndex + 1, followUps.length)}/${followUps.length})`;
        el.message.focus();
    });

    el.btnGenuine.addEventListener('click', async () => {
        try {
            const result = await (await api(`/api/sessions/${state.sessionId}/genuine`, { method: 'POST' })).json();

            addPhoneBubble(result.reply, 'us', 'Guardian stood down and sent one neutral line');
            renderState(result.state);
            setStatus(result.state);
            showTakeover(null);
            el.btnGenuine.disabled = true;
            state.finished = true;
            state.lastSeenAt = Date.now();

            toast('Marked as genuine. The decoy stopped and the session is a false positive.', 'ok', 6000);

            if (result.offerTrustedContact && result.counterpartId) {
                const add = confirm(`Add ${result.counterpartId} to trusted contacts?\n\n`
                    + 'A trusted contact is never baited again, whatever a message scores.');
                if (add) {
                    await api('/api/trusted-contacts', {
                        method: 'POST',
                        body: JSON.stringify({
                            userId: state.userId,
                            identifier: result.counterpartId,
                            label: 'added after a false positive',
                            relationship: 'other',
                            addedFrom: 'false_positive',
                        }),
                    });
                    toast(`${result.counterpartId} added to trusted contacts.`, 'ok');
                }
            }
        } catch (error) {
            toast(`Could not stop the decoy: ${error.message}`, 'bad');
        }
    });

    el.reviewed.addEventListener('change', async () => {
        if (!el.reviewed.checked) {
            toast('The review tick cannot be taken back from here. Reset the session to start over.', 'warn');
            el.reviewed.checked = true;
            return;
        }
        try {
            await api(`/api/sessions/${state.sessionId}/report/review`, {
                method: 'POST',
                body: JSON.stringify({ reviewedByFamily: true, reviewedBy: 'family member (demo)' }),
            });
            el.reportStatus.textContent = 'ready to file';
            el.reportStatus.className = 'text-[11px] text-moss font-semibold';
            await loadReportFrame();
            toast('Report marked ready to file. Nothing has been submitted anywhere.', 'ok', 6000);
        } catch (error) {
            toast(`Could not record the review: ${error.message}`, 'bad');
            el.reviewed.checked = false;
        }
    });

    el.btnReport.addEventListener('click', () => openReport().catch((e) => toast(`Report failed: ${e.message}`, 'bad')));
    el.btnPdf.addEventListener('click', downloadPdf);
    el.btnNetwork.addEventListener('click', openNetwork);
    el.btnNetworkClose.addEventListener('click', () => el.networkModal.classList.add('hidden'));
    el.btnReportClose.addEventListener('click', () => el.reportModal.classList.add('hidden'));
    el.btnReset.addEventListener('click', reset);

    el.judgeMode.addEventListener('change', () => {
        document.body.classList.toggle('judge-mode', el.judgeMode.checked);
        if (el.judgeMode.checked) {
            toast('Judge mode on. Open ?view=intel on the second screen for the intelligence panel.', 'ok', 7000);
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        el.networkModal.classList.add('hidden');
        el.reportModal.classList.add('hidden');
    });

    // ---------------------------------------------------------------------
    // Start
    // ---------------------------------------------------------------------

    const start = async () => {
        if (intelOnly) document.body.classList.add('intel-only');

        // The key comes from the loopback-only bootstrap, so a judge never
        // types one. ?key= is there for driving this from another machine.
        const fromQuery = params.get('key');
        try {
            if (fromQuery) {
                state.apiKey = fromQuery;
            } else {
                const config = await (await fetch('/demo-config')).json();
                if (config.status !== 'success') throw new Error(config.error || 'bootstrap refused');
                state.apiKey = config.apiKey;

                if (!config.llmConfigured) {
                    el.llmBadge.textContent = 'NO LLM KEY — rules only, scripted decoy';
                    el.llmBadge.classList.remove('hidden');
                }
                if (config.demoMode) el.demoBadge.classList.remove('hidden');
                if (config.thresholds) {
                    el.thDecoy.textContent = config.thresholds.decoy;
                    el.thSusp.textContent = config.thresholds.suspicious;
                    el.scoreMark.style.left = `${config.thresholds.decoy}%`;
                }
            }
        } catch (error) {
            toast(`Could not read the demo config: ${error.message}. Append ?key=YOUR_API_KEY to the URL.`, 'bad', 15000);
        }

        // A shared session id lets the second screen follow the same call.
        state.sessionId = params.get('session') || newSessionId();
        el.sessionId.textContent = state.sessionId;

        try {
            const { scenarios } = await (await api('/api/scenarios')).json();
            state.scenarios = scenarios;
            renderScenarioButtons();
        } catch (error) {
            toast(`Could not load the scenarios: ${error.message}`, 'warn');
        }

        connect();
        renderState('MONITORING');
        setStatus('MONITORING');
        renderScore(0, [], { label: '—', reasons: [] }, null);
    };

    start();
})();
