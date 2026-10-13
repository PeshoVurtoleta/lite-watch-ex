/**
 * WatchEx.js -- extended watcher utilities for @zakkster/lite-signal.
 *
 * Adds seven watchers on top of the core `watch`, `when`, and `whenAsync`
 * from lite-signal:
 *
 *   watchOnce     -- fire once on the first change (or immediately, if
 *                   requested), then self-dispose.
 *   watchUntil    -- fire once when a predicate first passes on a changed
 *                   value, then self-dispose.
 *   watchEffect   -- `effect()` with `onCleanup` pre-injected as a callback
 *                   arg, matching the Vue ergonomic. Identical alloc profile to
 *                   plain `effect()`.
 *   watchPrevious -- ongoing watcher with a rolling, reused history buffer.
 *   watchChanged  -- ongoing watcher gated by a (newValue, oldValue) predicate.
 *   pausableWatch -- ongoing watcher with pause / resume / fireOnResume.
 *   watchMany     -- ongoing watcher over a fixed tuple of sources.
 *
 * The core `watch`, `when`, and `whenAsync` are re-exported for convenience --
 * they live canonically in @zakkster/lite-signal. Importing from either path
 * resolves to the same function (same node in the reactive graph).
 *
 * Allocation profile:
 *   At registration: 1 effect node, links, plus a fixed handful of closures
 *   (the effect body, the hoisted untracked-fire body, and the late-binding
 *   `stop` wrapper; reused buffers for watchPrevious / watchMany).
 *   Per source change in steady state: zero JS-heap allocations from this
 *   file. The untrack body is hoisted into a closure allocated once at
 *   registration -- declaring it inline inside the effect would allocate a
 *   fresh closure per fire (the pattern Watch.js's "ZERO-GC HOT PATH" comment
 *   exists to warn against).
 *
 * Disposal semantics:
 *   Every watcher returns a `stop()` function (pausableWatch: `handle.stop`).
 *   `watchOnce` and `watchUntil` ALSO self-dispose synchronously when their
 *   condition fires -- the effect node is released back to lite-signal's
 *   pool BEFORE the callback runs, so a throwing callback cannot leak it and
 *   effects created inside the callback are not adopted (and cascade-disposed)
 *   by the dying watcher. `stop()` is idempotent; for every watcher except
 *   watchChanged (which returns core `watch`'s stop) it also drops the
 *   watcher's references to observed values, so a retained `stop` handle
 *   does not pin them in memory.
 *
 * Ordering:
 *   watchPrevious commits its baseline and history BEFORE invoking the
 *   callback; watchMany (non-copy) commits its old tuple in a `finally` after
 *   it, since the buffer must stay pre-change while the callback reads it. A
 *   callback that throws therefore leaves both coherent for the next change.
 *   watchChanged and pausableWatch inherit core `watch`, which commits AFTER
 *   the callback (lite-signal 1.5.2). (lite-signal never re-runs an effect
 *   inside its own body: a synchronous write to the source from the callback
 *   is skipped by the engine's self-cycle guard, and a cascade through another
 *   effect runs in the next flush pass.)
 */

import { effect, untrack, onCleanup, watch } from "@zakkster/lite-signal";

// Re-export the canonical core utilities. Convenience only; they are the same
// functions exported by @zakkster/lite-signal.
export { watch, when, whenAsync } from "@zakkster/lite-signal";

/**
 * Sentinel for "first run" detection. Distinguishes a legitimate `undefined`
 * source value from the uninitialized state.
 * @private
 */
const UNINITIALIZED = Symbol("watch.uninitialized");

/**
 * Watch a reactive source, fire `callback` exactly once on the first change
 * (or immediately, if `options.immediate === true`), then self-dispose.
 *
 * The effect node is released back to lite-signal's pool on fire -- not merely
 * silenced by a flag. Subsequent source changes are inert; no allocation,
 * no scheduling, no observer-list traversal.
 *
 * @template T
 * @param {() => T} source   Reactive read function.
 * @param {(newValue: T, oldValue: T | undefined) => void} callback
 *                           Fired with `(next, prev)`. On immediate fire,
 *                           `prev` is `undefined`.
 * @param {{ immediate?: boolean }} [options]
 *                           `immediate: true` fires synchronously at
 *                           registration with `oldValue = undefined`.
 * @returns {() => void}     Dispose function. Idempotent.
 *
 * @example
 *   const status = signal("loading");
 *   watchOnce(status, (next) => initialize(next));
 *   status.set("ready");   // fires once, then disposes
 *   status.set("idle");    // inert; watcher is gone
 *
 * @example  // Immediate
 *   watchOnce(currentUser, (user) => greet(user), { immediate: true });
 *   // fires synchronously with the current value, then disposes
 */
export function watchOnce(source, callback, options) {
    const immediate = options !== undefined && options.immediate === true;
    let oldValue = UNINITIALIZED;
    let currentNewValue;
    let stopFn = null;
    let fired = false;

    // Idempotent dispose. Drops the value slots so a retained `stop` handle
    // does not pin the last observed values (the closure context outlives the
    // effect node). `callback` never receives `stop`, and the immediate fire is
    // delivered after `effect()` returns, so `stopFn` is always assigned by the
    // time this can run -- no late-binding flag is needed here.
    const stop = () => {
        fired = true;
        oldValue = undefined;
        currentNewValue = undefined;
        if (stopFn !== null) {
            const fn = stopFn;
            stopFn = null;
            fn();
        }
    };

    // Hoisted untrack body -- allocated once, reused for every fire.
    // Reads shared state via closure variables (currentNewValue, oldValue).
    const untrackedFire = () => {
        if (fired) return;
        const next = currentNewValue;
        const prev = oldValue;

        if (prev === UNINITIALIZED) {
            // Immediate fire is deferred until effect() returns (see below).
            if (immediate) fired = true;
            else oldValue = next;
            return;
        }

        if (!Object.is(next, prev)) {
            // Dispose BEFORE the callback: a throwing callback cannot leak the
            // node, and effects created in the callback are not adopted by
            // (and cascade-disposed with) this dying watcher.
            stop();
            callback(next, prev);
        }
    };

    stopFn = effect(() => {
        if (fired) return;
        currentNewValue = source();
        untrack(untrackedFire);
    });

    if (fired) {
        // Immediate: dispose first, then deliver outside the effect body for
        // the same two reasons as above. Untracked so an enclosing observer
        // does not subscribe to the callback's reads. The closure is
        // registration-time only (immediate path), never per change.
        const next = currentNewValue;
        stop();
        untrack(() => callback(next, undefined));
    }

    return stop;
}

/**
 * Watch a reactive source until `predicate(newValue, oldValue)` first returns
 * truthy AND the value has changed (or, on the initial run, if the predicate is
 * already truthy -- skip that check with `immediate: false`). Fires `callback`
 * exactly once, then self-disposes.
 *
 * Distinct from {@link when}: `watchUntil` projects the value through
 * `source()` and passes it to `callback`, with old/new pair. `when` is for
 * "wait for predicate, fire callback with no arguments".
 *
 * @template T
 * @param {() => T} source                  Reactive read function.
 * @param {(newValue: T, oldValue: T | undefined) => unknown} predicate
 *                                          Returns truthy to fire. `oldValue`
 *                                          is `undefined` on the initial check,
 *                                          so delta predicates are possible.
 * @param {(newValue: T, oldValue: T | undefined) => void} callback
 *                                          Fired once when predicate first
 *                                          passes on a changed value.
 * @param {{ immediate?: boolean }} [options]
 *                                          `immediate` (default `true`) runs
 *                                          the predicate on the current value
 *                                          at registration; `false` waits for
 *                                          the first change.
 * @returns {() => void}                    Dispose function. Idempotent.
 *
 * @example  // Wait for health to drop below threshold
 *   watchUntil(
 *     () => player.health(),
 *     (h) => h <= 25,
 *     (h) => showLowHealthWarning(h)
 *   );
 *
 * @example  // Async-style condition on a reactive object
 *   watchUntil(
 *     () => loader.state(),
 *     (s) => s.phase === "done",
 *     (s) => render(s.payload)
 *   );
 */
export function watchUntil(source, predicate, callback, options) {
    const immediate = options === undefined || options.immediate !== false;
    let oldValue = UNINITIALIZED;
    let currentNewValue;
    let stopFn = null;
    let fired = false;

    // Same idempotent, value-releasing dispose as watchOnce.
    const stop = () => {
        fired = true;
        oldValue = undefined;
        currentNewValue = undefined;
        if (stopFn !== null) {
            const fn = stopFn;
            stopFn = null;
            fn();
        }
    };

    const untrackedFire = () => {
        if (fired) return;
        const next = currentNewValue;
        const prev = oldValue;

        if (prev === UNINITIALIZED) {
            // Initial check: a pass is deferred until effect() returns.
            if (immediate && predicate(next, undefined)) fired = true;
            else oldValue = next;
            return;
        }

        if (!Object.is(next, prev)) {
            oldValue = next;
            if (predicate(next, prev)) {
                stop();                  // dispose BEFORE the callback (see watchOnce)
                callback(next, prev);
            }
        }
    };

    stopFn = effect(() => {
        if (fired) return;
        currentNewValue = source();
        untrack(untrackedFire);
    });

    if (fired) {
        const next = currentNewValue;
        stop();
        untrack(() => callback(next, undefined));
    }

    return stop;
}

/**
 * `effect()` with `onCleanup` pre-injected as a callback argument. Matches
 * the Vue `watchEffect` ergonomic -- the registered function receives an
 * `onCleanup` it can call to register teardown for the next re-run.
 *
 * Functionally identical to writing:
 *
 *     import { effect, onCleanup } from "@zakkster/lite-signal";
 *     const stop = effect(() => {
 *         onCleanup(() => releaseSomething());
 *         // ... reactive body ...
 *     });
 *
 * The injected `onCleanup` is the same context-aware function imported from
 * lite-signal; the wrapper exists for API ergonomics only.
 *
 * @param {(onCleanup: (fn: () => void) => void) => void} callback
 *                                Reactive body. Re-runs on dep change.
 * @returns {() => void}          Dispose function (the same handle plain
 *                                `effect()` returns).
 *
 * @example
 *   const cursor = signal({ x: 0, y: 0 });
 *   watchEffect((onCleanup) => {
 *       const { x, y } = cursor();
 *       const id = requestAnimationFrame(() => render(x, y));
 *       onCleanup(() => cancelAnimationFrame(id));
 *   });
 */
export function watchEffect(callback) {
    return effect(() => callback(onCleanup));
}

/**
 * Watch a reactive source and deliver a rolling history of its recent values
 * on every change. The callback receives (current, history, stop), where
 * history is a buffer of the previous `depth` values, most-recent-first
 * (history[0] is the immediately previous value).
 *
 * At depth 1 (the default) this is a plain old-value buffer -- history is
 * always [previousValue]. At depth > 1 it becomes a fixed-window record of the
 * last `depth` distinct values, suitable for velocity, smoothing, or delta
 * calculations over time.
 *
 * ZERO-GC: the history array is allocated ONCE at registration and reused on
 * every fire (a single in-place shift, O(depth), no allocation). The hoisted
 * untrack body and push helper are likewise allocated once. Pass
 * `options.copy = true` to receive a fresh array snapshot per fire (opt-in
 * allocation) if you need to retain it.
 *
 * DO NOT retain the history array across fires unless `copy` is set -- it is
 * mutated in place. Read what you need before the callback returns.
 *
 * History length is always `depth`. Slots with no value yet (during the first
 * few changes, and on an immediate fire) are `undefined`. The current value is
 * never included in history (it is the first argument).
 *
 * @template T
 * @param {() => T} source   Reactive read function.
 * @param {(current: T, history: Array<T | undefined>, stop: () => void) => void} callback
 *                           Fired on each change with the current value and the
 *                           recent-history buffer (most-recent-first).
 * @param {{ depth?: number, immediate?: boolean, copy?: boolean }} [options]
 *                           `depth` (default 1, clamped to >= 1) is the history
 *                           window size. `immediate: true` fires once at
 *                           registration (history all-undefined). `copy: true`
 *                           passes a fresh array per fire.
 * @returns {() => void}     Dispose function. Idempotent.
 *
 * @example  // Delta over the last value (depth 1)
 *   watchPrevious(score, (now, [then]) => {
 *       if (then !== undefined) console.log("delta", now - then);
 *   });
 *
 * @example  // Velocity over a 3-sample window
 *   watchPrevious(() => pointer.x(), (x, recent) => {
 *       const [, p2] = recent;              // x from two changes ago
 *       if (p2 !== undefined) velocity = (x - p2) / 2;
 *   }, { depth: 3 });
 */
export function watchPrevious(source, callback, options) {
    let depth = (options !== undefined && options.depth !== undefined) ? (options.depth | 0) : 1;
    if (depth < 1) depth = 1;
    const immediate = options !== undefined && options.immediate === true;
    const copy = options !== undefined && options.copy === true;

    // Reused, newest-first, length === depth. Built with push() from an empty
    // literal so V8 keeps it PACKED; `new Array(depth)` starts HOLEY and can
    // never transition back, even once every slot is written.
    let hist = [];
    for (let i = 0; i < depth; i++) hist.push(undefined);

    let currentNewValue;
    let oldValue = UNINITIALIZED;
    let stopFn = null;
    let wantsStopEarly = false;

    // Late-binding, idempotent dispose. Drops the value slots and the history
    // buffer so a retained `stop` handle does not pin observed values. The
    // buffer is released by reference, not cleared, so a callback that calls
    // stop() can still read the history it was handed.
    const stop = () => {
        currentNewValue = undefined;
        oldValue = undefined;
        hist = null;
        if (stopFn !== null) {
            const fn = stopFn;
            stopFn = null;
            fn();
        } else {
            wantsStopEarly = true;
        }
    };

    // In-place shift: drop the oldest, insert v at the front. O(depth), zero alloc.
    const pushPrev = (v) => {
        for (let i = depth - 1; i > 0; i--) hist[i] = hist[i - 1];
        hist[0] = v;
    };

    const untrackedFire = () => {
        const next = currentNewValue;
        const prev = oldValue;

        if (prev === UNINITIALIZED) {
            oldValue = next;
            if (immediate) callback(next, copy ? hist.slice() : hist, stop);
            return;
        }
        if (!Object.is(next, prev)) {
            // Commit BEFORE the callback: the history holds the previous
            // values, the current value is argument 1, and a throwing callback
            // leaves the baseline coherent for the next change.
            oldValue = next;
            pushPrev(prev);
            callback(next, copy ? hist.slice() : hist, stop);
        }
    };

    stopFn = effect(() => {
        currentNewValue = source();
        untrack(untrackedFire);
    });

    if (wantsStopEarly) {
        const fn = stopFn;
        stopFn = null;
        fn();
    }
    return stop;
}

/**
 * Ongoing watcher that fires `callback` only when `predicate(newValue,
 * oldValue)` returns truthy on a changed value. Unlike `watch` (which fires on
 * every change) and `watchUntil` (which fires once then disposes), watchChanged
 * keeps watching and fires on every change that passes the predicate.
 *
 * The predicate sees both the new and old value, so it can express deltas
 * (`(n, o) => n > o`), thresholds (`(n) => n >= 100`), or epsilon gates
 * (`(n, o) => Math.abs(n - o) > 0.5`). On an immediate first fire the old value
 * is `undefined`.
 *
 * ZERO-GC: wraps `watch`. The gate closure is allocated ONCE here and reused by
 * `watch` on every fire -- no per-change allocation beyond what `watch` itself
 * does at registration.
 *
 * @template T
 * @param {() => T} source   Reactive read function.
 * @param {(newValue: T, oldValue: T | undefined) => unknown} predicate
 *                           Returns truthy to let the change through.
 * @param {(newValue: T, oldValue: T | undefined, stop: () => void) => void} callback
 *                           Fired on each predicate-passing change.
 * @param {{ immediate?: boolean }} [options]
 *                           `immediate: true` evaluates the predicate once at
 *                           registration with `oldValue = undefined`.
 * @returns {() => void}     Dispose function. Idempotent.
 *
 * @example  // Only when health crosses below a threshold downward
 *   watchChanged(
 *       () => player.health(),
 *       (now, prev) => now < 25 && (prev === undefined || prev >= 25),
 *       (now) => hud.flashLowHealth(now)
 *   );
 */
export function watchChanged(source, predicate, callback, options) {
    // Gate allocated ONCE; watch stores it and invokes it per fire with no
    // further allocation. (Declaring this inside an effect body would allocate
    // per fire -- the pattern Watch.js's ZERO-GC HOT PATH note warns against.)
    return watch(source, (newValue, oldValue, stop) => {
        if (predicate(newValue, oldValue)) callback(newValue, oldValue, stop);
    }, options);
}

/**
 * Pausable ongoing watcher. Returns a handle with `pause()`, `resume()`,
 * `stop()`, and a readonly `isPaused` flag. While paused, source changes are
 * observed but the callback is suppressed; on resume, normal delivery resumes.
 *
 * Gating model: pausing does NOT tear down the underlying watcher -- the node
 * stays alive and the value baseline is preserved, so pause/resume cycles cost
 * zero reallocation. (The watcher's effect still runs on a paused change to
 * keep the baseline current; it simply returns before invoking the callback.)
 *
 * With `options.fireOnResume = true`, if the value changed while paused, the
 * callback fires once on resume with `(currentValue, valueAtPause)` -- a single
 * catch-up delivery rather than a replay of every missed change.
 *
 * ZERO-GC: the handle object and its methods are allocated ONCE at
 * registration; the active hot path is `watch`'s (zero per-fire allocation).
 *
 * @template T
 * @param {() => T} source   Reactive read function.
 * @param {(newValue: T, oldValue: T | undefined, stop: () => void) => void} callback
 *                           Fired on each change while not paused.
 * @param {{ immediate?: boolean, fireOnResume?: boolean }} [options]
 * @returns {{ stop: () => void, pause: () => void, resume: () => void, readonly isPaused: boolean }}
 *
 * @example
 *   const w = pausableWatch(cursor, (p) => render(p));
 *   w.pause();            // ignore cursor moves during a modal
 *   w.resume();           // resume live rendering
 *   w.stop();             // tear down for good
 *
 * @example  // Catch up once on resume
 *   const w = pausableWatch(temp, (t) => gauge.set(t), { fireOnResume: true });
 */
export function pausableWatch(source, callback, options) {
    const fireOnResume = options !== undefined && options.fireOnResume === true;
    let paused = false;
    let stopped = false;
    // UNINITIALIZED until the inner watcher delivers a value. pause() before
    // the first change copies the sentinel into pausedAt; the first change
    // while paused then recovers the true value-at-pause from watch's own
    // oldValue -- no extra source() read needed.
    let lastValue = UNINITIALIZED;
    let pausedAt = UNINITIALIZED;
    let stopInnerFn = null;

    // Wraps the inner watch's dispose so pause/resume know the watcher is gone.
    // This (not the inner watch's own stop) is what the callback receives, so
    // a stop from inside the callback is seen by the handle too.
    const stop = () => {
        if (stopped) return;
        stopped = true;
        paused = false;
        lastValue = UNINITIALIZED;
        pausedAt = UNINITIALIZED;
        if (stopInnerFn !== null) {
            const fn = stopInnerFn;
            stopInnerFn = null;
            fn();
        }
    };

    stopInnerFn = watch(source, (newValue, oldValue) => {
        if (paused) {
            if (pausedAt === UNINITIALIZED) pausedAt = oldValue;
            lastValue = newValue;
            return;
        }
        lastValue = newValue;
        callback(newValue, oldValue, stop);
    }, options);

    // stop() called from inside an immediate callback, before stopInnerFn was
    // assigned: honor it now.
    if (stopped) {
        const fn = stopInnerFn;
        stopInnerFn = null;
        fn();
    }

    return {
        stop,
        pause() {
            if (paused || stopped) return;
            paused = true;
            pausedAt = lastValue;
        },
        resume() {
            if (!paused || stopped) return;
            paused = false;
            const prev = pausedAt;
            pausedAt = UNINITIALIZED;
            if (fireOnResume && prev !== UNINITIALIZED && !Object.is(lastValue, prev)) {
                callback(lastValue, prev, stop);
            }
        },
        get isPaused() { return paused; }
    };
}

/**
 * Watch a fixed tuple of reactive sources and fire when ANY of them changes.
 * The callback receives (values, oldValues, changedIndex, stop):
 *   - values       -- current value of every source, by index
 *   - oldValues    -- previous value of every source, by index
 *   - changedIndex -- index of the source that triggered this fire (the lowest
 *                     index if several changed in the same batch); -1 on the
 *                     initial immediate fire
 *
 * The compare loop that decides whether to fire already finds the changed
 * index, so it is handed to you for free -- an O(1) way to know which source
 * fired without diffing the arrays yourself.
 *
 * ZERO-GC: the `values` and `oldValues` arrays are allocated ONCE at
 * registration and reused on every fire. DO NOT retain them across fires -- they
 * are mutated in place. Pass `options.copy = true` to receive fresh array
 * snapshots per fire (opt-in allocation).
 *
 * Sources are fixed at registration (the tuple length does not change). Change
 * detection uses `Object.is`, matching the rest of lite-signal.
 *
 * @template T
 * @param {Array<() => T>} sources   Reactive read functions. Fixed length.
 * @param {(values: T[], oldValues: T[], changedIndex: number, stop: () => void) => void} callback
 * @param {{ immediate?: boolean, copy?: boolean }} [options]
 *                           `immediate: true` fires once at registration with
 *                           `changedIndex = -1` and `oldValues` mirroring
 *                           `values`. `copy: true` passes fresh arrays per fire.
 * @returns {() => void}     Dispose function. Idempotent.
 *
 * @example
 *   watchMany([() => w(), () => h()], (vals, _old, i) => {
 *       resize(vals[0], vals[1]);
 *       console.log("changed source", i);
 *   });
 */
export function watchMany(sources, callback, options) {
    const immediate = options !== undefined && options.immediate === true;
    const copy = options !== undefined && options.copy === true;
    const n = sources.length;
    // Reused buffers. Built with push() from empty literals so V8 keeps them
    // PACKED (see watchPrevious).
    let values = [];
    let olds = [];
    for (let i = 0; i < n; i++) { values.push(undefined); olds.push(undefined); }
    let initialized = false;
    let stopFn = null;
    let wantsStopEarly = false;

    // Late-binding, idempotent dispose; releases both buffers by reference so
    // a retained `stop` handle does not pin observed values. A callback that
    // calls stop() keeps the arrays it was handed.
    const stop = () => {
        values = null;
        olds = null;
        if (stopFn !== null) {
            const fn = stopFn;
            stopFn = null;
            fn();
        } else {
            wantsStopEarly = true;
        }
    };

    // Hoisted once. `values` is filled by the effect body (tracked reads) before
    // this runs; here we diff against `olds`, deliver, then commit. Locals pin
    // the buffers so a stop() from inside the callback cannot null them mid-fire.
    const fire = () => {
        const cur = values;
        const prev = olds;
        if (!initialized) {
            for (let i = 0; i < n; i++) prev[i] = cur[i];
            initialized = true;
            if (immediate) {
                if (copy) callback(cur.slice(), prev.slice(), -1, stop);
                else callback(cur, prev, -1, stop);
            }
            return;
        }
        let changed = -1;
        for (let i = 0; i < n; i++) {
            if (!Object.is(cur[i], prev[i])) { changed = i; break; }
        }
        if (changed === -1) return;
        if (copy) {
            const v = cur.slice();
            const o = prev.slice();
            for (let i = 0; i < n; i++) prev[i] = cur[i];
            callback(v, o, changed, stop);
        } else {
            // olds must still be pre-change inside the callback, so the commit
            // runs after it -- in `finally`, so a throwing callback cannot leave
            // a stale baseline (wrong oldValues / changedIndex on the next fire).
            try {
                callback(cur, prev, changed, stop);
            } finally {
                for (let i = 0; i < n; i++) prev[i] = cur[i];
            }
        }
    };

    stopFn = effect(() => {
        const buf = values;
        for (let i = 0; i < n; i++) buf[i] = sources[i]();
        untrack(fire);
    });

    if (wantsStopEarly) {
        const fn = stopFn;
        stopFn = null;
        fn();
    }
    return stop;
}
