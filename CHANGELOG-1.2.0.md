## [1.2.0] - 2026-10-13

### Fixed

- `pausableWatch`: `pause()` before the first change no longer records
  `undefined` as the value-at-pause. The true baseline is recovered from the
  inner watcher's `oldValue` on the first paused change (no extra source
  read). Fixes a wrong `oldValue` on the `fireOnResume` catch-up, a spurious
  catch-up after an A-B-A excursion, and a dropped catch-up when the value
  changed to `undefined`.
- `pausableWatch`: `resume()` after `stop()` (from the handle, or from the
  callback's `stop` argument) no longer fires the callback; `pause()` /
  `resume()` are inert and `isPaused` is `false` once stopped. The callback's
  `stop` argument is now the handle's `stop`.
- `watchOnce` / `watchUntil`: the effect node is disposed BEFORE the callback
  runs. A throwing callback no longer leaks the node from the pool, and
  effects created inside the callback are no longer adopted and immediately
  cascade-disposed by the dying watcher (immediate fires are delivered after
  registration completes, untracked, for the same reason).
- `watchPrevious`: history and baseline are committed before the callback,
  so a throwing callback no longer drops a value from the history.
- `watchMany`: the non-copy `oldValues` commit runs in `finally`, so a
  throwing callback no longer leaves a stale baseline (wrong `oldValues` and
  `changedIndex` on the next fire). Buffer identity is unchanged.
- `stop()` on every watcher drops its references to observed values and
  buffers, so a retained `stop` handle no longer keeps them reachable.

### Changed

- `watchUntil` predicate now receives `(newValue, oldValue)` (`oldValue` is
  `undefined` on the initial check), matching `watchChanged`.
- `watchUntil` accepts `options` with `immediate` (default `true`, the
  existing behavior); `immediate: false` skips the registration-time check.
- `watchPrevious` / `watchMany` buffers are built with `push()` so V8 keeps
  them PACKED instead of HOLEY (`new Array(n)` can never transition back).
- File header now lists all seven watchers.

### Added

- `test/audit.test.mjs`: one regression test per audit finding.
- `bench/elements-kind.mjs` (`--allow-natives-syntax`) and
  `bench/retention.mjs` (`--expose-gc`) probes.

