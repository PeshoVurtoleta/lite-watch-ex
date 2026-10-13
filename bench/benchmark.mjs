// bench/benchmark.mjs -- comparative benchmark for @zakkster/lite-watch-ex.
//
// Run:  node --expose-gc bench/benchmark.mjs
//
// Methodology: 5 rounds per scenario, report median + min/max so V8 JIT
// tier-up variance is visible. Heap delta is measured around the timed
// window with forceGC on both ends; near-zero per-op heap is the contract.
//
// Each new 1.1 wrapper is benched against the hand-rolled `watch`-based
// equivalent so the wrapper overhead is explicit. The wrappers should land
// within JIT noise of the manual versions -- that is the "zero per-fire
// allocation" claim, made operational.
//
// Scenarios:
//   1.  watchEffect throughput        vs plain effect()
//   2.  watchChanged                  vs watch + inline if-gate
//   3.  watchPrevious depth=1         vs watch + 1-slot history
//   4.  watchPrevious depth=4         vs watch + 4-slot in-place shift
//   5.  pausableWatch (unpaused)      vs watch + manual paused flag
//   6.  watchMany([a,b,c])            vs 3 separate watch() + peek
//   7.  watchOnce register+fire+dispose vs effect + manual stop()

import {signal, effect, watch} from "@zakkster/lite-signal";
import {
    watchEffect, watchOnce,
    watchChanged, watchPrevious, pausableWatch, watchMany,
} from "../index.js";

if (typeof globalThis.gc !== "function") {
    console.error("This benchmark requires --expose-gc. Re-run: node --expose-gc bench/benchmark.mjs");
    process.exit(1);
}

const N = 100_000;
const WARMUP = 10_000;
const ROUNDS = 5;

function forceGC() {
    globalThis.gc();
    globalThis.gc();
}

function fmtK(n) {
    return (n / 1_000).toFixed(0).padStart(6) + "K";
}

function fmtKB(n) {
    return (n / 1024).toFixed(1).padStart(7);
}

function measure(label, setup) {
    const ops = [];
    const heap = [];

    for (let r = 0; r < ROUNDS; r++) {
        const {run, teardown} = setup();

        for (let i = 0; i < WARMUP; i++) run(i);

        forceGC();
        const memBefore = process.memoryUsage().heapUsed;
        const t0 = process.hrtime.bigint();

        for (let i = 0; i < N; i++) run(i + 1_000_000 + r * N);

        const t1 = process.hrtime.bigint();
        forceGC();
        const memAfter = process.memoryUsage().heapUsed;

        teardown();

        ops.push((N * 1e9) / Number(t1 - t0));
        heap.push(memAfter - memBefore);
    }

    ops.sort((a, b) => a - b);
    heap.sort((a, b) => a - b);
    const mid = Math.floor(ROUNDS / 2);

    console.log(
        `  ${label.padEnd(46)} ` +
        `${fmtK(ops[mid])} ops/s  ` +
        `[${fmtK(ops[0])}..${fmtK(ops[ROUNDS - 1])}]  ` +
        `Δheap≈${fmtKB(heap[mid])} KB  ` +
        `${(heap[mid] / N).toFixed(2).padStart(6)} B/op`
    );
}

// A small sink the JIT cannot elide; reading sink.n at the end keeps the
// per-iteration work observable.
const sink = {n: 0};

console.log(`\n  ${"".padEnd(46)}  median ops/s        min..max`);

// ---------------------------------------------------------------------------
// 1. watchEffect vs plain effect()
// ---------------------------------------------------------------------------
console.log(`\nScenario 1: per source change re-run, N=${N.toLocaleString()}, rounds=${ROUNDS}`);

measure("watchEffect (no onCleanup)", () => {
    const src = signal(0);
    const stop = watchEffect(() => {
        sink.n = src();
    });
    return {run: (v) => src.set(v), teardown: () => stop()};
});

measure("plain effect() (baseline)", () => {
    const src = signal(0);
    const stop = effect(() => {
        sink.n = src();
    });
    return {run: (v) => src.set(v), teardown: () => stop()};
});

// ---------------------------------------------------------------------------
// 2. watchChanged vs watch + inline if-gate
// ---------------------------------------------------------------------------
console.log(`\nScenario 2: predicate-gated ongoing watcher, N=${N.toLocaleString()}, rounds=${ROUNDS}`);

measure("watchChanged (predicate always true)", () => {
    const src = signal(0);
    const stop = watchChanged(src, () => true, (n) => {
        sink.n = n;
    });
    return {run: (v) => src.set(v), teardown: () => stop()};
});

measure("watch + inline if-gate (baseline)", () => {
    const src = signal(0);
    const pred = () => true;
    const stop = watch(src, (n, o) => {
        if (pred(n, o)) sink.n = n;
    });
    return {run: (v) => src.set(v), teardown: () => stop()};
});

// ---------------------------------------------------------------------------
// 3. watchPrevious depth=1 vs watch + 1-slot history
// ---------------------------------------------------------------------------
console.log(`\nScenario 3: rolling history depth=1, N=${N.toLocaleString()}, rounds=${ROUNDS}`);

measure("watchPrevious (depth=1)", () => {
    const src = signal(0);
    const stop = watchPrevious(src, (cur, h) => {
        sink.n = cur + (h[0] === undefined ? 0 : h[0]);
    });
    return {run: (v) => src.set(v), teardown: () => stop()};
});

measure("watch + manual 1-slot prev (baseline)", () => {
    const src = signal(0);
    let prev;
    const stop = watch(src, (n) => {
        sink.n = n + (prev === undefined ? 0 : prev);
        prev = n;
    });
    return {run: (v) => src.set(v), teardown: () => stop()};
});

// ---------------------------------------------------------------------------
// 4. watchPrevious depth=4 vs watch + 4-slot in-place shift
// ---------------------------------------------------------------------------
console.log(`\nScenario 4: rolling history depth=4 (in-place shift), N=${N.toLocaleString()}, rounds=${ROUNDS}`);

measure("watchPrevious (depth=4)", () => {
    const src = signal(0);
    const stop = watchPrevious(src, (cur, h) => {
        sink.n = cur + (h[3] === undefined ? 0 : h[3]);
    }, {depth: 4});
    return {run: (v) => src.set(v), teardown: () => stop()};
});

measure("watch + manual 4-slot shift (baseline)", () => {
    const src = signal(0);
    const h = new Array(4);
    h[0] = undefined;
    h[1] = undefined;
    h[2] = undefined;
    h[3] = undefined;
    let prev;
    const stop = watch(src, (n) => {
        // mirror the wrapper's in-place shift: drop oldest, insert prev at front
        h[3] = h[2];
        h[2] = h[1];
        h[1] = h[0];
        h[0] = prev;
        sink.n = n + (h[3] === undefined ? 0 : h[3]);
        prev = n;
    });
    return {run: (v) => src.set(v), teardown: () => stop()};
});

// ---------------------------------------------------------------------------
// 5. pausableWatch (unpaused) vs watch + manual paused flag
// ---------------------------------------------------------------------------
console.log(`\nScenario 5: pausable watcher in unpaused steady state, N=${N.toLocaleString()}, rounds=${ROUNDS}`);

measure("pausableWatch (unpaused)", () => {
    const src = signal(0);
    const w = pausableWatch(src, (n) => {
        sink.n = n;
    });
    return {run: (v) => src.set(v), teardown: () => w.stop()};
});

measure("watch + manual paused flag (baseline)", () => {
    const src = signal(0);
    let paused = false;
    const stop = watch(src, (n) => {
        if (paused) return;
        sink.n = n;
    });
    return {run: (v) => src.set(v), teardown: () => stop()};
});

// ---------------------------------------------------------------------------
// 6. watchMany([a, b, c]) vs 3 separate watch() + peek
// ---------------------------------------------------------------------------
console.log(`\nScenario 6: 3-source watcher, fire on one source per iter, N=${N.toLocaleString()}, rounds=${ROUNDS}`);

measure("watchMany([a, b, c])", () => {
    const a = signal(0), b = signal(0), c = signal(0);
    const stop = watchMany([a, b, c], (v) => {
        sink.n = v[0] + v[1] + v[2];
    });
    // Rotate writes across the three sources to stress the compare loop.
    return {
        run: (v) => {
            const which = v & 3;
            if (which === 0) a.set(v);
            else if (which === 1) b.set(v);
            else c.set(v);
        },
        teardown: () => stop(),
    };
});

measure("3 separate watch() + peek (baseline)", () => {
    const a = signal(0), b = signal(0), c = signal(0);
    const stop1 = watch(a, (n) => {
        sink.n = n + b.peek() + c.peek();
    });
    const stop2 = watch(b, (n) => {
        sink.n = a.peek() + n + c.peek();
    });
    const stop3 = watch(c, (n) => {
        sink.n = a.peek() + b.peek() + n;
    });
    return {
        run: (v) => {
            const which = v & 3;
            if (which === 0) a.set(v);
            else if (which === 1) b.set(v);
            else c.set(v);
        },
        teardown: () => {
            stop1();
            stop2();
            stop3();
        },
    };
});

// ---------------------------------------------------------------------------
// 7. watchOnce register+fire+dispose vs effect + manual stop()
// ---------------------------------------------------------------------------
console.log(`\nScenario 7: one-shot register+fire+dispose, N=${N.toLocaleString()}, rounds=${ROUNDS}`);

measure("watchOnce (register, fire, self-dispose)", () => {
    const src = signal(0);
    return {
        run: (v) => {
            watchOnce(src, (next) => {
                sink.n = next;
            });
            src.set(v);
        },
        teardown: () => {
        },
    };
});

measure("effect() + manual stop() (baseline)", () => {
    const src = signal(0);
    return {
        run: (v) => {
            let oldValue;
            let primed = false;
            const stop = effect(() => {
                const next = src();
                if (!primed) {
                    oldValue = next;
                    primed = true;
                    return;
                }
                if (!Object.is(next, oldValue)) {
                    sink.n = next;
                    stop();
                }
                oldValue = next;
            });
            src.set(v);
        },
        teardown: () => {
        },
    };
});

console.log(`
Notes:
  - Sentinel sink: ${sink.n}   (ensures the JIT cannot dead-code the work)

  Scenario 1 (watchEffect vs effect): watchEffect adds one extra function call
  per re-run. Numbers should land within JIT noise of plain effect().

  Scenarios 2-5 (the 1.1 wrappers): each wrapper is benched against the
  hand-rolled watch-based equivalent. The contract is "wrapper overhead is
  within JIT noise of the manual pattern". If a wrapper line is materially
  below its baseline, the per-fire allocation contract is broken -- check
  whether any closure inside the wrapper was declared inline instead of
  hoisted at registration.

  Scenario 6 (watchMany vs 3 separate watches): watchMany trades n peek()
  calls per fire for one O(n) compare loop. For n=3 both are O(1)-ish; the
  numbers show whether consolidation costs anything in practice.

  Scenario 7 (watchOnce cycle): the wrapper adds the late-binding stop
  closure and the UNINITIALIZED sentinel branch. The gap to manual is the
  cost of the convenience and the self-dispose contract.

  Heap delta should be near-zero (often negative due to GC noise) across all
  scenarios. A positive delta proportional to N would indicate a per-fire
  allocation -- the very thing the zero-GC contract forbids.
`);
