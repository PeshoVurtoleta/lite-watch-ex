// Live wiring for the lite-watch-ex bench. Every module below drives REAL
// @zakkster/lite-signal signals through REAL @zakkster/lite-watch-ex watchers.
// Canvas and rAF are guarded so the module also loads in a headless DOM.

import { signal, batch } from "@zakkster/lite-signal";
import {
    watch, watchPrevious, watchChanged, pausableWatch, watchMany, watchOnce, watchUntil,
} from "@zakkster/lite-watch-ex";

const $ = (id) => document.getElementById(id);

// global fire odometer ------------------------------------------------------
// fired() only increments a number (no string work). The DOM text is flushed
// on a throttled heartbeat below, because the counter changes every frame and
// a value-guard cannot skip a monotonic counter -- only a lower cadence can.
let totalFires = 0;
const totalEl = $("total-fires");
function fired() { totalFires++; }
function pulse(el) { if (!el) return; el.classList.remove("pulse"); void el.offsetWidth; el.classList.add("pulse"); }

const raf = (typeof requestAnimationFrame === "function")
    ? requestAnimationFrame.bind(globalThis)
    : (cb) => setTimeout(() => cb(Date.now()), 16);
const now = () => (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();

// odometer heartbeat: flush the total ~10x/sec (every 6th frame), and only when
// it actually moved -- so a still bench allocates nothing here.
let obFrame = 0, shownTotal = -1;
(function odometerBeat() {
    if ((++obFrame % 6) === 0 && totalEl && totalFires !== shownTotal) { shownTotal = totalFires; totalEl.textContent = totalFires; }
    raf(odometerBeat);
})();

// 01 watchPrevious -- history scope -----------------------------------------
(function scopePanel() {
    const canvas = $("scope-canvas");
    let ctx = null;
    try { ctx = canvas && canvas.getContext ? canvas.getContext("2d") : null; } catch (e) { ctx = null; }
    const valueEl = $("scope-value"), velEl = $("scope-velocity"), firesEl = $("scope-fires");
    const cellsEl = $("scope-cells"), depthInput = $("scope-depth"), depthVal = $("scope-depth-val");
    const playBtn = $("scope-play");

    const wave = signal(50);
    let depth = parseInt((depthInput && depthInput.value) || "4", 10);
    let fires = 0;
    let stopWatch = null;
    // the 60fps callback records numbers only; readouts flush on a throttled cadence
    let lastCur = NaN, lastVel = NaN, lastHist = null, dirty = false, frame = 0, shownFires = -1;

    const TRACE = 260;
    const trace = new Float64Array(TRACE);
    let traceLen = 0, traceHead = 0;
    function pushTrace(v) { trace[traceHead] = v; traceHead = (traceHead + 1) % TRACE; if (traceLen < TRACE) traceLen++; }

    // hoisted geometry + style invariants: nothing in draw() allocates per frame
    const W = (canvas && canvas.width) || 1120, H = (canvas && canvas.height) || 200;
    const GRID = "rgba(98,255,208,0.08)", PHOS = "#62ffd0", GLOW = "rgba(98,255,208,0.7)", DOT = "#ddfff4";
    const toX = (i) => (i / (TRACE - 1)) * W;
    const toY = (v) => H - (v / 100) * (H - 16) - 8;
    if (ctx) { ctx.lineWidth = 1; ctx.strokeStyle = GRID; }
    const cellRefs = [];

    function buildCells() {
        if (!cellsEl) return;
        cellsEl.innerHTML = "";
        cellRefs.length = 0;
        for (let i = 0; i < depth; i++) {
            const c = document.createElement("div");
            c.className = "cell empty" + (i === 0 ? " newest" : "");
            const ci = document.createElement("span"); ci.className = "ci"; ci.textContent = "t-" + (i + 1);
            const cv = document.createElement("span"); cv.className = "cv"; cv.textContent = "--";
            c.appendChild(ci); c.appendChild(cv);
            cellsEl.appendChild(c);
            cellRefs.push({ cell: c, cv: cv, lastNum: NaN, empty: true });
        }
    }
    // numeric cache-guard: only format + touch the DOM when a cell's value changed
    function setCells(history) {
        for (let i = 0; i < cellRefs.length; i++) {
            const ref = cellRefs[i], v = history[i];
            if (v === undefined) {
                if (!ref.empty) { ref.cv.textContent = "--"; ref.cell.classList.add("empty"); ref.empty = true; ref.lastNum = NaN; }
            } else if (v !== ref.lastNum) {
                ref.lastNum = v;
                ref.cv.textContent = v.toFixed(1);
                if (ref.empty) { ref.cell.classList.remove("empty"); ref.empty = false; }
            }
        }
    }
    function makeWatch() {
        if (stopWatch) stopWatch();
        buildCells();
        stopWatch = watchPrevious(() => wave(), (cur, history) => {
            fires++; fired();                       // counts only -- zero string work in the hot path
            let oldest, span = 0;
            for (let i = history.length - 1; i >= 0; i--) {
                if (history[i] !== undefined) { oldest = history[i]; span = i + 1; break; }
            }
            lastCur = cur;
            lastVel = (oldest === undefined) ? NaN : (cur - oldest) / span;
            lastHist = history;                     // reused buffer; read at flush time (latest state)
            dirty = true;
        }, { depth: depth });
    }
    if (depthInput) depthInput.addEventListener("input", () => {
        depth = parseInt(depthInput.value, 10);
        if (depthVal) depthVal.textContent = depth;
        makeWatch();
    });

    let running = true;
    if (playBtn) playBtn.addEventListener("click", () => { running = !running; playBtn.textContent = running ? "pause" : "play"; });

    // flush text readouts ~10x/sec (every 6th frame); the canvas trace stays 60fps
    function flushReadouts() {
        if (firesEl && fires !== shownFires) { shownFires = fires; firesEl.textContent = fires; }
        if (!dirty) return;
        dirty = false;
        if (valueEl && lastCur !== valueEl.__lastNum) { valueEl.__lastNum = lastCur; valueEl.textContent = lastCur.toFixed(1); }
        if (velEl) {
            if (Number.isNaN(lastVel)) { velEl.textContent = "--"; }
            else if (lastVel !== velEl.__lastNum) { velEl.__lastNum = lastVel; velEl.textContent = lastVel.toFixed(2); }
        }
        if (lastHist) setCells(lastHist);
    }

    const t0 = now();
    function tick() {
        const t = (now() - t0) / 1000;
        if (running) {
            const v = 50 + Math.sin(t * 1.6) * 34 + Math.sin(t * 0.7 + 1) * 8;
            wave.set(Math.round(v * 10) / 10);
            pushTrace(wave());
        }
        draw();
        if ((++frame % 6) === 0) flushReadouts();
        raf(tick);
    }
    function draw() {
        if (!ctx) return;
        ctx.clearRect(0, 0, W, H);
        // grid -- drawn with the resting state (strokeStyle=GRID, lineWidth=1, shadowBlur=0)
        for (let x = 0; x <= W; x += W / 12) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
        for (let y = 0; y <= H; y += H / 4) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
        if (traceLen < 2) return;
        ctx.beginPath();
        for (let i = 0; i < traceLen; i++) {
            const idx = (traceHead - traceLen + i + TRACE) % TRACE;
            const x = toX(i + (TRACE - traceLen)), y = toY(trace[idx]);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = PHOS; ctx.lineWidth = 2; ctx.shadowColor = GLOW; ctx.shadowBlur = 8; ctx.stroke();
        ctx.shadowBlur = 0;
        const lastIdx = (traceHead - 1 + TRACE) % TRACE;
        ctx.fillStyle = DOT; ctx.beginPath(); ctx.arc(toX(TRACE - 1), toY(trace[lastIdx]), 3.5, 0, Math.PI * 2); ctx.fill();
        // restore the resting grid state so next frame's grid does not inherit wave styling
        ctx.strokeStyle = GRID; ctx.lineWidth = 1;
    }
    if (depthVal) depthVal.textContent = depth;
    makeWatch();
    raf(tick);
})();

// 02 watchChanged -- predicate gate -----------------------------------------
(function gatePanel() {
    const slider = $("gate-slider"), valEl = $("gate-value"), incBtn = $("gate-inc"), decBtn = $("gate-dec");
    const predSel = $("gate-pred"), led = $("gate-led"), badge = $("gate-badge");
    const changesEl = $("gate-changes"), passedEl = $("gate-passed"), blockedEl = $("gate-blocked"), logEl = $("gate-log");

    const level = signal(parseInt((slider && slider.value) || "50", 10));
    let changes = 0, passed = 0, blocked = 0;
    const preds = {
        up: (n, o) => o === undefined || n > o,
        down: (n, o) => o === undefined || n < o,
        cross: (n, o) => n >= 50 && (o === undefined || o < 50),
        jump: (n, o) => o === undefined ? false : Math.abs(n - o) > 10,
    };
    let predKey = (predSel && predSel.value) || "up";

    let flashTimer = null;
    function flash(kind) {
        if (!badge || !led) return;
        badge.classList.remove("pass", "block"); led.classList.remove("on", "amber");
        if (kind === "pass") { badge.classList.add("pass"); badge.textContent = "PASS"; led.classList.add("on"); }
        else { badge.classList.add("block"); badge.textContent = "BLOCK"; led.classList.add("amber", "on"); }
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => { badge.classList.remove("pass", "block"); badge.textContent = "IDLE"; led.classList.remove("on", "amber"); }, 650);
    }
    function logLine(n, o) {
        if (!logEl) return;
        const e = document.createElement("div"); e.className = "e";
        e.innerHTML = '<span class="t">' + (o === undefined ? "--" : o) + ' -&gt; </span>' + n + '  PASS';
        logEl.appendChild(e);
        while (logEl.children.length > 8) logEl.removeChild(logEl.firstChild);
    }

    // count ALL changes + flag BLOCK using the re-exported `watch`
    watch(() => level(), (n, o) => {
        changes++; if (changesEl) changesEl.textContent = changes;
        if (!preds[predKey](n, o)) { blocked++; if (blockedEl) blockedEl.textContent = blocked; flash("block"); }
    });

    let stopChanged = null;
    function makeChanged() {
        if (stopChanged) stopChanged();
        stopChanged = watchChanged(() => level(), (n, o) => preds[predKey](n, o), (n, o) => {
            passed++; if (passedEl) passedEl.textContent = passed; fired();
            flash("pass"); logLine(n, o); pulse(badge);
        });
    }
    function setLevel(v) {
        v = Math.max(0, Math.min(100, v));
        if (slider) slider.value = v; if (valEl) valEl.textContent = v; level.set(v);
    }
    if (slider) slider.addEventListener("input", () => setLevel(parseInt(slider.value, 10)));
    if (incBtn) incBtn.addEventListener("click", () => setLevel(level() + 5));
    if (decBtn) decBtn.addEventListener("click", () => setLevel(level() - 5));
    if (predSel) predSel.addEventListener("change", () => { predKey = predSel.value; makeChanged(); });

    if (valEl) valEl.textContent = level();
    makeChanged();
})();

// 03 pausableWatch -- live monitor ------------------------------------------
(function monitorPanel() {
    const valEl = $("mon-value"), led = $("mon-led"), stateEl = $("mon-state"), pauseBtn = $("mon-pause");
    const resumeFire = $("mon-resume-fire"), deliveredEl = $("mon-delivered"), suppressedEl = $("mon-suppressed");
    const overlay = $("mon-overlay"), catchup = $("mon-catchup");

    const sensor = signal(20.0);
    let delivered = 0, suppressed = 0, paused = false, handle = null, catchUpArmed = false;

    function makeHandle() {
        if (handle) handle.stop();
        handle = pausableWatch(() => sensor(), (n) => {
            delivered++; if (deliveredEl) deliveredEl.textContent = delivered; fired();
            if (valEl && n !== valEl.__lastNum) { valEl.__lastNum = n; valEl.textContent = n.toFixed(1); }
            pulse(valEl);
            if (catchUpArmed && catchup) { catchup.classList.add("show"); setTimeout(() => catchup.classList.remove("show"), 900); }
            catchUpArmed = false;
        }, { fireOnResume: !!(resumeFire && resumeFire.checked) });
    }
    // suppressed counter via re-exported `watch` (only while paused)
    watch(() => sensor(), () => { if (paused) { suppressed++; if (suppressedEl) suppressedEl.textContent = suppressed; } });

    function setPaused(p) {
        paused = p;
        if (p) { handle.pause(); }
        else { catchUpArmed = !!(resumeFire && resumeFire.checked); handle.resume(); catchUpArmed = false; }
        if (led) led.classList.toggle("on", !p);
        if (stateEl) stateEl.textContent = p ? "PAUSED" : "LIVE";
        if (overlay) overlay.classList.toggle("show", p);
        if (pauseBtn) pauseBtn.textContent = p ? "resume" : "pause";
    }
    if (pauseBtn) pauseBtn.addEventListener("click", () => setPaused(!paused));
    if (resumeFire) resumeFire.addEventListener("change", () => makeHandle());

    makeHandle();
    if (led) led.classList.add("on");

    let acc = 0, last = now();
    function tick() {
        const t = now(); acc += (t - last); last = t;
        if (acc >= 110) { acc = 0; const next = Math.max(0, Math.min(100, sensor() + (Math.random() - 0.5) * 9)); sensor.set(Math.round(next * 10) / 10); }
        raf(tick);
    }
    raf(tick);
})();

// 04 watchMany -- channel mixer ---------------------------------------------
(function mixerPanel() {
    const swatch = $("mix-swatch"), hexEl = $("mix-hex"), changedEl = $("mix-changed"), firesEl = $("mix-fires");
    const rIn = $("mix-r"), gIn = $("mix-g"), bIn = $("mix-b");
    const rv = $("mix-rv"), gv = $("mix-gv"), bv = $("mix-bv");
    const tags = [$("mix-lr"), $("mix-lg"), $("mix-lb")];
    const names = ["R", "G", "B"];
    const r = signal(+((rIn && rIn.value) || 128)), g = signal(+((gIn && gIn.value) || 128)), b = signal(+((bIn && bIn.value) || 128));
    let fires = 0;
    const hex2 = (n) => n.toString(16).padStart(2, "0");

    let tagTimer = null;
    watchMany([() => r(), () => g(), () => b()], (vals, olds, idx) => {
        fires++; if (firesEl) firesEl.textContent = fires; fired();
        const R = vals[0], G = vals[1], B = vals[2];
        const hx = "#" + hex2(R) + hex2(G) + hex2(B);
        if (swatch) swatch.style.background = hx;
        if (hexEl) hexEl.textContent = hx;
        if (rv) rv.textContent = R; if (gv) gv.textContent = G; if (bv) bv.textContent = B;
        if (changedEl) changedEl.textContent = idx < 0 ? "init (-1)" : names[idx] + " (" + idx + ")";
        tags.forEach((t, i) => { if (t) t.classList.toggle("active", i === idx); });
        pulse(swatch);
        clearTimeout(tagTimer);
        tagTimer = setTimeout(() => tags.forEach((t) => { if (t) t.classList.remove("active"); }), 600);
    }, { immediate: true });

    if (rIn) rIn.addEventListener("input", () => { if (rv) rv.textContent = rIn.value; r.set(+rIn.value); });
    if (gIn) gIn.addEventListener("input", () => { if (gv) gv.textContent = gIn.value; g.set(+gIn.value); });
    if (bIn) bIn.addEventListener("input", () => { if (bv) bv.textContent = bIn.value; b.set(+bIn.value); });
    const batchBtn = $("mix-batch");
    if (batchBtn) batchBtn.addEventListener("click", () => {
        const nr = Math.floor(Math.random() * 256), ng = Math.floor(Math.random() * 256), nb = Math.floor(Math.random() * 256);
        if (rIn) rIn.value = nr; if (gIn) gIn.value = ng; if (bIn) bIn.value = nb;
        batch(() => { r.set(nr); g.set(ng); b.set(nb); });
    });
})();

// 05 one-shots -- watchOnce / watchUntil ------------------------------------
(function oneShotPanel() {
    const bootBtn = $("boot-btn"), bootState = $("boot-state"), bootCount = $("boot-count");
    const boot = signal(0); let bootFires = 0;
    watchOnce(() => boot(), () => {
        bootFires++; if (bootCount) bootCount.textContent = bootFires;
        if (bootState) bootState.textContent = "INITIALIZED"; fired();
    });
    if (bootBtn) bootBtn.addEventListener("click", () => {
        const before = bootFires;
        boot.set(boot() + 1);
        if (before > 0 && bootState) bootState.textContent = "inert (already fired)";
    });

    const thr = $("thr-slider"), thrVal = $("thr-value"), thrState = $("thr-state");
    const lvl = signal(+((thr && thr.value) || 0)); let crossed = false;
    watchUntil(() => lvl(), (v) => v >= 80, (v) => {
        crossed = true; if (thrState) thrState.textContent = "REACHED at " + v + " (disposed)"; fired();
    });
    if (thr) thr.addEventListener("input", () => {
        if (thrVal) thrVal.textContent = thr.value; lvl.set(+thr.value);
        if (!crossed && thrState && +thr.value < 80) thrState.textContent = "waiting for >= 80";
    });
})();
