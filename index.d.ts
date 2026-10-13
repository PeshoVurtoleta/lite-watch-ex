/**
 * Type declarations for @zakkster/lite-watch-ex.
 *
 * Extended watcher utilities for @zakkster/lite-signal. Re-exports the core
 * `watch`, `when`, `whenAsync` for convenience.
 */

export interface WatchOnceOptions {
    /** If true, fire synchronously at registration with `oldValue = undefined`, then dispose. */
    immediate?: boolean;
}

/**
 * Fire `callback` exactly once on the first change (or immediately, if
 * `options.immediate === true`), then self-dispose.
 */
export function watchOnce<T>(
    source: () => T,
    callback: (newValue: T, oldValue: T | undefined) => void,
    options?: WatchOnceOptions
): () => void;

export interface WatchUntilOptions {
    /** Default true: run the predicate on the current value at registration. False waits for the first change. */
    immediate?: boolean;
}

/**
 * Fire `callback` exactly once when `predicate(newValue, oldValue)` first
 * returns truthy AND the value has changed (or, on the initial run, if
 * predicate is already truthy -- unless `immediate: false`), then
 * self-dispose. `oldValue` is `undefined` on the initial check.
 */
export function watchUntil<T>(
    source: () => T,
    predicate: (newValue: T, oldValue: T | undefined) => unknown,
    callback: (newValue: T, oldValue: T | undefined) => void,
    options?: WatchUntilOptions
): () => void;

/**
 * `effect()` with `onCleanup` pre-injected as a callback argument.
 * Vue-style ergonomic -- functionally identical to plain `effect()` plus
 * a manual `onCleanup` import.
 */
export function watchEffect(
    callback: (onCleanup: (fn: () => void) => void) => void
): () => void;

export interface WatchPreviousOptions {
    /** History window size (number of previous values kept). Default 1, clamped to >= 1. */
    depth?: number;
    /** If true, fire once at registration with an all-undefined history. */
    immediate?: boolean;
    /** If true, pass a fresh history array per fire instead of the reused buffer. */
    copy?: boolean;
}

export interface WatchChangedOptions {
    /** If true, evaluate the predicate once at registration with `oldValue = undefined`. */
    immediate?: boolean;
}

export interface PausableWatchOptions {
    /** If true, fire synchronously at registration with `oldValue = undefined`. */
    immediate?: boolean;
    /** If true, fire once on resume when the value changed while paused, as `(current, valueAtPause)`. */
    fireOnResume?: boolean;
}

export interface WatchManyOptions {
    /** If true, fire once at registration with `changedIndex = -1` and `oldValues` mirroring `values`. */
    immediate?: boolean;
    /** If true, pass fresh `values`/`oldValues` arrays per fire instead of the reused buffers. */
    copy?: boolean;
}

/** Handle returned by {@link pausableWatch}. */
export interface PausableWatchHandle {
    /** Tear down the watcher permanently. Idempotent. Afterwards pause/resume are no-ops. */
    stop: () => void;
    /** Suppress the callback; the underlying watcher stays alive. */
    pause: () => void;
    /** Resume callback delivery. With `fireOnResume`, fires once if the value changed while paused. */
    resume: () => void;
    /** True while paused. */
    readonly isPaused: boolean;
}

/**
 * Deliver a rolling history of a source's recent values on every change.
 * Callback receives `(current, history, stop)`; `history` is the previous
 * `depth` values, most-recent-first, in a buffer reused per fire (see `copy`).
 * History length is always `depth`; not-yet-filled slots are `undefined`.
 */
export function watchPrevious<T>(
    source: () => T,
    callback: (current: T, history: Array<T | undefined>, stop: () => void) => void,
    options?: WatchPreviousOptions
): () => void;

/**
 * Ongoing watcher that fires only when `predicate(newValue, oldValue)` is
 * truthy on a changed value. Keeps watching (unlike `watchUntil`).
 */
export function watchChanged<T>(
    source: () => T,
    predicate: (newValue: T, oldValue: T | undefined) => unknown,
    callback: (newValue: T, oldValue: T | undefined, stop: () => void) => void,
    options?: WatchChangedOptions
): () => void;

/**
 * Pausable ongoing watcher. Returns a handle with `pause`/`resume`/`stop` and a
 * readonly `isPaused`. Pausing suppresses the callback without tearing down the
 * watcher.
 */
export function pausableWatch<T>(
    source: () => T,
    callback: (newValue: T, oldValue: T | undefined, stop: () => void) => void,
    options?: PausableWatchOptions
): PausableWatchHandle;

/**
 * Watch a fixed tuple of sources; fire when any changes. Callback receives
 * `(values, oldValues, changedIndex, stop)` -- `changedIndex` is the lowest
 * changed index (-1 on the initial immediate fire). Arrays are reused per fire
 * unless `copy` is set.
 */
export function watchMany<T>(
    sources: Array<() => T>,
    callback: (values: T[], oldValues: T[], changedIndex: number, stop: () => void) => void,
    options?: WatchManyOptions
): () => void;

// Re-exports from @zakkster/lite-signal -- types live there.
export { watch, when, whenAsync } from "@zakkster/lite-signal";
