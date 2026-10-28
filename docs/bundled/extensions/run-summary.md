# Run summary

Shows one dim transcript note after each continuous agent run in interactive mode:

```text
Worked for 1m 52s · Done 2026/10/28 13:14
```

The elapsed time covers the whole run, including model requests, tool execution, retries, and steering. A steering message does not end the run or produce an intermediate note; the summary appears only after Pi becomes idle. Follow-up work queued into the same run is included as well. A normal run ends with `Done`; a manually aborted run ends with `Stopped`, so sending a new prompt after an interruption still leaves a clear boundary before it.

Durations use the same compact format as Tasks: zero components are omitted, for example `8s`, `1m`, `1m 5s`, and `1h 5m`. The completion timestamp is local time in `YYYY/MM/DD HH:mm` format.

Each settled run appends a small `run-summary` custom entry containing the anchor entry ID, start and finish times, and outcome. These records are bookkeeping, not chat messages: they have no entry renderer, do not enter model context, and are hidden by the default tree filter. Display text is reconstructed from the record rather than stored.

On startup, `/reload`, and branch navigation, Pi scans the active branch and projects valid records back into transcript notes. The notes survive compaction and branch navigation whenever their anchors remain visible. Runs recorded before this feature existed are not estimated or backfilled.

Disable `builtin:run-summary` to hide these notes.
