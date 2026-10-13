// Audit regression suite: one test per confirmed finding from the 1.1.0 audit.
// Each test asserts the CORRECT behavior; 15 of the 20 fail on 1.1.0 and pass
// on the fixed implementation. The other 5 pin guarantees that already held
// (stop() from an immediate callback, watchMany buffer identity, the default
// watchUntil immediate check) or findings that did not reproduce (see the
// "not reproducible" section), so the behavior they rely on stays guarded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { signal, effect, stats } from "@zakkster/lite-signal";
import {
    watchOnce, watchUntil, watchPrevious, pausableWatch, watchMany,
} from "../WatchEx.js";

// ===========================================================================
// BUG 1: pausableWatch baseline when pause() precedes the first change
// ===========================================================================

test("BUG 1a: fireOnResume reports the true value-at-pause as oldValue", () => {
    const s = signal(10);
    const log = [];
    const w = pausableWatch(s, (n, o) => log.push([n, o]), { fireOnResume: true });
    w.pause();
    s.set(20);
    w.resume();
    assert.deepEqual(log, [[20, 10]]);
});

test("BUG 1b: fireOnResume does not fire on A-B-A while paused", () => {
    const s = signal(10);
    const log = [];
    const w = pausableWatch(s, (n, o) => log.push([n, o]), { fireOnResume: true });
    w.pause();
    s.set(20);
    s.set(10);
    w.resume();
    assert.deepEqual(log, []);
});

test("BUG 1c: fireOnResume delivers a change to undefined made while paused", () => {
    const s = signal(10);
    const log = [];
    const w = pausableWatch(s, (n, o) => log.push([n, o]), { fireOnResume: true });
    w.pause();
    s.set(undefined);
    w.resume();
    assert.deepEqual(log, [[undefined, 10]]);
});

test("BUG 1: baseline is correct on a second pause cycle with no change in between", () => {
    const s = signal(1);
    const log = [];
    const w = pausableWatch(s, (n, o) => log.push([n, o]), { fireOnResume: true });
    w.pause(); w.resume();          // no change: no fire, baseline still unseen
    w.pause();
    s.set(2);
    w.resume();
    assert.deepEqual(log, [[2, 1]]);
});

// ===========================================================================
// BUG 2: pausableWatch handle after stop()
// ===========================================================================

test("BUG 2: resume() after stop() does not fire the callback", () => {
    const s = signal(0);
    const log = [];
    const w = pausableWatch(s, (n, o) => log.push([n, o]), { fireOnResume: true });
    w.pause();
    s.set(42);
    w.stop();
    w.resume();
    assert.deepEqual(log, []);
});

test("BUG 2: resume() after the callback's stop arg was called does not fire", () => {
    const s = signal(0);
    const log = [];
    let stopArg = null;
    const w = pausableWatch(s, (n, o, stop) => { log.push([n, o]); stopArg = stop; },
        { fireOnResume: true });
    s.set(1);
    w.pause();
    s.set(2);
    stopArg();                       // dispose via the callback-provided handle
    w.resume();
    assert.deepEqual(log, [[1, 0]]);
    assert.equal(w.isPaused, false);
});

test("BUG 2: isPaused is false after stop()", () => {
    const s = signal(0);
    const w = pausableWatch(s, () => {});
    w.pause();
    w.stop();
    assert.equal(w.isPaused, false);
});

test("BUG 2: stop() from inside an immediate callback is honored", () => {
    const before = stats().effects;
    const s = signal(0);
    const log = [];
    const w = pausableWatch(s, (n, o, stop) => { log.push(n); stop(); }, { immediate: true });
    s.set(1);
    assert.deepEqual(log, [0]);
    assert.equal(stats().effects, before);
    w.stop();                        // idempotent
});

// ===========================================================================
// BUG 3: watchOnce / watchUntil teardown order
// ===========================================================================

test("BUG 3: watchOnce releases its effect node even if the callback throws", () => {
    const before = stats().effects;
    const s = signal(0);
    watchOnce(s, () => { throw new Error("boom"); });   // handle discarded
    assert.throws(() => s.set(1), /boom/);
    assert.equal(stats().effects, before, "effect node leaked after a throwing callback");
});

test("BUG 3: watchUntil releases its effect node even if the callback throws", () => {
    const before = stats().effects;
    const s = signal(0);
    watchUntil(s, (v) => v > 0, () => { throw new Error("boom"); });
    assert.throws(() => s.set(1), /boom/);
    assert.equal(stats().effects, before, "effect node leaked after a throwing callback");
});

test("BUG 3 (found in audit): effect created inside a watchOnce callback survives", () => {
    // 1.1.0 called stop() AFTER the callback, so an effect created in the
    // callback was adopted by the watcher's node and cascade-disposed at once.
    const trigger = signal(0);
    const t = signal("a");
    const seen = [];
    let inner = null;
    watchOnce(trigger, () => { inner = effect(() => { seen.push(t()); }); });
    trigger.set(1);
    t.set("b");
    assert.deepEqual(seen, ["a", "b"], "inner effect was disposed with the watcher");
    inner();
});

test("BUG 3 (found in audit): effect created inside a watchUntil callback survives", () => {
    const trigger = signal(0);
    const t = signal("a");
    const seen = [];
    let inner = null;
    watchUntil(trigger, (v) => v === 1, () => { inner = effect(() => { seen.push(t()); }); });
    trigger.set(1);
    t.set("b");
    assert.deepEqual(seen, ["a", "b"], "inner effect was disposed with the watcher");
    inner();
});

// ===========================================================================
// BUG 4: state must be committed before the callback runs
// ===========================================================================

test("BUG 4: watchPrevious history stays coherent after a throwing callback", () => {
    const s = signal(0);
    const log = [];
    watchPrevious(s, (cur, h) => {
        log.push([cur, h[0]]);
        if (cur === 1) throw new Error("boom");
    });
    assert.throws(() => s.set(1), /boom/);
    s.set(2);
    assert.deepEqual(log, [[1, 0], [2, 1]]);
});

test("BUG 4: watchMany olds and changedIndex stay coherent after a throwing callback", () => {
    const a = signal(0), b = signal(0);
    const log = [];
    let thrown = false;
    watchMany([a, b], (v, o, i) => {
        log.push([v.slice(), o.slice(), i]);
        if (!thrown) { thrown = true; throw new Error("boom"); }
    });
    assert.throws(() => a.set(1), /boom/);
    b.set(1);
    assert.deepEqual(log, [
        [[1, 0], [0, 0], 0],
        [[1, 1], [1, 0], 1],          // 1.1.0: olds [0, 0], changedIndex 0
    ]);
});

test("BUG 4: watchMany non-copy buffers keep identity and read correctly", () => {
    const a = signal(0), b = signal(0);
    const log = [];
    const seen = new Set();
    watchMany([a, b], (v, o, i) => { seen.add(v); seen.add(o); log.push([v[0], v[1], o[0], o[1], i]); });
    a.set(1); b.set(2); a.set(3); a.set(3); b.set(4);
    assert.equal(seen.size, 2, "exactly two buffers, reused on every fire");
    assert.deepEqual(log, [
        [1, 0, 0, 0, 0],
        [1, 2, 1, 0, 1],
        [3, 2, 1, 2, 0],
        [3, 4, 3, 2, 1],
    ]);
});

// ===========================================================================
// BUG 4 premise: nested re-entry of the same watcher -- NOT reproducible
// ===========================================================================
// lite-signal never re-runs an effect inside its own body: markDownstream
// skips FLAG_COMPUTING effects, and flushEffects does not nest. A synchronous
// write to the source from the callback is therefore DROPPED for this watcher
// (no corruption, no nesting), and a cascade through another effect runs
// sequentially in the next flush pass. These tests pin that guarantee.

test("BUG 4 premise: self-write in watchPrevious callback never nests", () => {
    const s = signal(0);
    let depth = 0, maxDepth = 0;
    const log = [];
    watchPrevious(s, (cur, h) => {
        depth++; maxDepth = Math.max(maxDepth, depth);
        log.push([cur, h[0]]);
        if (cur === 1) s.set(100);   // dropped by the engine's self-cycle guard
        depth--;
    });
    s.set(1);
    s.set(2);
    assert.equal(maxDepth, 1);
    assert.deepEqual(log, [[1, 0], [2, 1]]);
});

test("BUG 4 premise: cascade back into the source runs sequentially, not nested", () => {
    const s = signal(0), relay = signal(0);
    let depth = 0, maxDepth = 0;
    const log = [];
    const stopRelay = effect(() => { const r = relay(); if (r !== 0) s.set(r); });
    watchPrevious(s, (cur, h) => {
        depth++; maxDepth = Math.max(maxDepth, depth);
        log.push([cur, h[0], h[1]]);
        if (cur === 1) relay.set(50);
        depth--;
    }, { depth: 2 });
    s.set(1);
    assert.equal(maxDepth, 1);
    assert.deepEqual(log, [[1, 0, undefined], [50, 1, 0]]);
    stopRelay();
});

// ===========================================================================
// AUDIT 5: PACKED elements kind (V8). Checked in bench/elements-kind.mjs,
// which needs --allow-natives-syntax.
// ===========================================================================

// ===========================================================================
// AUDIT 7: watchUntil API symmetry
// ===========================================================================

test("AUDIT 7: watchUntil predicate receives (newValue, oldValue)", () => {
    const s = signal(0);
    const seen = [];
    const log = [];
    watchUntil(s, (n, o) => { seen.push([n, o]); return o !== undefined && n - o > 10; },
        (n, o) => log.push([n, o]));
    s.set(5); s.set(30); s.set(100);
    assert.deepEqual(seen, [[0, undefined], [5, 0], [30, 5]]);
    assert.deepEqual(log, [[30, 5]]);
});

test("AUDIT 7: watchUntil { immediate: false } skips the registration check", () => {
    const s = signal(5);
    const log = [];
    watchUntil(s, (v) => v > 0, (n, o) => log.push([n, o]), { immediate: false });
    assert.deepEqual(log, []);
    s.set(6);
    assert.deepEqual(log, [[6, 5]]);
});

test("AUDIT 7: watchUntil default still checks at registration", () => {
    const s = signal(5);
    const log = [];
    watchUntil(s, (v) => v > 0, (n, o) => log.push([n, o]));
    assert.deepEqual(log, [[5, undefined]]);
});
