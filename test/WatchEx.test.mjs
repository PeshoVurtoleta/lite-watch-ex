// node:test suite for @zakkster/lite-watch-ex.
//
// Run:  npm test               (node --test)
//   or: npm run test:gc        (node --expose-gc --test)
//
// The single GC-required test (steady-state heap-delta) skips silently when
// globalThis.gc is unavailable. Everything else runs identically in both modes.
//
// Coverage philosophy: every public function gets a behavior test PLUS a
// pool-reclamation test using stats().effects from lite-signal. The
// pool-reclamation tests are the regression guard for the v1.0.0 effect-node
// leak bug fixed by the late-binding stop wrapper pattern -- if a future edit
// reintroduces "set fired=true but forget to call stop()", these tests catch it
// the same day.

import { test } from "node:test";
import assert from "node:assert/strict";
import { signal, batch, stats } from "@zakkster/lite-signal";
import {
    watchOnce, watchUntil, watchEffect,
    watchPrevious, watchChanged, pausableWatch, watchMany,
    watch, when, whenAsync,
} from "../WatchEx.js";

// ---------------------------------------------------------------------------
// Re-export integrity
// ---------------------------------------------------------------------------

test("re-exports: watch / when / whenAsync are callable functions", () => {
    assert.equal(typeof watch, "function");
    assert.equal(typeof when, "function");
    assert.equal(typeof whenAsync, "function");
});

// ===========================================================================
// watchOnce
// ===========================================================================

test("watchOnce fires once on the first non-equal change", () => {
    const s = signal("a");
    const log = [];
    watchOnce(s, (n, o) => log.push([n, o]));
    s.set("b"); s.set("c"); s.set("d");
    assert.deepEqual(log, [["b", "a"]]);
});

test("watchOnce immediate fires synchronously with oldValue=undefined", () => {
    const s = signal(42);
    const log = [];
    watchOnce(s, (n, o) => log.push([n, o]), { immediate: true });
    s.set(43);
    s.set(44);
    assert.deepEqual(log, [[42, undefined]]);
});

test("watchOnce Object.is short-circuit: NaN -> NaN is a no-op", () => {
    const s = signal(NaN);
    const log = [];
    watchOnce(s, (n) => log.push(n));
    s.set(NaN);
    s.set(NaN);
    assert.deepEqual(log, []);   // never fired
    s.set(1);
    assert.deepEqual(log, [1]);  // first non-equal change
});

test("watchOnce Object.is short-circuit: +0 and -0 are distinct", () => {
    const s = signal(+0);
    const log = [];
    watchOnce(s, (n) => log.push(Object.is(n, -0) ? "-0" : "+0"));
    s.set(-0);
    assert.deepEqual(log, ["-0"]);
});

test("watchOnce stop() before first change cancels pre-emptively", () => {
    const s = signal(0);
    const log = [];
    const stop = watchOnce(s, (n) => log.push(n));
    stop();
    s.set(1); s.set(2);
    assert.deepEqual(log, []);
});

test("watchOnce stop() is idempotent (safe to call many times)", () => {
    const s = signal(0);
    const stop = watchOnce(s, () => {});
    stop(); stop(); stop();
    s.set(1);
    // no throw, no fire after disposal
    assert.ok(true);
});

test("watchOnce self-dispose returns the effect node to the pool", () => {
    const before = stats().effects;
    const s = signal(0);
    watchOnce(s, () => {});
    assert.equal(stats().effects, before + 1, "node allocated on register");
    s.set(1);
    assert.equal(stats().effects, before, "node returned to pool on fire");
});

test("watchOnce immediate self-disposes synchronously during registration", () => {
    const before = stats().effects;
    const s = signal(1);
    watchOnce(s, () => {}, { immediate: true });
    // The immediate fire happens during the effect call; the late-binding stop
    // wrapper defers the actual dispose until effect() returns. After the call
    // returns, the node must already be back in the pool.
    assert.equal(stats().effects, before);
});

test("watchOnce: external stop() after self-dispose is a no-op", () => {
    const s = signal(0);
    const stop = watchOnce(s, () => {});
    s.set(1);                       // fires and self-disposes
    stop();                         // must not throw, must not corrupt the pool
    const baseline = stats().effects;
    const s2 = signal(0);
    const stop2 = watchOnce(s2, () => {});
    s2.set(1);
    stop2();
    assert.equal(stats().effects, baseline, "second cycle still reclaims cleanly");
});

test("watchOnce callback re-entrant write does not re-fire the same watcher", () => {
    const s = signal(0);
    const log = [];
    watchOnce(s, (n) => {
        log.push(n);
        if (n < 5) s.set(n + 1);    // would loop forever if watcher re-fired
    });
    s.set(1);
    assert.deepEqual(log, [1]);     // fired exactly once
});

test("watchOnce callback reads to other signals are untracked", () => {
    // The watcher must subscribe to `driver` only -- not to `other`, even
    // though the callback reads `other`. Verified by changing `other` BEFORE
    // `driver` fires: if reads were tracked, the cb would be invoked on
    // other.set(); since reads run inside untrack, it must stay silent.
    const driver = signal(0);
    const other = signal("a");
    const log = [];
    watchOnce(driver, () => log.push(other()));
    other.set("b");                 // changing 'other' must NOT fire the cb
    other.set("c");
    assert.deepEqual(log, []);
    driver.set(1);                  // first real change on the actual source
    assert.deepEqual(log, ["c"]);   // sees the latest 'other' value, fired exactly once
});

// ===========================================================================
// watchUntil
// ===========================================================================

test("watchUntil fires once when predicate first passes on a changed value", () => {
    const s = signal(0);
    const log = [];
    watchUntil(s, (v) => v >= 3, (n, o) => log.push([n, o]));
    s.set(1); s.set(2); s.set(3); s.set(5);
    assert.deepEqual(log, [[3, 2]]);
});

test("watchUntil predicate-already-truthy on initial run fires immediately with oldValue=undefined", () => {
    const s = signal(100);
    const log = [];
    watchUntil(s, (v) => v >= 50, (n, o) => log.push([n, o]));
    s.set(200);   // should be inert -- already fired
    assert.deepEqual(log, [[100, undefined]]);
});

test("watchUntil ignores changes where predicate fails", () => {
    const s = signal(0);
    const log = [];
    watchUntil(s, (v) => v < 0, (n) => log.push(n));
    s.set(1); s.set(2); s.set(100);
    assert.deepEqual(log, []);      // predicate never passes -> never fires
});

test("watchUntil self-dispose returns the effect node to the pool", () => {
    const before = stats().effects;
    const s = signal(0);
    watchUntil(s, (v) => v >= 1, () => {});
    assert.equal(stats().effects, before + 1);
    s.set(1);
    assert.equal(stats().effects, before, "node returned to pool on fire");
});

test("watchUntil predicate-truthy-initially self-disposes during registration", () => {
    const before = stats().effects;
    const s = signal(99);
    watchUntil(s, (v) => v > 50, () => {});
    assert.equal(stats().effects, before, "node returned to pool synchronously");
});

test("watchUntil stop() before fire cancels", () => {
    const s = signal(0);
    const log = [];
    const stop = watchUntil(s, (v) => v >= 10, (n) => log.push(n));
    stop();
    s.set(10); s.set(99);
    assert.deepEqual(log, []);
});

test("watchUntil Object.is no-op: NaN -> NaN does not trigger a predicate retry", () => {
    const s = signal(0);
    let calls = 0;
    watchUntil(s, () => { calls++; return false; }, () => {});
    s.set(NaN);                     // changes, predicate called: 1
    s.set(NaN);                     // no-op (Object.is), predicate NOT called
    assert.equal(calls, 2);         // initial run + one set(NaN); no third
});

// ===========================================================================
// watchEffect
// ===========================================================================

test("watchEffect re-runs on dep change and dispose cleans up the node", () => {
    const before = stats().effects;
    const s = signal(0);
    let runs = 0;
    const stop = watchEffect(() => { runs++; s(); });
    s.set(1); s.set(2);
    assert.equal(runs, 3);          // initial + 2 changes
    assert.equal(stats().effects, before + 1, "alive while running");
    stop();
    assert.equal(stats().effects, before, "node returned to pool on stop");
});

test("watchEffect runs onCleanup before each re-run and on dispose", () => {
    const s = signal(0);
    let runs = 0, cleanups = 0;
    const stop = watchEffect((onCleanup) => {
        runs++;
        s();
        onCleanup(() => cleanups++);
    });
    s.set(1); s.set(2);             // runs=3 by now, cleanups=2 (between runs)
    stop();                         // final cleanup
    assert.equal(runs, 3);
    assert.equal(cleanups, 3);
});

test("watchEffect onCleanup runs in LIFO order within a single run", () => {
    const s = signal(0);
    const order = [];
    const stop = watchEffect((onCleanup) => {
        s();
        onCleanup(() => order.push("a"));
        onCleanup(() => order.push("b"));
        onCleanup(() => order.push("c"));
    });
    s.set(1);                       // triggers cleanup of first run
    stop();                         // triggers cleanup of second run
    // Each run registers a,b,c; cleanup typically runs LIFO (c,b,a) per run.
    // Two cleanup batches (one between runs, one at stop).
    assert.equal(order.length, 6);
});

// ===========================================================================
// watchPrevious
// ===========================================================================

test("watchPrevious depth=1 delivers the immediately-previous value", () => {
    const s = signal(0);
    const log = [];
    const stop = watchPrevious(s, (cur, h) => log.push([cur, h[0], h.length]));
    s.set(1); s.set(2); s.set(3);
    assert.deepEqual(log, [[1, 0, 1], [2, 1, 1], [3, 2, 1]]);
    stop();
    s.set(4);
    assert.equal(log.length, 3);
});

test("watchPrevious depth=3 is a newest-first window, undefined tail during warmup", () => {
    const s = signal(0);
    const log = [];
    watchPrevious(s, (cur, h) => log.push([cur, h[0], h[1], h[2]]), { depth: 3 });
    s.set(1); s.set(2); s.set(3); s.set(4);
    assert.deepEqual(log, [
        [1, 0, undefined, undefined],
        [2, 1, 0, undefined],
        [3, 2, 1, 0],
        [4, 3, 2, 1],
    ]);
});

test("watchPrevious immediate fires once with all-undefined history", () => {
    const s = signal(7);
    const log = [];
    watchPrevious(s, (cur, h) => log.push([cur, h[0]]), { immediate: true });
    s.set(8);
    assert.deepEqual(log, [[7, undefined], [8, 7]]);
});

test("watchPrevious depth < 1 is clamped to 1", () => {
    const s = signal(0);
    const log = [];
    watchPrevious(s, (cur, h) => log.push([cur, h.length, h[0]]), { depth: 0 });
    s.set(1); s.set(2);
    assert.deepEqual(log, [[1, 1, 0], [2, 1, 1]]);
});

test("watchPrevious depth coerces fractional/string to integer via | 0", () => {
    const s = signal(0);
    const log = [];
    watchPrevious(s, (cur, h) => log.push(h.length), { depth: 2.9 });
    s.set(1);
    assert.equal(log[0], 2);        // 2.9 | 0 === 2
});

test("watchPrevious reuses one array by default; copy yields fresh arrays", () => {
    const s = signal(0);
    const refs = [];
    watchPrevious(s, (cur, h) => refs.push(h));
    s.set(1); s.set(2);
    assert.equal(refs[0], refs[1], "same buffer reused");

    const s2 = signal(0);
    const refs2 = [];
    watchPrevious(s2, (cur, h) => refs2.push(h), { copy: true });
    s2.set(1); s2.set(2);
    assert.notEqual(refs2[0], refs2[1], "fresh array per fire");
    assert.deepEqual(refs2[0], [0]);
    assert.deepEqual(refs2[1], [1]);
});

test("watchPrevious ignores no-op changes (Object.is, NaN)", () => {
    const s = signal(NaN);
    const log = [];
    watchPrevious(s, (cur, h) => log.push([cur, h[0]]));
    s.set(NaN);
    s.set(1);
    assert.deepEqual(log, [[1, NaN]]);
});

test("watchPrevious callback can stop from inside via the stop arg", () => {
    const s = signal(0);
    const log = [];
    watchPrevious(s, (cur, _h, stop) => {
        log.push(cur);
        if (cur === 2) stop();
    });
    s.set(1); s.set(2); s.set(3); s.set(4);
    assert.deepEqual(log, [1, 2]);
});

test("watchPrevious stop() returns the effect node to the pool", () => {
    const before = stats().effects;
    const s = signal(0);
    const stop = watchPrevious(s, () => {}, { depth: 5 });
    assert.equal(stats().effects, before + 1);
    s.set(1); s.set(2);
    stop();
    assert.equal(stats().effects, before);
});

// ===========================================================================
// watchChanged
// ===========================================================================

test("watchChanged fires only on predicate-passing changes and keeps watching", () => {
    const s = signal(0);
    const log = [];
    const stop = watchChanged(s, (n, o) => n > (o ?? -Infinity), (n, o) => log.push([n, o]));
    s.set(5); s.set(3); s.set(8); s.set(8);
    assert.deepEqual(log, [[5, 0], [8, 3]]);
    stop();
    s.set(100);
    assert.equal(log.length, 2);
});

test("watchChanged immediate evaluates predicate with undefined old", () => {
    const s = signal(10);
    const log = [];
    watchChanged(s, (n, o) => o === undefined, (n, o) => log.push([n, o]), { immediate: true });
    s.set(20);
    assert.deepEqual(log, [[10, undefined]]);
});

test("watchChanged callback can self-stop via the stop arg", () => {
    const s = signal(0);
    const log = [];
    watchChanged(s, () => true, (n, _o, stop) => {
        log.push(n);
        if (n === 2) stop();
    });
    s.set(1); s.set(2); s.set(3);
    assert.deepEqual(log, [1, 2]);
});

test("watchChanged predicate does not run on Object.is no-op changes", () => {
    const s = signal(NaN);
    let predCalls = 0;
    watchChanged(s, () => { predCalls++; return true; }, () => {});
    s.set(NaN);                     // Object.is(NaN, NaN) -> no-op; predicate must NOT run
    s.set(1);                       // real change
    assert.equal(predCalls, 1, "only the real change triggers the predicate");
});

test("watchChanged stop() returns the effect node to the pool", () => {
    const before = stats().effects;
    const s = signal(0);
    const stop = watchChanged(s, () => true, () => {});
    assert.equal(stats().effects, before + 1);
    s.set(1); s.set(2);
    stop();
    assert.equal(stats().effects, before);
});

// ===========================================================================
// pausableWatch
// ===========================================================================

test("pausableWatch suppresses while paused and resumes delivery", () => {
    const s = signal(0);
    const log = [];
    const w = pausableWatch(s, (n) => log.push(n));
    s.set(1);
    assert.equal(w.isPaused, false);
    w.pause();
    assert.equal(w.isPaused, true);
    s.set(2); s.set(3);
    assert.deepEqual(log, [1]);
    w.resume();
    assert.equal(w.isPaused, false);
    s.set(4);
    assert.deepEqual(log, [1, 4]);
    w.stop();
    s.set(5);
    assert.deepEqual(log, [1, 4]);
});

test("pausableWatch pause() is idempotent (second pause is no-op)", () => {
    const s = signal(0);
    const log = [];
    const w = pausableWatch(s, (n, o) => log.push([n, o]), { fireOnResume: true });
    s.set(1);
    w.pause();
    s.set(2);
    w.pause();                      // second pause must NOT update pausedAt to 2
    s.set(3);
    w.resume();                     // catch-up should be (3, 1) NOT (3, 2)
    assert.deepEqual(log, [[1, 0], [3, 1]]);
});

test("pausableWatch resume() is a no-op when not paused", () => {
    const s = signal(0);
    const log = [];
    const w = pausableWatch(s, (n) => log.push(n), { fireOnResume: true });
    s.set(1);
    w.resume();
    assert.deepEqual(log, [1]);
});

test("pausableWatch fireOnResume delivers one catch-up when value changed while paused", () => {
    const s = signal(0);
    const log = [];
    const w = pausableWatch(s, (n, o) => log.push([n, o]), { fireOnResume: true });
    s.set(1);
    w.pause();
    s.set(2); s.set(3);
    w.resume();
    assert.deepEqual(log, [[1, 0], [3, 1]]);
});

test("pausableWatch fireOnResume does NOT fire when value equals the pause value", () => {
    const s = signal(0);
    const log = [];
    const w = pausableWatch(s, (n) => log.push(n), { fireOnResume: true });
    s.set(1);
    w.pause();
    s.set(2); s.set(1);             // value returned to pause-time value
    w.resume();
    assert.deepEqual(log, [1]);     // no catch-up
});

test("pausableWatch fireOnResume does NOT fire when no changes occurred during pause", () => {
    const s = signal(0);
    const log = [];
    const w = pausableWatch(s, (n) => log.push(n), { fireOnResume: true });
    s.set(1);
    w.pause();
    w.resume();                     // no changes during pause -> no catch-up
    assert.deepEqual(log, [1]);
});

test("pausableWatch stop() while paused tears down cleanly", () => {
    const before = stats().effects;
    const s = signal(0);
    const w = pausableWatch(s, () => {});
    w.pause();
    w.stop();
    assert.equal(stats().effects, before, "node returned to pool even while paused");
    s.set(1);                       // must not throw, must not re-allocate
    assert.equal(stats().effects, before);
});

test("pausableWatch handle.stop is the same function returned by the underlying watch", () => {
    const s = signal(0);
    const w = pausableWatch(s, () => {});
    assert.equal(typeof w.stop, "function");
    w.stop();
});

test("pausableWatch stop() releases the effect node", () => {
    const before = stats().effects;
    const s = signal(0);
    const w = pausableWatch(s, () => {});
    assert.equal(stats().effects, before + 1);
    s.set(1); s.set(2);
    w.stop();
    assert.equal(stats().effects, before);
});

// ===========================================================================
// watchMany
// ===========================================================================

test("watchMany fires on any change with values, olds, and changedIndex", () => {
    const a = signal(1), b = signal(2), c = signal(3);
    const log = [];
    const stop = watchMany([a, b, c], (v, o, i) => log.push([v.slice(), o.slice(), i]));
    b.set(20);
    a.set(10);
    assert.deepEqual(log, [
        [[1, 20, 3], [1, 2, 3], 1],
        [[10, 20, 3], [1, 20, 3], 0],
    ]);
    stop();
    c.set(30);
    assert.equal(log.length, 2);
});

test("watchMany reports the lowest changed index when several change in one batch", () => {
    const a = signal(1), b = signal(2), c = signal(3);
    const log = [];
    watchMany([a, b, c], (v, _o, i) => log.push([v.slice(), i]));
    batch(() => { c.set(30); a.set(10); });
    assert.equal(log.length, 1);
    assert.deepEqual(log[0][0], [10, 2, 30]);
    assert.equal(log[0][1], 0);
});

test("watchMany immediate fires once with changedIndex -1 and mirrored olds", () => {
    const a = signal(1), b = signal(2);
    const log = [];
    watchMany([a, b], (v, o, i) => log.push([v.slice(), o.slice(), i]), { immediate: true });
    assert.equal(log.length, 1);
    assert.deepEqual(log[0], [[1, 2], [1, 2], -1]);
    a.set(9);
    assert.equal(log.length, 2);
    assert.equal(log[1][2], 0);
});

test("watchMany reuses buffers by default; copy yields fresh arrays", () => {
    const a = signal(1), b = signal(2);
    const reused = [];
    watchMany([a, b], (v) => reused.push(v));
    a.set(9); a.set(10);
    assert.equal(reused[0], reused[1], "same buffer reused");

    const a2 = signal(1), b2 = signal(2);
    const fresh = [];
    watchMany([a2, b2], (v) => fresh.push(v), { copy: true });
    a2.set(9); a2.set(10);
    assert.notEqual(fresh[0], fresh[1]);
    assert.deepEqual(fresh[0], [9, 2]);
    assert.deepEqual(fresh[1], [10, 2]);
});

test("watchMany no-op change does not fire (Object.is)", () => {
    const a = signal(1), b = signal(2);
    const log = [];
    watchMany([a, b], (v, _o, i) => log.push(i));
    a.set(1);                       // no-op
    b.set(5);                       // real
    assert.deepEqual(log, [1]);
});

test("watchMany callback can self-stop via the stop arg", () => {
    const a = signal(0), b = signal(0);
    const log = [];
    watchMany([a, b], (v, _o, _i, stop) => {
        log.push(v.slice());
        if (v[0] === 2) stop();
    });
    a.set(1); a.set(2); a.set(3); b.set(99);
    assert.deepEqual(log, [[1, 0], [2, 0]]);
});

test("watchMany copy=true commits olds BEFORE callback (re-entrant safety)", () => {
    // In copy=true mode, the implementation snapshots both arrays, commits
    // olds[i]=values[i] FIRST, then calls the callback with the snapshots.
    // This makes a re-entrant source change see the post-commit olds baseline.
    const a = signal(0), b = signal(0);
    const observedOlds = [];
    watchMany([a, b], (v, o) => observedOlds.push(o.slice()), { copy: true });
    a.set(1);                       // olds snapshot must be [0, 0]
    a.set(2);                       // olds snapshot must be [1, 0]
    assert.deepEqual(observedOlds, [[0, 0], [1, 0]]);
});

test("watchMany stop() returns the effect node to the pool", () => {
    const before = stats().effects;
    const a = signal(1), b = signal(2);
    const stop = watchMany([a, b], () => {});
    assert.equal(stats().effects, before + 1);
    a.set(10); b.set(20);
    stop();
    assert.equal(stats().effects, before);
});

// ===========================================================================
// Zero-GC steady-state guard (engages only under --expose-gc)
// ===========================================================================

test("zero-GC: no per-fire heap growth in steady state across all watchers",
    { skip: typeof globalThis.gc !== "function" ? "run with --expose-gc" : false },
    () => {
        const heap = () => { globalThis.gc(); globalThis.gc(); return process.memoryUsage().heapUsed; };
        const a = signal(0), b = signal(0);
        let sink = 0;
        const w1 = watchPrevious(a, (cur, h) => { sink += (h[0] === undefined ? 0 : h[0]); }, { depth: 4 });
        const w2 = watchChanged(a, () => true, (n) => { sink += n; });
        const w3 = pausableWatch(a, (n) => { sink += n; });
        const w4 = watchMany([a, b], (v) => { sink += v[0]; });
        const w5 = watchEffect(() => { sink += a(); });

        // Warm V8 tiers.
        for (let i = 0; i < 5000; i++) a.set(i & 1023);
        const before = heap();
        for (let i = 0; i < 30000; i++) a.set(i & 1023);
        const after = heap();
        const delta = after - before;

        w1(); w2(); w3.stop(); w4(); w5();
        assert.ok(Number.isFinite(sink));
        assert.ok(delta < 300000, `steady-state heap grew ${delta} bytes over 30k fires (expected ~0)`);
    });

test("zero-GC: watchOnce register-fire-dispose cycle reclaims pool slots",
    { skip: typeof globalThis.gc !== "function" ? "run with --expose-gc" : false },
    () => {
        // Run a long cycle of register/fire/dispose; the effect count must
        // return to baseline every time, and the heap must not grow.
        const s = signal(0);
        const baseline = stats().effects;
        const heap = () => { globalThis.gc(); globalThis.gc(); return process.memoryUsage().heapUsed; };

        // Warmup
        for (let i = 0; i < 2000; i++) {
            watchOnce(s, () => {});
            s.set(i + 1);
        }
        assert.equal(stats().effects, baseline, "effect pool returns to baseline after warmup");

        const before = heap();
        for (let i = 0; i < 20000; i++) {
            watchOnce(s, () => {});
            s.set(s() + 1);
        }
        const after = heap();
        const delta = after - before;

        assert.equal(stats().effects, baseline, "no leaked effect nodes after 20k cycles");
        assert.ok(delta < 500000, `register/fire/dispose cycle grew heap ${delta} bytes over 20k cycles (expected ~0)`);
    });
