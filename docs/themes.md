# Bundled themes

This Fork bundles two Pi themes using the native theme schema and loader:

| Theme | Use |
|---|---|
| `ice-cream-dark` | Cool sea-salt dark palette with warm cream tool titles. |
| `ice-cream-light` | Light counterpart with the same semantic mapping. |

Both themes are built into `@astralyn/pi`. They do not require the external `pi-config` package.

## Selecting a theme

Use `/settings`, or set a single theme:

```json
{
  "theme": "ice-cream-dark"
}
```

For automatic terminal light/dark selection:

```json
{
  "theme": "ice-cream-light/ice-cream-dark"
}
```

The left side is used for light terminals and the right side for dark terminals.

## Design intent

The palette keeps an ice-cream / sea-salt identity: cool cyan-blue accents with warm cream tooling on a calm neutral base.

- `accent` and borders use the sea-salt family;
- `toolTitle` uses cream/gold tones;
- `toolOutput`, `muted`, and `dim` form a readable text ladder;
- tool backgrounds remain transparent so the native `●` / `│` presentation stays light;
- `success`, `error`, and `warning` remain semantic pastel colors;
- thinking levels move from cool blue through green and gold to coral/red.

## Extension UI

Bundled dialogs, overlays, and the statusline use semantic theme helpers such as `theme.fg(...)` and `theme.bg(...)`. They do not hard-code ANSI colors or hex values.

## Theme files

The source assets are:

```text
packages/coding-agent/src/modes/interactive/theme/ice-cream-dark.json
packages/coding-agent/src/modes/interactive/theme/ice-cream-light.json
```

The normal coding-agent build copies all theme JSON assets into the runtime package. The themes use the upstream schema at `packages/coding-agent/src/modes/interactive/theme/theme-schema.json`.
