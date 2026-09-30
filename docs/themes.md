> pi can create themes. Ask it to build one for your setup.

# Themes

Themes are JSON files that define colors for the TUI.

## Table of Contents

- [Locations](#locations)
- [Selecting a Theme](#selecting-a-theme)
- [Creating a Custom Theme](#creating-a-custom-theme)
- [Theme Format](#theme-format)
- [Color Tokens](#color-tokens)
- [Color Values](#color-values)
- [Tips](#tips)

## Locations

Pi loads themes from:

- Built-in: `system`, `dark`, `light`, `ice-cream-dark`, `ice-cream-light`
- Global: `~/.pi/agent/themes/*.json`
- Project: `.pi/themes/*.json` (only after the project is trusted)
- Packages: `themes/` directories or `pi.themes` entries in `package.json`
- Settings: `themes` array with files or directories
- CLI: `--theme <path>` (repeatable)

Disable discovery with `--no-themes`.

## Selecting a Theme

Select a theme via `/settings` or in `settings.json`:

```json
{
  "theme": "my-theme"
}
```

Without a saved theme setting, Pi uses `system`, which follows the terminal palette and appearance.

### Initial Theme

Start an interactive run with a theme without changing the saved setting:

```bash
pi --use-theme light
```

To follow terminal appearance, use `lightTheme/darkTheme` syntax:

```bash
pi --use-theme light/dark
```

The CLI value is the initial theme for that run. Choosing another theme later in `/settings` applies it immediately
and saves it normally.

## Creating a Custom Theme

1. Create a theme file:

```bash
mkdir -p ~/.pi/agent/themes
vim ~/.pi/agent/themes/my-theme.json
```

2. Define the theme with all required colors (see [Color Tokens](#color-tokens)):

```json
{
  "$schema": "https://raw.githubusercontent.com/ming-kang/pi/main/src/modes/interactive/theme/theme-schema.json",
  "name": "my-theme",
  "vars": {
    "primary": "#00aaff",
    "secondary": 242
  },
  "colors": {
    "accent": "primary",
    "border": "primary",
    "borderAccent": "#00ffff",
    "borderMuted": "secondary",
    "success": "#00ff00",
    "error": "#ff0000",
    "warning": "#ffff00",
    "muted": "secondary",
    "dim": 240,
    "text": "",
    "thinkingText": "secondary",
    "selectedBg": "#2d2d30",
    "scrollbarThumb": "#555566",
    "searchMatchBg": "#2d2d30",
    "searchMatchText": "",
    "userMessageBg": "#2d2d30",
    "userMessageText": "",
    "customMessageBg": "#2d2d30",
    "customMessageText": "",
    "customMessageLabel": "primary",
    "toolPendingBg": "#1e1e2e",
    "toolSuccessBg": "#1e2e1e",
    "toolErrorBg": "#2e1e1e",
    "toolTitle": "primary",
    "toolOutput": "",
    "mdHeading": "#ffaa00",
    "mdLink": "primary",
    "mdLinkUrl": "secondary",
    "mdCode": "#00ffff",
    "mdCodeBlock": "",
    "mdCodeBlockBorder": "secondary",
    "mdQuote": "secondary",
    "mdQuoteBorder": "secondary",
    "mdHr": "secondary",
    "mdListBullet": "#00ffff",
    "toolDiffAdded": "#00ff00",
    "toolDiffRemoved": "#ff0000",
    "toolDiffContext": "secondary",
    "syntaxComment": "secondary",
    "syntaxKeyword": "primary",
    "syntaxFunction": "#00aaff",
    "syntaxVariable": "#ffaa00",
    "syntaxString": "#00ff00",
    "syntaxNumber": "#ff00ff",
    "syntaxType": "#00aaff",
    "syntaxOperator": "primary",
    "syntaxPunctuation": "secondary",
    "thinkingOff": "secondary",
    "thinkingMinimal": "primary",
    "thinkingLow": "#00aaff",
    "thinkingMedium": "#00ffff",
    "thinkingHigh": "#ff00ff",
    "thinkingXhigh": "#ff0000",
    "thinkingMax": "#ff0088",
    "bashMode": "#ffaa00"
  }
}
```

3. Select the theme via `/settings`.

**Hot reload:** When you edit the currently active custom theme file, pi reloads it automatically for immediate visual feedback.

## Theme Format

```json
{
  "$schema": "https://raw.githubusercontent.com/ming-kang/pi/main/src/modes/interactive/theme/theme-schema.json",
  "name": "my-theme",
  "vars": {
    "blue": "#0066cc",
    "gray": 242
  },
  "colors": {
    "accent": "blue",
    "muted": "gray",
    "text": "",
    ...
  }
}
```

- `name` is required, must be unique, must not contain `/`, and cannot be `system`.
- `appearance` is optional: `"dark"` or `"light"`. Pi detects it from the colors when omitted.
- `vars` is optional. Define reusable colors here, then reference them in `colors`.
- `colors` must define all 51 required tokens. `thinkingMax`, `scrollbarThumb`, and the two search highlight tokens are optional and use the fallbacks listed below.

The `$schema` field enables editor auto-completion and validation.

## Color Tokens

Every theme must define all 51 required color tokens. The optional tokens preserve compatibility with existing themes: `thinkingMax` falls back to `thinkingXhigh`, `scrollbarThumb` and `searchMatchBg` fall back to `selectedBg`, and `searchMatchText` falls back to `text`. Other search matches use `searchMatchText` on `searchMatchBg` with an underline; the current match reverses that foreground/background pair and uses bold text.

### Core UI (11 colors)

| Token | Purpose |
|-------|---------|
| `accent` | Primary accent (logo, selected items, cursor) |
| `border` | Normal borders |
| `borderAccent` | Highlighted borders |
| `borderMuted` | Subtle borders (editor) |
| `success` | Success states |
| `error` | Error states |
| `warning` | Warning states |
| `muted` | Secondary text |
| `dim` | Tertiary text |
| `text` | Default text (usually `""`) |
| `thinkingText` | Thinking block text |

### Backgrounds & Content (11 required, 3 optional)

| Token | Purpose |
|-------|---------|
| `selectedBg` | Selected line background |
| `scrollbarThumb` | Fullscreen scrollbar thumb background; optional, falls back to `selectedBg` |
| `searchMatchBg` | Transcript search match background and current-match text; optional, falls back to `selectedBg` |
| `searchMatchText` | Transcript search match text and current-match background; optional, falls back to `text` |
| `userMessageBg` | User message background |
| `userMessageText` | User message text |
| `customMessageBg` | Extension message background |
| `customMessageText` | Extension message text |
| `customMessageLabel` | Extension message label |
| `toolPendingBg` | Tool box (pending) |
| `toolSuccessBg` | Tool box (success) |
| `toolErrorBg` | Tool box (error) |
| `toolTitle` | Tool title |
| `toolOutput` | Tool output text |

### Markdown (10 colors)

| Token | Purpose |
|-------|---------|
| `mdHeading` | Headings |
| `mdLink` | Link text |
| `mdLinkUrl` | Link URL |
| `mdCode` | Inline code |
| `mdCodeBlock` | Code block content |
| `mdCodeBlockBorder` | Code block fences |
| `mdQuote` | Blockquote text |
| `mdQuoteBorder` | Blockquote border |
| `mdHr` | Horizontal rule |
| `mdListBullet` | List bullets |

### Tool Diffs (3 colors)

| Token | Purpose |
|-------|---------|
| `toolDiffAdded` | Added lines |
| `toolDiffRemoved` | Removed lines |
| `toolDiffContext` | Context lines |

### Syntax Highlighting (9 colors)

| Token | Purpose |
|-------|---------|
| `syntaxComment` | Comments |
| `syntaxKeyword` | Keywords |
| `syntaxFunction` | Function names |
| `syntaxVariable` | Variables |
| `syntaxString` | Strings |
| `syntaxNumber` | Numbers |
| `syntaxType` | Types |
| `syntaxOperator` | Operators |
| `syntaxPunctuation` | Punctuation |

### Thinking Level Borders (6 required, 1 optional)

Editor border colors indicating thinking level (visual hierarchy from subtle to prominent):

| Token | Purpose |
|-------|---------|
| `thinkingOff` | Thinking off |
| `thinkingMinimal` | Minimal thinking |
| `thinkingLow` | Low thinking |
| `thinkingMedium` | Medium thinking |
| `thinkingHigh` | High thinking |
| `thinkingXhigh` | Extra high thinking |
| `thinkingMax` | Maximum thinking; optional, falls back to `thinkingXhigh` |

### Bash Mode (1 color)

| Token | Purpose |
|-------|---------|
| `bashMode` | Editor border in bash mode (`!` prefix) |

### HTML Export (optional)

The `export` section controls colors for `/export` HTML output. If omitted, colors are derived from `userMessageBg`.

```json
{
  "export": {
    "pageBg": "#18181e",
    "cardBg": "#1e1e24",
    "infoBg": "#3c3728"
  }
}
```

## Color Values

Six formats are supported:

| Format | Example | Description |
|--------|---------|-------------|
| Hex | `"#f00"` or `"#ff0000"` | 3- or 6-digit hex RGB |
| OKLCH | `"oklch(62% 0.1 200)"` | Perceptual lightness, chroma, and hue |
| OKHSL | `"okhsl(250 60% 55%)"` | Hue, saturation, and lightness within the sRGB gamut |
| 256-color | `39` | xterm 256-color palette index (0-255) |
| Variable | `"primary"` | Reference to a `vars` entry |
| Default | `""` | Terminal's default color |

### 256-Color Palette

- `0-15`: Basic ANSI colors (terminal-dependent)
- `16-231`: 6×6×6 RGB cube (`16 + 36×R + 6×G + B` where R,G,B are 0-5)
- `232-255`: Grayscale ramp

### Terminal Compatibility

Pi uses 24-bit RGB colors. Most modern terminals support this (iTerm2, Kitty, WezTerm, Windows Terminal, VS Code). For older terminals with only 256-color support, pi falls back to the nearest approximation.

Check truecolor support:

```bash
echo $COLORTERM  # Should output "truecolor" or "24bit"
```

## Tips

**Dark terminals:** Use bright, saturated colors with higher contrast.

**Light terminals:** Use darker, muted colors with lower contrast.

**Color harmony:** Start with a base palette (Nord, Gruvbox, Tokyo Night), define it in `vars`, and reference consistently.

**Testing:** Check your theme with different message types, tool states, markdown content, and long wrapped text.

**VS Code:** Set `terminal.integrated.minimumContrastRatio` to `1` for accurate colors.

## Examples

The built-in themes are selected by name: `dark`, `light`, `ice-cream-dark`, and `ice-cream-light`. When inspecting an installed package, their JSON assets are under `node_modules/@astralyn/pi/dist/modes/interactive/theme/` (the global-install equivalent is under Pi's npm package directory).

The ice-cream palette and bundled design notes are documented in [Bundled themes](bundled/themes.md).

## Use your terminal's colors

The `system` theme is the default. It builds Pi's colors from your terminal's theme, so Pi matches the terminal instead of bringing its own palette:

- Pi queries the terminal's default foreground and background colors and its 16 ANSI colors.
- Each Pi color takes its hue from one ANSI color, for example errors from red and links from blue.
- Pi sets each color's lightness so that it stands out from the background by a minimum contrast. Body text keeps at least a 4.5:1 WCAG contrast ratio on the background and every panel.
- When the terminal switches between light and dark, Pi queries the colors again and rebuilds the theme.

The theme adapts to what the terminal reports:

| Terminal reports | Result |
|---|---|
| Background and ANSI colors | Colors from the terminal palette, placed for the actual background. |
| Background only | Pi's own hues, placed for the actual background. |
| Nothing | ANSI color indices and the terminal's default colors, which the terminal renders itself. Secondary text is faint, and panels have no background color. |

Pi asks the terminal for its colors when it starts. Terminals usually answer within a few milliseconds, and Pi waits at most 100 ms before showing the startup header. If the terminal does not answer in time, Pi uses the ANSI color fallback, and it still applies the colors if they arrive later, for example over a slow SSH connection. `system` is a reserved name: a custom theme with that name is ignored.
