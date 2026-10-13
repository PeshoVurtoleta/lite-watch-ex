// AUDIT 6 probe: after stop(), does a retained `stop` handle keep the last
// observed value reachable? Needs --expose-gc:
//
//   node --expose-gc bench/retention.mjs
//
// Each case: the source moves past a large object, the watcher is stopped,
// the stop handle is kept alive, and a WeakRef reports whether the object
// survived a full GC. Expected on the fixed build: every line prints false.

import { signal } from "@zakkster/lite-signal";
import {
    watchOnce, watchUntil, watchPrevious, pausableWatch, watchMany,
} from "../WatchEx.js";

const keep = [];

// Synchronous, so `big` lives only in this frame -- not in a suspended async
// frame's registers, which would keep it alive and mask the result.
function setup(run) {
    const s = signal(0);
    const big = { payload: new Array(1e5).fill(1) };
    keep.push(run(s, big));
    s.set(-1);                 // the signal itself no longer holds `big`
    return new WeakRef(big);
}

async function probe(name, run) {
    const ref = setup(run);
    await new Promise((r) => setTimeout(r, 0));
    globalThis.gc(); globalThis.gc();
    console.log(name.padEnd(28) + "retained=" + (ref.deref() !== undefined));
}

await probe("watchOnce", (s, big) => {
    const stop = watchOnce(s, () => {}, { immediate: false });
    s.set(big); stop(); return stop;
});
await probe("watchUntil", (s, big) => {
    const stop = watchUntil(s, () => false, () => {});
    s.set(big); stop(); return stop;
});
await probe("watchPrevious", (s, big) => {
    const stop = watchPrevious(s, () => {}, { depth: 2 });
    s.set(big); s.set(1); stop(); return stop;
});
await probe("pausableWatch", (s, big) => {
    const w = pausableWatch(s, () => {}, { fireOnResume: true });
    s.set(big); w.pause(); s.set(1); w.stop(); return w;
});
await probe("watchMany", (s, big) => {
    const stop = watchMany([s], () => {});
    s.set(big); stop(); return stop;
});
