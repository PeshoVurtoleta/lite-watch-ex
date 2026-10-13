/**
 * WatchEx.js -- extended watcher utilities for @zakkster/lite-signal.
 *
 * Adds three one-shot / convenience watchers on top of the core `watch`,
 * `when`, and `whenAsync` from lite-signal:
 *
 *   watchOnce   -- fire once on the first change (or immediately, if requested),
 *                 then self-dispose.
 *   watchUntil  -- fire once when a predicate first passes on a changed value,
 *                 then self-dispose.
 *   watchEffect -- `effect()` with `onCleanup` pre-injected as a callback arg,
 *                 matching the Vue ergonomic. Identical alloc profile to plain
 *                 `effect()`.
 *
 * The core `watch`, `when`, and `whenAsync` are re-exported for convenience --
 * they live canonically in @zakkster/lite-signal. Importing from either path
 * resolves to the same function (same node in the reactive graph).
 *
 * Allocation profile:
 *   At registration: 1 effect node, links, plus 3 closures (the effect body,
 *   the hoisted untracked-fire body, and the late-binding `stop` wrapper).
 *   Per source change in steady state: zero JS-heap allocations from this
 *   file. The untrack body is hoisted into a closure allocated once at
 *   registration -- declaring it inline inside the effect would allocate a
 *   fresh closure per fire (the pattern Watch.js's "ZERO-GC HOT PATH" comment
 *   exists to warn against).
 *
 * Disposal semantics:
 *   All three watchers return a `stop()` function. `watchOnce` and
 *   `watchUntil` ALSO self-dispose synchronously when their condition fires --
 *   the effect node is released back to lite-signal's pool, not just silenced
 *   by a flag. `stop()` is idempotent: safe to call before the watcher fires,
 *   safe to call after self-dispose, safe to call multiple times.
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
    let wantsStopEarly = false;
    let fired = false;

    // Late-binding stop: callable before `stopFn` is assigned (e.g.,
    // synchronously inside the immediate fire on first run), idempotent
    // afterwards. Mirror of the pattern in Watch.js's `when()`.
    const stop = () => {
        if (stopFn !== null) stopFn();
        else wantsStopEarly = true;
    };

    // Hoisted untrack body -- allocated once, reused for every fire.
    // Reads shared state via closure variables (currentNewValue, oldValue).
    const untrackedFire = () => {
        if (fired) return;

        if (oldValue === UNINITIALIZED) {
            if (immediate) {
                fired = true;
                callback(currentNewValue, undefined);
                stop();
                return;
            }
            oldValue = currentNewValue;
            return;
        }

        if (!Object.is(currentNewValue, oldValue)) {
            fired = true;
            callback(currentNewValue, oldValue);
            stop();
            return;
        }
        oldValue = currentNewValue;
    };

    stopFn = effect(() => {
        if (fired) return;
        currentNewValue = source();
        untrack(untrackedFire);
    });

    // If `stop()` was called from inside the immediate fire on registration,
    // `stopFn` was still null at that point -- honor the deferred request now.
    if (wantsStopEarly) stopFn();

    return stop;
}

/**
 * Watch a reactive source until `predicate(newValue)` first returns truthy
 * AND the value has changed (or, on the initial run, if the predicate is
 * already truthy). Fires `callback` exactly once, then self-disposes.
 *
 * Distinct from {@link when}: `watchUntil` projects the value through
 * `source()` and passes it to `callback`, with old/new pair. `when` is for
 * "wait for predicate, fire callback with no arguments".
 *
 * @template T
 * @param {() => T} source                  Reactive read function.
 * @param {(value: T) => unknown} predicate Returns truthy to fire.
 * @param {(newValue: T, oldValue: T | undefined) => void} callback
 *                                          Fired once when predicate first
 *                                          passes on a changed value.
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
export function watchUntil(source, predicate, callback) {
    let oldValue = UNINITIALIZED;
    let currentNewValue;
    let stopFn = null;
    let wantsStopEarly = false;
    let fired = false;

    const stop = () => {
        if (stopFn !== null) stopFn();
        else wantsStopEarly = true;
    };

    const untrackedFire = () => {
        if (fired) return;

        if (oldValue === UNINITIALIZED) {
            if (predicate(currentNewValue)) {
                fired = true;
                callback(currentNewValue, undefined);
                stop();
                return;
            }
            oldValue = currentNewValue;
            return;
        }

        if (!Object.is(currentNewValue, oldValue) && predicate(currentNewValue)) {
            fired = true;
            callback(currentNewValue, oldValue);
            stop();
            return;
        }
        oldValue = currentNewValue;
    };

    stopFn = effect(() => {
        if (fired) return;
        currentNewValue = source();
        untrack(untrackedFire);
    });

    if (wantsStopEarly) stopFn();

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

    const hist = new Array(depth);     // reused, newest-first, length === depth
    for (let i = 0; i < depth; i++) hist[i] = undefined;

    let currentNewValue;
    let oldValue = UNINITIALIZED;
    let stopFn = null;
    let wantsStopEarly = false;

    const stop = () => {
        if (stopFn !== null) stopFn();
        else wantsStopEarly = true;
    };

    // In-place shift: drop the oldest, insert v at the front. O(depth), zero alloc.
    const pushPrev = (v) => {
        for (let i = depth - 1; i > 0; i--) hist[i] = hist[i - 1];
        hist[0] = v;
    };

    const untrackedFire = () => {
        if (oldValue === UNINITIALIZED) {
            oldValue = currentNewValue;
            if (immediate) callback(currentNewValue, copy ? hist.slice() : hist, stop);
            pushPrev(currentNewValue);
            return;
        }
        if (!Object.is(currentNewValue, oldValue)) {
            callback(currentNewValue, copy ? hist.slice() : hist, stop);
            pushPrev(currentNewValue);
            oldValue = currentNewValue;
        }
    };

    stopFn = effect(() => {
        currentNewValue = source();
        untrack(untrackedFire);
    });

    if (wantsStopEarly) stopFn();
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
    let lastValue;
    let hasValue = false;
    let pausedAt;

    const stop = watch(source, (newValue, oldValue, stopInner) => {
        lastValue = newValue;
        hasValue = true;
        if (paused) return;
        callback(newValue, oldValue, stopInner);
    }, options);

    return {
        stop,
        pause() {
            if (paused) return;
            paused = true;
            pausedAt = lastValue;
        },
        resume() {
            if (!paused) return;
            paused = false;
            if (fireOnResume && hasValue && !Object.is(lastValue, pausedAt)) {
                callback(lastValue, pausedAt, stop);
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
    const values = new Array(n);
    const olds = new Array(n);
    let initialized = false;
    let stopFn = null;
    let wantsStopEarly = false;

    const stop = () => {
        if (stopFn !== null) stopFn();
        else wantsStopEarly = true;
    };

    // Hoisted once. `values` is filled by the effect body (tracked reads) before
    // this runs; here we diff against `olds`, deliver, then commit.
    const fire = () => {
        if (!initialized) {
            for (let i = 0; i < n; i++) olds[i] = values[i];
            initialized = true;
            if (immediate) {
                if (copy) callback(values.slice(), olds.slice(), -1, stop);
                else callback(values, olds, -1, stop);
            }
            return;
        }
        let changed = -1;
        for (let i = 0; i < n; i++) {
            if (!Object.is(values[i], olds[i])) { changed = i; break; }
        }
        if (changed === -1) return;
        if (copy) {
            const v = values.slice();
            const o = olds.slice();
            for (let i = 0; i < n; i++) olds[i] = values[i];
            callback(v, o, changed, stop);
        } else {
            callback(values, olds, changed, stop);   // olds is still pre-change here
            for (let i = 0; i < n; i++) olds[i] = values[i];
        }
    };

    stopFn = effect(() => {
        for (let i = 0; i < n; i++) values[i] = sources[i]();
        untrack(fire);
    });

    if (wantsStopEarly) stopFn();
    return stop;
}
