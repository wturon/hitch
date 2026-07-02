# Refactor the sync engine

The daemon should debounce writes and coalesce bursts before pushing to Convex.

## Goals

- Cut redundant round-trips on rapid saves
- Preserve **exact byte content** so git diffs stay clean
- Keep the *fast path* fast

## Open questions

1. Where does the debounce window live?
2. How do we test echo suppression?
   1. Unit level with a fake clock
   2. Integration against a real watcher

> Note: this touches the [file sync](https://example.com/sync) path, so tread carefully.

See `upsertFile` and the `listFiles` query for the current shape.
