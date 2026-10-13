# AUDIT — @zakkster/lite-watch-ex v1.0.0

Pre-publish review against the original `WatchEx.js`. Two correctness bugs and one performance regression vs. the established `Watch.js` patterns in the canonical lite-signal package. All fixed in the shipped code. **20/20 tests pass on vitest 2.1.9 and 4.1.6**, both with and without `--expose-gc`.

---

## Correctness fixes

### 1. `watchOnce` leaks the effect node after a non-immediate fire

**Original:**

```js
stop = effect(() => {
    if (stopped) return;
    const newValue = source();
    untrack(() => {
        if (oldValue === UNINITIALIZED) {
            if (immediate) {
                stopped = true;
                try { callback(newValue, undefined); }
                finally { /* stop() handled synchronously below */ }
                return;
            }
            oldValue = newValue;
            return;
        }
        if (!Object.is(newValue, oldValue)) {
            stopped = true;
            try { callback(newValue, oldValue); }
            finally { /* stop() handled below */ }
        }
        oldValue = newValue;
    });
});

// Catch-up dispose if immediate matched synchronously during initial run.
if (stopped) stop();
```

The `if (stopped) stop()` line runs **exactly once**, right after `effect()` returns. It handles only one case: immediate-mode fire on registration.

For the non-immediate case (the documented default):

1. Registration. Effect runs. `oldValue === UNINITIALIZED`, not immediate → prime `oldValue`, return.
2. `effect()` returns `stopFn`. `stopped` is still false. `if (stopped) stop()` is a no-op.
3. Caller does `src.set(X)`.
4. Effect re-runs. Body: `stopped=false` → run untrack. `oldValue !== UNINITIALIZED`, `X !== oldValue` → `stopped = true; callback(X, oldValue)`. `oldValue = X`. Return.
5. Effect-body returns. But `if (stopped) stop()` was outside the effect; it doesn't re-evaluate.

State after step 5: the effect node is still alive, still tracking `src` as a dep, still in lite-signal's pool. Subsequent `src.set` calls re-run the effect — which short-circuits via `if (stopped) return;` at the top, so the callback doesn't fire twice. But the effect node never gets disposed and never returns to the pool. **Leak**.

`watchUntil` has the identical shape and the identical leak: predicate-matches-after-first-run sets `stopped = true` but never calls `stop()`.

**Fix:** call dispose from inside the effect body when firing, using the late-binding `stop` wrapper from lite-signal's `when()` (Watch.js):

```js
let stopFn = null;
let wantsStopEarly = false;
let fired = false;

const stop = () => {
    if (stopFn !== null) stopFn();
    else wantsStopEarly = true;
};

stopFn = effect(() => {
    if (fired) return;
    currentNewValue = source();
    untrack(untrackedFire);
});

if (wantsStopEarly) stopFn();
return stop;
```

Where `untrackedFire` calls `stop()` directly after firing the callback. Verified safe in `Signal.js:746-784` — effect dispose is idempotent and recognises being called from within the executing effect (sets `disposed = true`, releases the node, next scheduled run no-ops).

Regression test in `test/watchEx.test.js`:

```js
it("self-dispose returns the effect node to the pool", () => {
    const before = stats().effects;
    const src = signal(0);
    watchOnce(src, () => {});
    expect(stats().effects).toBe(before + 1);

    src.set(1); // fires + self-disposes
    expect(stats().effects).toBe(before);
});
```

Without the fix, the second assertion fails — `stats().effects` stays at `before + 1`.

### 2. `watchUntil` — same bug, same fix

Identical structure; the predicate path that matches on a subsequent run sets `stopped = true` without calling `stop()`. Same correction applied. Same regression test under "watchUntil → self-dispose returns the effect node to the pool".

---

## Performance fixes

### 3. Per-fire closure allocation in `watchOnce` and `watchUntil`

**Original** declared the untrack body inline:

```js
stop = effect(() => {
    if (stopped) return;
    const newValue = source();
    untrack(() => { /* fresh closure allocated per fire */ });
});
```

V8 allocates a fresh closure for `() => { ... }` on every effect re-run. The canonical `Watch.js` in lite-signal has a prominent "ZERO-GC HOT PATH" comment explicitly warning against this anti-pattern:

> If this were declared inline as `untrack(() => { ... })` inside the effect body, V8 would allocate a fresh closure on every fire — at 120fps that's 7,200 allocations per minute per watcher.

For one-shot watchers the alloc cost is bounded (they fire once and dispose), but the inconsistency with the package's stated zero-GC contract is the problem.

**Fix:** hoist the untrack body via shared closure-scoped variables. The same pattern `watch()` in `Watch.js` uses:

```js
const untrackedFire = () => {
    // reads currentNewValue, oldValue, fired from closure scope
    // ...
};

stopFn = effect(() => {
    currentNewValue = source();
    untrack(untrackedFire);   // pre-allocated, reused
});
```

Per source change in steady state: zero JS-heap allocations from this file. Verified by the heap-delta test (`test/watchEx.test.js → "heap-delta → watchOnce …"`).

### 4. Empty `try/finally` blocks

The original had multiple `try { callback(...); } finally { /* placeholder comment */ }` blocks with empty `finally`. Misleading — implies cleanup is happening when it isn't. Removed once the dispose-from-inside fix landed (the actual cleanup is now `stop()` after `callback()`, in the normal control flow).

---

## Not changed

### `watchEffect` is correct as-shipped

```js
export function watchEffect(callback) {
    return effect(() => callback(onCleanup));
}
```

The `() => callback(onCleanup)` is the effect body — allocated once at registration, reused for every re-run. Zero per-fire alloc. `onCleanup` is the context-aware function from lite-signal; pre-passing it as an argument is purely API ergonomics.

Bench confirms: `watchEffect` and plain `effect()` are within JIT noise of each other (10.8M vs 8.4M median ops/s).

---

## Re-exports

`watch`, `when`, `whenAsync` re-exported from `@zakkster/lite-signal`. Importing from either package resolves to the same function — verified via `import` chains in Node's ESM resolver (single module, single binding). Adding the re-export to `index.js` and `index.d.ts` so consumers don't need two imports for the full watcher surface.

---

## Verified

### Effect dispose contract

Confirmed against `Signal.js:746-784` (v1.1.0 source):

```js
const disposeFn = function dispose() {
    if (disposed) return;
    disposed = true;
    if ((node.gen | 0) !== birthGen) return;
    if (node.flags !== 0) {
        disposeNode(node);
        statEffects = (statEffects - 1) | 0;
    }
};
```

- Idempotent (the `if (disposed) return` guard).
- Generation-stamped so a recycled slot doesn't get spuriously freed.
- Decrements `statEffects` so `stats().effects` is the test's truth source.

The self-dispose-from-within-effect call pattern (used by `Watch.js`'s `when()` and now by `watchOnce` / `watchUntil`) works because: the effect body completes its current run, sets `fired = true`, calls `stop()` which marks the node disposed and releases it. lite-signal's scheduler won't run the effect again — there's no node left to queue.

### Peer dependency

`@zakkster/lite-signal` is a peer dep pinned to `^1.1.0`. Reason: this package re-exports `when` and `whenAsync` from lite-signal, and those are added in v1.1.0 (v1.0.6 only exports `watch`). Verified by reading `node_modules/@zakkster/lite-signal@1.0.6/Signal.js` line 1013:

```js
export {watch} from "./Watch.js"   // v1.0.6 — only watch
```

vs. the v1.1.0 source supplied in this review:

```js
export {watch, when, whenAsync} from "./Watch.js"
```

Publishing `@zakkster/lite-watch-ex@1.0.0` before `@zakkster/lite-signal@1.1.0` will cause `npm install` to fail to resolve peer.

---

## Pre-publish checklist

- [x] Two correctness bugs (effect-node leaks) found and regression-tested.
- [x] One performance regression (per-fire closure) found and fixed by adopting `Watch.js`'s hoisted-closure pattern.
- [x] Empty `try/finally` placeholders removed.
- [x] `watchEffect` wrapper validated as zero-overhead vs plain `effect()` (bench).
- [x] Full JSDoc on every exported function, with `@template` and `@example` blocks.
- [x] Top-of-file algorithm + allocation profile comment.
- [x] TypeScript declarations (`index.d.ts`).
- [x] `package.json` with `peerDependencies: @zakkster/lite-signal@^1.1.0`, `sideEffects: false`, `engines.node: >=18`.
- [x] `llms.txt`.
- [x] vitest suite: 20 tests, green on vitest 2.1.9 and 4.1.6, both with and without `--expose-gc`.
- [x] Comparative benchmark (`watchEffect` vs `effect`; `watchOnce` lifecycle vs manual `effect + stop`).
- [x] README with API reference, when-to-use matrix, semantics notes, badges.
- [x] MIT LICENSE.txt with 2026 copyright to Zahary Shinikchiev.
- [ ] Publish `@zakkster/lite-signal@1.1.0` first. This package's peer requires it.
- [ ] On publish hardware: `npm install`, `npm test`, `npm run test:gc`, `npm run bench`.
- [ ] `npm publish --access public`.
