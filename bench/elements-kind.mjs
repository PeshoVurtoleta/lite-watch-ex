// AUDIT 5 probe: report the V8 ElementsKind of the reused buffers handed to
// watchPrevious / watchMany callbacks. Needs natives syntax:
//
//   node --allow-natives-syntax bench/elements-kind.mjs
//
// Expected on the fixed build: every line prints holey=false.

import { signal } from "@zakkster/lite-signal";
import { watchPrevious, watchMany } from "../WatchEx.js";

const holey = new Function("a", "return %HasHoleyElements(a);");

const s = signal(0);
const t = signal(0);
let hist = null, vals = null, olds = null;
watchPrevious(s, (_c, h) => { hist = h; }, { depth: 4 });
watchMany([s, t], (v, o) => { vals = v; olds = o; });
s.set({ x: 1 });   // object values force the generic (non-SMI) elements kind
s.set({ x: 2 });

console.log("watchPrevious hist   holey=" + holey(hist));
console.log("watchMany values     holey=" + holey(vals));
console.log("watchMany oldValues  holey=" + holey(olds));
