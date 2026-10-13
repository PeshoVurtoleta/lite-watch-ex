# @zakkster/lite-watch-ex

> Extended watcher utilities for `@zakkster/lite-signal`: one-shot watchers, predicate-gated watchers, Vue-style `watchEffect`. Zero-GC hot path. Re-exports the core `watch`, `when`, `whenAsync` for convenience.

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-watch-ex.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-watch-ex)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Hot%20path-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-watch-ex?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-watch-ex)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-watch-ex?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-watch-ex)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-watch-ex?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-watch-ex)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational?style=flat-square)
[![lite-signal peer](https://img.shields.io/npm/dependency-version/@zakkster/lite-watch-ex/peer/@zakkster/lite-signal?style=for-the-badge&color=blue)](https://github.com/PeshoVurtoleta/lite-signal)
![Dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen?style=flat-square)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE.txt)

```bash
npm install @zakkster/lite-watch-ex @zakkster/lite-signal
```

```js
import { signal } from "@zakkster/lite-signal";
import { watchOnce, watchUntil, watchEffect } from "@zakkster/lite-watch-ex";

const status = signal("loading");

// Fire once on the first non-equal change, then self-dispose.
watchOnce(status, (next) => initialize(next));

// Fire when a predicate first passes on a changed value, then self-dispose.
watchUntil(
    () => player.health(),
    (h) => h <= 25,
    (h) => showLowHealthWarning(h)
);

// effect() with onCleanup pre-injected (Vue-style).
watchEffect((onCleanup) => {
    const id = requestAnimationFrame(render);
    onCleanup(() => cancelAnimationFrame(id));
});

status.set("ready");   // watchOnce fires once, then disposes
```

One-shot watchers self-dispose synchronously when they fire -- the effect node returns to lite-signal's pool, not just silenced by a flag. Per source change in steady state, zero JS-heap allocations from this file.

---

## Contents

- [Why this exists](#why-this-exists)
- [What you get](#what-you-get)
- [API reference](#api-reference)
- [Examples](#examples)
- [When to use which](#when-to-use-which)
- [Semantics worth knowing](#semantics-worth-knowing)
- [Allocation profile](#allocation-profile)
- [Testing](#testing)
- [License](#license)

---

## Why this exists

`@zakkster/lite-signal` ships `watch`, `when`, and `whenAsync` for general-purpose reactive observation. They're complete for ongoing watchers and one-shot truthiness gates, but two common patterns fall outside their surface:

- **One-shot watcher with old/new pair.** `when` doesn't pass `(next, prev)` -- it's "fire callback with no args when truthy". `watchOnce` is `watch` that auto-disposes after the first non-equal change.
- **Predicate-gated watcher with old/new pair.** `when` projects through truthiness; `watchUntil` lets the predicate inspect the projected value and passes both old and new to the callback.
- **Vue ergonomics.** `watchEffect((onCleanup) => { ... })` is a familiar shape for users coming from Vue 3. Plain `effect()` works identically with a manual `onCleanup` import, but the wrapper saves the import and reads cleanly inline.

All three are thin layers on top of `effect` + `untrack` + `onCleanup`. They follow the same zero-GC contract as the rest of the `lite-*` stack: setup-time closures only, no per-fire allocation in steady state, dispose returns the effect node to the pool.

---

## What you get

- **`watchOnce(source, callback, options?)`** -- fire once on the first non-equal change (or immediately, if `options.immediate === true`), then self-dispose.
- **`watchUntil(source, predicate, callback, options?)`** -- fire once when the `(new, old)` predicate first passes on a changed value, then self-dispose.
- **`watchEffect(callback)`** -- `effect()` with `onCleanup` pre-injected as a callback argument. Identical alloc profile to plain `effect()`.

- **`watchPrevious(source, callback, options?)`** -- rolling history of the last `depth` values (default 1), most-recent-first, in a reused buffer. Velocity, smoothing, deltas.
- **`watchChanged(source, predicate, callback, options?)`** -- ongoing watcher gated by a `(new, old)` predicate. Fires on every passing change.
- **`pausableWatch(source, callback, options?)`** -- pausable ongoing watcher; returns `{ stop, pause, resume, isPaused }`. Optional one-shot catch-up on resume.
- **`watchMany(sources, callback, options?)`** -- watch a fixed tuple of sources; fires with `(values, oldValues, changedIndex, stop)`.

Plus the canonical core utilities re-exported for convenience (importing from either package resolves to the same function):

- **`watch(source, callback, options?)`** -- ongoing watcher with `(next, prev, stop)`.
- **`when(predicate, callback)`** -- fire once when predicate first truthy. No old/new pair.
- **`whenAsync(predicate)`** -- Promise-returning variant of `when`. (!) allocates a Promise per call -- see lite-signal's README for the hot-path warning.

All three one-shot watchers return a `stop()` function. It's idempotent, safe to call before the watcher has fired, and a no-op after self-dispose.

---

## API reference

### `watchOnce(source, callback, options?)`

```ts
function watchOnce<T>(
    source: () => T,
    callback: (newValue: T, oldValue: T | undefined) => void,
    options?: { immediate?: boolean }
): () => void;
```

Watch a reactive source, fire `callback` exactly once on the first non-equal change, then self-dispose. With `{ immediate: true }`, fires synchronously at registration with `oldValue = undefined` and disposes immediately.

Equality is `Object.is`. `NaN`-to-`NaN` is a no-op. Internal callback reads are untracked: side-effects don't accidentally re-track the source.

### `watchUntil(source, predicate, callback, options?)`

```ts
function watchUntil<T>(
    source: () => T,
    predicate: (newValue: T, oldValue: T | undefined) => unknown,
    callback: (newValue: T, oldValue: T | undefined) => void,
    options?: { immediate?: boolean }
): () => void;
```

Watch a reactive source until `predicate(newValue, oldValue)` first returns truthy. On the initial run, fires immediately if the predicate is already truthy (with `oldValue = undefined`); pass `{ immediate: false }` to skip that check and wait for the first change. On subsequent runs, fires only when both the value changes AND the predicate passes. Self-disposes on fire.

The predicate sees the old value too, so delta conditions work: `(next, prev) => prev !== undefined && next - prev > 10`.

Distinct from `when`: `watchUntil` passes the projected value plus its previous value to the callback. `when` is "wait for truthy, fire callback with no arguments" -- use it when you don't need the value.

### `watchEffect(callback)`

```ts
function watchEffect(
    callback: (onCleanup: (fn: () => void) => void) => void
): () => void;
```

`effect()` with `onCleanup` pre-injected as a callback argument. Matches the Vue `watchEffect` ergonomic.

Functionally identical to:

```js
import { effect, onCleanup } from "@zakkster/lite-signal";
const stop = effect(() => {
    onCleanup(() => releaseSomething());
    // ... reactive body ...
});
```

The wrapper exists for API surface only. No per-fire allocation cost.

---

## Examples

**Wait for first state transition, then initialize:**

```js
import { signal } from "@zakkster/lite-signal";
import { watchOnce } from "@zakkster/lite-watch-ex";

const status = signal("loading");
watchOnce(status, (next) => {
    if (next === "ready") bootstrap();
});
status.set("ready");   // fires; watcher disposes
status.set("idle");    // inert
```

**Low-health alert that fires once and stops:**

```js
import { watchUntil } from "@zakkster/lite-watch-ex";

watchUntil(
    () => player.health(),
    (h) => h <= 25,
    (h) => hud.showWarning(`Health critical: ${h}`)
);
```

**rAF-cancelled cleanup with `watchEffect`:**

```js
import { signal } from "@zakkster/lite-signal";
import { watchEffect } from "@zakkster/lite-watch-ex";

const cursor = signal({ x: 0, y: 0 });

const stop = watchEffect((onCleanup) => {
    const { x, y } = cursor();
    const rafId = requestAnimationFrame(() => renderCursor(x, y));
    onCleanup(() => cancelAnimationFrame(rafId));
});
```

**Immediate-mode `watchOnce` -- fire-and-forget initialization tied to a signal:**

```js
import { watchOnce } from "@zakkster/lite-watch-ex";

watchOnce(currentUser, (user) => greet(user), { immediate: true });
// Fires synchronously with the current value, then disposes.
```

---

## When to use which

| You want                                              | Use                              |
| ----------------------------------------------------- | -------------------------------- |
| Ongoing watcher with `(next, prev, stop)`             | `watch` (from lite-signal)       |
| Fire once on first non-equal change                   | `watchOnce(src, cb)`             |
| Fire once on first non-equal change + immediate run   | `watchOnce(src, cb, { immediate: true })` |
| Fire once when a predicate passes on a changed value  | `watchUntil(src, pred, cb)`      |
| Fire once when a predicate first truthy, no old/new   | `when(pred, cb)`                 |
| Same, but await as a Promise (rare paths only)        | `whenAsync(pred)` -- see warning  |
| Effect with `onCleanup` as callback arg               | `watchEffect((onCleanup) => ...)`  |
| Effect without it                                     | `effect(() => ...)` (lite-signal)  |

The one-shot watchers are not just convenience over `watch` + a manual `stop()` call -- they release the effect node to the pool synchronously on fire. A `watch` that the user disposes manually does the same thing, but the bookkeeping is one line in each callback. `watchOnce` and `watchUntil` make the contract explicit and uncrossable.

---

## Semantics worth knowing

- **Self-dispose is real, and happens before the callback.** When a one-shot fires, the node is disposed and returned to the pool first, then the callback runs. A throwing callback cannot leak the node, and effects created inside the callback are not adopted (and immediately cascade-disposed) by the dying watcher. Subsequent source changes don't reach the watcher -- there's nothing left to reach.
- **`stop()` is idempotent and late-binding.** Safe to call before the watcher fires (cancels pre-emptively), safe to call from inside an immediate-mode callback on the very first run (deferred until `effect()` returns), safe to call multiple times.
- **`Object.is` for equality.** `NaN`-to-`NaN` is a no-op; `+0`/`-0` distinct. Matches the rest of the lite-signal contract.
- **Callback internal reads are untracked.** A `watchOnce` callback that reads other signals to perform side-effects won't accidentally subscribe -- the watcher only re-fires on the original `source`'s deps. Identical to core `watch`.
- **`watchEffect`'s `onCleanup` is the same as the standalone one.** It's the context-aware function imported from lite-signal, pre-passed for ergonomic convenience. Both work; pick the one that reads better at the call site.
- **`watchUntil` initial check is synchronous.** If the predicate is already truthy when you register, the callback fires synchronously inside the registration call with `oldValue = undefined` (after the node is released). Important if you rely on dispose timing for setup ordering. `{ immediate: false }` turns the initial check off.
- **A throwing callback leaves `watchPrevious` / `watchMany` coherent.** `watchPrevious` commits its history before the callback; `watchMany` (non-copy) commits `oldValues` in a `finally` after it, because the buffer must stay pre-change while the callback reads it. Either way the next change reports a coherent history / `oldValues` / `changedIndex`. `watchChanged` and `pausableWatch` sit on core `watch`, which (as of lite-signal 1.5.2) commits its old value after the callback, so a throw there makes the next fire report the stale `oldValue`.
- **Writes to the source from inside the callback are not re-delivered to the same watcher.** lite-signal never re-runs an effect inside its own body: a synchronous write to the watched source from the callback is skipped by the engine's self-cycle guard, and a cascade through another effect runs after the current fire completes, never nested inside it.
- **`stop()` releases observed values.** Holding on to a `stop` handle from `watchOnce`, `watchUntil`, `watchPrevious`, `pausableWatch` or `watchMany` (for example in a cleanup array) does not keep the last observed values, history, or tuple buffers reachable. `watchChanged` returns core `watch`'s `stop`, which (as of lite-signal 1.5.2) still holds its last values.

---

## Allocation profile

| Op                                | JS-heap allocations from this file | Notes |
| --------------------------------- | ----------------------------------- | ----- |
| `watchOnce()` registration        | 1 effect node, links + 3 closures   | One-time, from the pool. The hoisted `untrackedFire` body is allocated once and reused. |
| `watchUntil()` registration       | 1 effect node, links + 3 closures   | Same shape as `watchOnce`. |
| `watchEffect()` registration      | 1 effect node, links + 1 closure    | Just the effect body. `onCleanup` is the imported function reference, not allocated. |
| Per source change (steady state)  | **0**                              | The `untrack(untrackedFire)` call reuses a single hoisted closure. |
| Per self-dispose on fire          | **0**                              | Releases the node back to lite-signal's pool. |
| `stop()` called externally        | **0**                              | Idempotent flag flip + node release. |

The "ZERO-GC HOT PATH" comment in lite-signal's `Watch.js` exists to warn against declaring `untrack(() => { ... })` inline inside the effect body -- V8 allocates a fresh closure per fire. This package follows the hoisted-closure pattern: shared state via closure-scoped variables (`currentNewValue`, `oldValue`, `fired`), single reused `untrackedFire` reference.

---

## Testing

```bash
npm test          # behavior suite (node:test)
npm run test:gc   # adds --expose-gc; the steady-state heap-delta guard engages
```

The GC-required test skips silently when `globalThis.gc` is absent, so `npm test` is clean without `--expose-gc`; `npm run test:gc` engages it. Suite covers:

- First-change fire and self-dispose, both modes
- Immediate-mode synchronous fire with early `stop()`
- `Object.is` short-circuit (including `NaN`)
- Predicate-already-truthy initial fire
- External dispose before fire
- Re-entrant source write from inside the callback
- `onCleanup` registration and re-run cleanup in `watchEffect`
- Rolling history windows (`watchPrevious`): depth 1 and 3, reused-buffer identity, `copy`, `NaN` no-op
- Predicate-gated ongoing delivery (`watchChanged`), immediate predicate, callback self-stop
- Pause/resume gating and single catch-up on resume (`pausableWatch`)
- Multi-source fire with `changedIndex`, lowest-index under batch, `copy` (`watchMany`)
- Steady-state heap-delta guard (`--expose-gc`)

---

## Added in 1.1.0

Four new watchers, same zero-GC contract (setup-time closures only, no per-fire
allocation in steady state).

### `watchPrevious(source, callback, options?)`

```ts
function watchPrevious<T>(
    source: () => T,
    callback: (current: T, history: Array<T | undefined>, stop: () => void) => void,
    options?: { depth?: number; immediate?: boolean; copy?: boolean }
): () => void;
```

A rolling-history watcher. The callback gets `(current, history, stop)`, where
`history` holds the previous `depth` values, most-recent-first (`history[0]` is
the immediately previous value). At `depth: 1` (default) it is a plain old-value
buffer; at `depth > 1` it is a fixed window for velocity, smoothing, or delta
work. The history array is allocated once and reused per fire (an in-place
shift, no allocation); pass `copy: true` to receive a fresh snapshot. History
length is always `depth` -- not-yet-filled slots are `undefined`, and the
current value is never included.

```js
// Delta over the last value
watchPrevious(score, (now, [prev]) => {
    if (prev !== undefined) hud.showDelta(now - prev);
});

// Velocity over a 3-sample window (newest-first history)
watchPrevious(() => pointer.x(), (x, recent) => {
    if (recent[1] !== undefined) velocity = (x - recent[1]) / 2;
}, { depth: 3 });
```

### `watchChanged(source, predicate, callback, options?)`

```ts
function watchChanged<T>(
    source: () => T,
    predicate: (newValue: T, oldValue: T | undefined) => unknown,
    callback: (newValue: T, oldValue: T | undefined, stop: () => void) => void,
    options?: { immediate?: boolean }
): () => void;
```

An ongoing watcher gated by a predicate over `(new, old)`. Fires on every change
that passes -- unlike `watch` (fires on all changes) and `watchUntil` (fires
once, then disposes). Use it for deltas, thresholds, or epsilon gates without an
`if` at the top of every callback.

```js
// Only when a value increases
watchChanged(level, (now, prev) => prev === undefined || now > prev,
    (now) => playLevelUp(now));
```

### `pausableWatch(source, callback, options?)`

```ts
function pausableWatch<T>(
    source: () => T,
    callback: (newValue: T, oldValue: T | undefined, stop: () => void) => void,
    options?: { immediate?: boolean; fireOnResume?: boolean }
): { stop: () => void; pause: () => void; resume: () => void; readonly isPaused: boolean };
```

An ongoing watcher you can pause and resume. Pausing suppresses the callback but
keeps the watcher alive -- pause/resume cycles cost zero reallocation, and the
value baseline is preserved. With `fireOnResume: true`, a single catch-up fire
delivers `(current, valueAtPause)` on resume if the value changed while paused
(an A-B-A excursion back to the pause value does not fire). After `stop()` --
from the handle or from the callback's `stop` argument -- `pause()` and
`resume()` are inert and `isPaused` is `false`.

```js
const w = pausableWatch(cursor, (p) => render(p));
openModal();  w.pause();     // freeze live rendering
closeModal(); w.resume();    // back to live
w.stop();                    // tear down
```

### `watchMany(sources, callback, options?)`

```ts
function watchMany<T>(
    sources: Array<() => T>,
    callback: (values: T[], oldValues: T[], changedIndex: number, stop: () => void) => void,
    options?: { immediate?: boolean; copy?: boolean }
): () => void;
```

Watch a fixed tuple of sources; fire when any changes. The callback gets
`(values, oldValues, changedIndex, stop)`. `changedIndex` is the source that
triggered the fire (the lowest index if several changed in one batch; `-1` on
the initial immediate fire) -- an O(1) "which one" without diffing the arrays
yourself. `values`/`oldValues` are reused buffers (do not retain across fires);
pass `copy: true` for fresh arrays.

```js
watchMany([() => width(), () => height()], (vals, _old, i) => {
    layout(vals[0], vals[1]);
    if (i === 0) console.log("width drove this relayout");
});
```

**Allocation.** All four allocate setup-time closures (and, for `watchPrevious`
and `watchMany`, one or two reused buffers) once at registration. Per change in
steady state: zero JS-heap allocations, unless `copy: true` is set (then one
array per fire for `watchPrevious`, two for `watchMany`).

**When to reach for them.** `watchPrevious` for deltas, velocity, or smoothing;
`watchChanged` for conditional ongoing observation; `pausableWatch` for
observation you need to gate (modals, tab visibility, drag sessions);
`watchMany` for derived work that depends on several sources at once.

---

## License

MIT (c) Zahary Shinikchiev

---

> Part of the **@zakkster** zero-GC stack: [`lite-signal`](https://www.npmjs.com/package/@zakkster/lite-signal) - [`lite-debounce`](https://www.npmjs.com/package/@zakkster/lite-debounce) - [`lite-throttle`](https://www.npmjs.com/package/@zakkster/lite-throttle) - [`lite-ecs`](https://www.npmjs.com/package/@zakkster/lite-ecs) - [`lite-ease`](https://www.npmjs.com/package/@zakkster/lite-ease) - [`lite-pointer-tracker`](https://www.npmjs.com/package/@zakkster/lite-pointer-tracker) - [`lite-bmfont`](https://www.npmjs.com/package/@zakkster/lite-bmfont) - [`lite-color`](https://www.npmjs.com/package/@zakkster/lite-color)
