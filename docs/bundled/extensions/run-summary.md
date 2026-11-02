# Run summary

Shows one dim transcript line after each continuous agent run in interactive mode:

```text
Worked for 1m 52s · Done 2026/10/28 13:14
```

The elapsed time covers the whole run, including model requests, tool execution, retries, and steering. A steering message does not end the run or produce an intermediate note; the summary appears only after Pi becomes idle. Follow-up work queued into the same run is included as well. A normal run ends with `Done`; a manually aborted run ends with `Stopped`, so sending a new prompt after an interruption still leaves a clear boundary before it.

Durations use the same compact format as Tasks: zero components are omitted, for example `8s`, `1m`, `1m 5s`, and `1h 5m`. The completion timestamp is local time in `YYYY/MM/DD HH:mm` format.

Each settled run appends a small `run-summary` custom entry containing the anchor entry ID, start and finish times, and outcome, and the extension's entry renderer draws that entry as the dim line above. The entries do not enter model context and are hidden by the default tree filter. Display text is reconstructed from the record rather than stored, and the line follows the `outputPad` setting.

Because the line is the entry itself, it reappears in place whenever Pi rebuilds the transcript, such as on startup, `/reload` and branch navigation, as long as the entry is on the active branch. Navigating to the run's last message leaves the summary entry off the branch, so the line is not shown there. Runs recorded before this feature existed are not estimated or backfilled.

Disable `builtin:run-summary` to hide these lines.
