# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
