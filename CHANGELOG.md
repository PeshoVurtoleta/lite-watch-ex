# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- `stop()` on `watchOnce`, `watchUntil`, `watchPrevious`, `pausableWatch`
  and `watchMany` drops its references to observed values and buffers, so a
  retained `stop` handle no longer keeps them reachable. (`watchChanged`
  returns core `watch`'s `stop`, which still holds its last values in
  lite-signal 1.5.2.)

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

## [1.1.0] - 2026-06-05

### Added

- `watchPrevious(source, callback, options?)` -- rolling-history watcher.
  Delivers `(current, history, stop)` where `history` is the previous `depth`
  values (default 1), most-recent-first, in a reused buffer. At `depth > 1` it
  is a fixed window for velocity, smoothing, or delta work. `copy: true` opts
  into a fresh array per fire.
- `watchChanged(source, predicate, callback, options?)` -- ongoing watcher gated
  by a `(newValue, oldValue)` predicate. Fires on every passing change (unlike
  `watchUntil`, which fires once). Wraps `watch`; zero per-fire allocation.
- `pausableWatch(source, callback, options?)` -- pausable ongoing watcher
  returning `{ stop, pause, resume, isPaused }`. Gating model keeps the node
  alive across pause/resume cycles. `fireOnResume: true` delivers one catch-up
  `(current, valueAtPause)` on resume if the value changed while paused.
- `watchMany(sources, callback, options?)` -- multi-source watcher. Fires when
  any source changes with `(values, oldValues, changedIndex, stop)`;
  `changedIndex` is the lowest changed index (-1 on the initial immediate fire).
  `values`/`oldValues` are reused buffers; `copy: true` opts into fresh arrays.

### Changed

- Normalized all source and documentation text to ASCII (no em-dashes, arrows,
  ellipses, or emoji) for grep/search predictability and a uniform glyph
  standard across the package.
- Added this changelog (the 1.0.0 release shipped without one).

## [1.0.0] - 2026-05-20

### Added

- Initial release: `watchOnce`, `watchUntil`, `watchEffect`. Re-exports the core
  `watch`, `when`, `whenAsync` from `@zakkster/lite-signal`. Zero-GC hot path,
  ESM-only, MIT.
