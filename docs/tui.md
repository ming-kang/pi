> pi can create TUI components. Ask it to build one for your use case.

# TUI Components

Extensions and custom tools can render custom terminal UI in interactive mode. This page documents the public TUI package API that Pi exposes to extensions, plus Pi's extension UI helpers.

**API reference:** the public declarations shipped by [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui) are authoritative. Pi builds on the [earendil-works/pi project](https://github.com/earendil-works/pi); Pi-specific helpers below are exported by `@astralyn/pi`.

## Component Interface

Every rendered component implements the public `Component` interface:

```typescript
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  wantsKeyRelease?: boolean;
  invalidate(): void;
}
```

| Member | Description |
|---|---|
| `render(width)` | Return one string per line. Every line must be at most `width` terminal columns wide. |
| `handleInput?(data)` | Receives raw terminal input while this component has focus. |
| `wantsKeyRelease?` | Set to `true` only when the component needs Kitty keyboard key-release events. Releases are otherwise filtered. |
| `invalidate()` | Clear cached render state. TUI calls it when the theme changes; call it yourself before rendering changed cached state. |

`invalidate()` is required even for an uncached component; an empty implementation is fine. `invalidate()` does **not** schedule a frame. After application state changes, call the injected `tui.requestRender()`.

## Focusable Components and IME

A component that renders a text cursor and needs IME candidate-window placement implements `Focusable` as well as `Component`:

```typescript
import { CURSOR_MARKER, type Component, type Focusable } from "@earendil-works/pi-tui";

class CursorCell implements Component, Focusable {
  focused = false;

  render(width: number): string[] {
    if (width < 1) return [];
    // Put the zero-width marker immediately before the visual cursor.
    const marker = this.focused ? CURSOR_MARKER : "";
    return [`${marker}\x1b[7m \x1b[27m`];
  }

  invalidate(): void {}
}
```

When a focused component has a `focused` property, TUI sets it and looks for `CURSOR_MARKER` in its rendered lines to position the hardware cursor. `Input` and `Editor` already implement this. An extension can query or change the injected TUI's hardware-cursor setting with `tui.getShowHardwareCursor()` and `tui.setShowHardwareCursor(enabled)`; changing it affects the whole application UI.

A container that owns an `Input` or `Editor` must forward both focus and input to its child. `Container` only groups and renders children; it does not route input for them.

```typescript
import { Container, type Focusable, Input } from "@earendil-works/pi-tui";

class SearchDialog extends Container implements Focusable {
  private readonly searchInput: Input;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor() {
    super();
    this.searchInput = new Input();
    this.addChild(this.searchInput);
  }

  handleInput(data: string): void {
    this.searchInput.handleInput(data);
  }
}
```

Without that propagation, an IME can place its candidate window at the wrong screen location.

## Show a Component in Pi

`ctx.ui.custom()` replaces the editor until its `done` callback is called. It is available only in TUI mode, so guard commands or tools that use it with `ctx.mode === "tui"`.

```typescript
if (ctx.mode !== "tui") return;

const result = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) =>
  new MyComponent({
    theme,
    keybindings,
    onChange: () => tui.requestRender(),
    onSelect: (value) => done(value),
    onCancel: () => done(null),
  })
);
```

The factory receives Pi's current `TUI`, semantic `Theme`, and configured `KeybindingsManager`. It may return a component synchronously or as a promise. The `custom()` promise resolves only when the component calls `done(result)`.

### Disposal

A component returned from `ctx.ui.custom()`, `setWidget()`, `setFooter()`, or `setHeader()` may also implement `dispose(): void`. Use it to stop timers, abort owned work, and unsubscribe listeners. Pi calls it after a custom component finishes, or when a widget, footer, or header is replaced or cleared.

Do not reuse a component after it has called `done`. Create a fresh instance if it must be shown again. In particular, an overlay handle's `hide()` only removes that overlay; it does not resolve the surrounding `ctx.ui.custom()` promise or dispose the component. Have the component call `done` to close its Pi UI lifecycle.

## Overlays

Pass `{ overlay: true }` to leave the existing UI visible and show a component above it:

```typescript
const result = await ctx.ui.custom<string | null>(
  (_tui, theme, _keybindings, done) => new MyDialog({ theme, onClose: () => done(null) }),
  { overlay: true }
);
```

Use `overlayOptions` to choose its layout and focus behavior:

```typescript
await ctx.ui.custom<void>(
  (_tui, theme, _keybindings, done) => new SidePanel({ theme, onClose: () => done() }),
  {
    overlay: true,
    overlayOptions: {
      width: "50%",          // number of columns or a percentage string
      minWidth: 40,
      maxHeight: "80%",      // number of rows or a percentage string
      anchor: "right-center", // center plus eight edge/corner anchors
      offsetX: -2,
      offsetY: 0,
      row: "25%",            // absolute number or percentage from the top
      col: 10,                // absolute number or percentage from the left
      margin: 2,              // number, or { top, right, bottom, left }
      visible: (termWidth, _termHeight) => termWidth >= 80,
      nonCapturing: false,    // set true for a visible overlay that never takes input
    },
    onHandle: (handle) => {
      // handle.focus(), handle.unfocus(), handle.setHidden(), and handle.hide()
    },
  }
);
```

The anchors are `"center"`, `"top-left"`, `"top-center"`, `"top-right"`, `"left-center"`, `"right-center"`, `"bottom-left"`, `"bottom-center"`, and `"bottom-right"`. An `overlayOptions` function is also accepted when the options need to be computed at the time the overlay is shown.

`onHandle` receives the public `OverlayHandle` after the overlay is shown:

- `focus()` gives the overlay input and brings it to the visual front.
- `unfocus()` releases input to another visible capturing overlay or the prior focus target. Use `unfocus({ target })` to focus a particular component, or `unfocus({ target: null })` to leave nothing focused.
- `setHidden(true)` temporarily hides the overlay; `setHidden(false)` shows it again. `isHidden()` reports that state.
- `hide()` permanently removes the overlay. `isFocused()` reports whether it owns focus.

A visible focused overlay can regain focus after a temporary non-overlay `ctx.ui.custom()` view closes. Use `unfocus()` when it should stop capturing input instead.

See [overlay-qa-tests.ts](../examples/extensions/overlay-qa-tests.ts) for anchors, margins, stacking, responsive visibility, and focus examples.

## Built-in Components

Import TUI primitives from `@earendil-works/pi-tui`. In Pi extension factories, use the supplied `theme` and its semantic helpers rather than hard-coded ANSI colors.

### Layout and text

```typescript
import { Box, Container, Spacer, Text, TruncatedText } from "@earendil-works/pi-tui";

const background = (text: string) => theme.bg("selectedBg", text);

const text = new Text("Hello World", 1, 1, background);
text.setText("Updated");
text.setCustomBgFn((value: string) => theme.bg("toolPendingBg", value));

const box = new Box(1, 1, background);
box.addChild(new Text("Content", 0, 0));
box.setBgFn((value: string) => theme.bg("selectedBg", value));

const container = new Container();
container.addChild(box);
container.addChild(new Spacer(1));
container.removeChild(box);
container.clear();

const singleLine = new TruncatedText("A long status line", 0, 0);
```

`Text` wraps multi-line text. `TruncatedText` renders text constrained to one line. `Box` applies padding and an optional background function around its children. `Spacer(lines?)` creates empty lines and supports `setLines(lines)`.

### Markdown and images

Pi exports a semantic Markdown theme builder. `Markdown` requires its text, horizontal padding, vertical padding, and a `MarkdownTheme`.

```typescript
import { getMarkdownTheme } from "@astralyn/pi";
import { Image, Markdown } from "@earendil-works/pi-tui";

const markdown = new Markdown("# Title\n\nSome **bold** text", 1, 1, getMarkdownTheme());
markdown.setText("Updated markdown");

const image = new Image(
  base64Data,
  "image/png",
  { fallbackColor: (text: string) => theme.fg("muted", text) },
  { maxWidthCells: 80, maxHeightCells: 24 }
);
```

`Image` accepts base64 data, a MIME type, an `ImageTheme` with `fallbackColor`, and optional sizing, filename, or reusable `imageId` options. It renders a text fallback where inline images are unsupported.

### Inputs, selectors, and loaders

`Input` is a single-line focused editor. `Editor` is the multi-line editor component; for Pi's main editor, extend Pi's `CustomEditor` instead of constructing a bare `Editor` so app shortcuts continue to work.

`SelectList` takes `(items, maxVisible, theme, layout?)`; `SettingsList` takes `(items, maxVisible, theme, onChange, onCancel, options?)`. Both use Pi's configured selection bindings. `Loader` takes `(tui, spinnerColorFn, messageColorFn, message?, indicator?)`; `CancellableLoader` adds `signal`, `aborted`, `onAbort`, and `dispose()`. Pi's `BorderedLoader` wraps the latter with Pi-native framing and cancellation hints; see [Pattern 2](#pattern-2-async-operation-with-cancel-borderedloader).

## Keyboard Input

Use `matchesKey()` and `Key` for fixed, extension-specific keys. They handle legacy terminal sequences and Kitty keyboard protocol.

```typescript
import { Key, matchesKey } from "@earendil-works/pi-tui";

handleInput(data: string): void {
  if (matchesKey(data, Key.up)) {
    this.moveUp();
  } else if (matchesKey(data, Key.enter)) {
    this.confirm();
  } else if (matchesKey(data, Key.escape)) {
    this.cancel();
  } else if (matchesKey(data, Key.ctrl("c"))) {
    this.cancel();
  }
}
```

`Key` provides basic, navigation, function, and symbol keys, plus `ctrl`, `shift`, `alt`, `super`, and combined-modifier helpers. A `KeyId` string such as `"enter"`, `"ctrl+c"`, or `"ctrl+shift+p"` also works.

For behavior that follows a Pi-configurable binding, use the `keybindings` callback argument instead of checking a default key directly:

```typescript
import type { KeybindingsManager } from "@astralyn/pi";

class MyDialog {
  constructor(private readonly keybindings: KeybindingsManager) {}

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.close();
    }
  }
}
```

Pi supplies `tui.*` IDs such as `tui.select.up`, `tui.select.confirm`, and `tui.select.cancel`, along with `app.*` IDs such as `app.interrupt`. Use Pi's `keyHint()` helper when displaying a configured binding in UI text; it formats the current binding rather than hard-coding a key label.

## Line Width

Every string returned by `render(width)` must fit within `width` visible terminal columns. ANSI styling does not count toward display width.

```typescript
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

render(width: number): string[] {
  const line = truncateToWidth(this.text, width);
  const wrapped = wrapTextWithAnsi(this.longText, width);
  return visibleWidth(line) <= width ? [line, ...wrapped] : [truncateToWidth(line, width)];
}
```

`truncateToWidth(text, width, ellipsis?, pad?)` preserves ANSI sequences and can use `""` as its ellipsis. `wrapTextWithAnsi()` preserves active ANSI styles across wrapped lines.

## Creating a Custom Component

This selector uses Pi's configured list bindings, semantic colors, width-safe output, caching, and explicit render requests without a forwarding wrapper:

```typescript
import type { KeybindingsManager, Theme } from "@astralyn/pi";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";

class MySelector implements Component {
  private selected = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private readonly items: readonly string[],
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly requestRender: () => void,
    private readonly onSelect: (item: string) => void,
    private readonly onCancel: () => void,
  ) {}

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.up") && this.selected > 0) {
      this.selected--;
    } else if (this.keybindings.matches(data, "tui.select.down") && this.selected < this.items.length - 1) {
      this.selected++;
    } else if (this.keybindings.matches(data, "tui.select.confirm")) {
      const item = this.items[this.selected];
      if (item !== undefined) this.onSelect(item);
      return;
    } else if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.onCancel();
      return;
    } else {
      return;
    }

    this.invalidate();
    this.requestRender();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    this.cachedLines = this.items.map((item, index) => {
      const selected = index === this.selected;
      const prefix = selected ? this.theme.fg("accent", "› ") : "  ";
      const label = this.theme.fg(selected ? "accent" : "text", item);
      return truncateToWidth(prefix + label, width);
    });
    this.cachedWidth = width;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
```

Use it directly from an extension command:

```typescript
const items = ["Option A", "Option B", "Option C"];
const selected = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) =>
  new MySelector(items, theme, keybindings, () => tui.requestRender(), done, () => done(null))
);

if (selected !== null) {
  ctx.ui.notify(`Selected: ${selected}`, "info");
}
```

## Theming

Use the `Theme` passed to a UI factory or renderer. `theme.fg(color, text)` and `theme.bg(color, text)` use the user's semantic theme instead of fixed ANSI colors.

```typescript
renderResult(_result, _options, theme, _context) {
  const text = theme.bg("toolSuccessBg", theme.fg("success", "Done!"));
  return new Text(text, 0, 0);
}
```

Foreground color names:

| Category | Colors |
|---|---|
| General | `text`, `accent`, `muted`, `dim` |
| Status | `success`, `error`, `warning` |
| Borders | `border`, `borderAccent`, `borderMuted` |
| Messages | `userMessageText`, `customMessageText`, `customMessageLabel` |
| Tools | `toolTitle`, `toolOutput` |
| Diffs | `toolDiffAdded`, `toolDiffRemoved`, `toolDiffContext` |
| Markdown | `mdHeading`, `mdLink`, `mdLinkUrl`, `mdCode`, `mdCodeBlock`, `mdCodeBlockBorder`, `mdQuote`, `mdQuoteBorder`, `mdHr`, `mdListBullet` |
| Syntax | `syntaxComment`, `syntaxKeyword`, `syntaxFunction`, `syntaxVariable`, `syntaxString`, `syntaxNumber`, `syntaxType`, `syntaxOperator`, `syntaxPunctuation` |
| Thinking | `thinkingText`, `thinkingOff`, `thinkingMinimal`, `thinkingLow`, `thinkingMedium`, `thinkingHigh`, `thinkingXhigh`, `thinkingMax` |
| Mode | `bashMode` |

Background color names: `selectedBg`, `userMessageBg`, `customMessageBg`, `toolPendingBg`, `toolSuccessBg`, and `toolErrorBg`.

For Markdown, use Pi's public helper:

```typescript
import { getMarkdownTheme } from "@astralyn/pi";
import { Markdown } from "@earendil-works/pi-tui";

renderResult(result, _options, _theme, _context) {
  return new Markdown(result.details.markdown, 0, 0, getMarkdownTheme());
}
```

## Invalidation and Theme Changes

If a component caches lines that contain styled strings, it must clear that cache in `invalidate()`. If it creates a `Text`, `SettingsList`, or other child with already styled strings, clear the child cache **and recreate those strings** on invalidation. Calling `Container.invalidate()` alone cannot change ANSI sequences already stored in a child.

```typescript
import { Container, Text } from "@earendil-works/pi-tui";

// Inside a ctx.ui.custom() factory, where `theme` is supplied:
const container = new Container();
const title = new Text("", 1, 0);
container.addChild(title);

const refreshTheme = () => {
  title.setText(theme.fg("accent", theme.bold("Current title")));
};

refreshTheme();

const component = {
  render: (width: number) => container.render(width),
  invalidate: () => {
    refreshTheme();
    container.invalidate();
  },
};
```

For a component that styles its output inside `render()`, simply clearing cached lines is enough:

```typescript
import type { Theme } from "@astralyn/pi";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";

class CachedComponent implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(private readonly theme: Theme, private readonly text: string) {}

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    this.cachedWidth = width;
    this.cachedLines = [truncateToWidth(this.theme.fg("muted", this.text), width)];
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
```

Call `invalidate()` and then `tui.requestRender()` whenever component state changes outside input handling, such as in a timer, event listener, or async completion. Implement `dispose()` as well when that state is driven by a timer or subscription.

## Common Patterns

### Pattern 1: Selection Dialog (`SelectList`)

```typescript
import { DynamicBorder, keyHint } from "@astralyn/pi";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

pi.registerCommand("pick", {
  handler: async (_args, ctx) => {
    if (ctx.mode !== "tui") return;

    const items: SelectItem[] = [
      { value: "opt1", label: "Option 1", description: "First option" },
      { value: "opt2", label: "Option 2", description: "Second option" },
      { value: "opt3", label: "Option 3" },
    ];

    const result = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
      const container = new Container();
      const title = new Text("", 1, 0);
      const hint = new Text("", 1, 0);
      const selectList = new SelectList(items, Math.min(items.length, 10), {
        selectedPrefix: (text: string) => theme.fg("accent", text),
        selectedText: (text: string) => theme.fg("accent", text),
        description: (text: string) => theme.fg("muted", text),
        scrollInfo: (text: string) => theme.fg("dim", text),
        noMatch: (text: string) => theme.fg("warning", text),
      });
      selectList.onSelect = (item) => done(item.value);
      selectList.onCancel = () => done(null);

      const refreshTheme = () => {
        title.setText(theme.fg("accent", theme.bold("Pick an option")));
        hint.setText(
          [
            keyHint("tui.select.up", "up"),
            keyHint("tui.select.down", "down"),
            keyHint("tui.select.confirm", "select"),
            keyHint("tui.select.cancel", "cancel"),
          ].join(theme.fg("dim", " • ")),
        );
      };

      container.addChild(new DynamicBorder((text: string) => theme.fg("borderAccent", text)));
      container.addChild(title);
      container.addChild(selectList);
      container.addChild(hint);
      container.addChild(new DynamicBorder((text: string) => theme.fg("borderAccent", text)));
      refreshTheme();

      return {
        render: (width: number) => container.render(width),
        invalidate: () => {
          refreshTheme();
          container.invalidate();
        },
        handleInput: (data: string) => {
          selectList.handleInput(data);
          tui.requestRender();
        },
      };
    });

    if (result !== null) ctx.ui.notify(`Selected: ${result}`, "info");
  },
});
```

**Examples:** [preset.ts](../examples/extensions/preset.ts), [tools.ts](../examples/extensions/tools.ts)

### Pattern 2: Async Operation with Cancel (`BorderedLoader`)

`BorderedLoader` is Pi's public framed wrapper around the TUI package's cancellable loader. Its `dispose()` stops its loader, so returning it directly gives the operation a clean lifecycle.

```typescript
import { BorderedLoader } from "@astralyn/pi";

pi.registerCommand("fetch", {
  handler: async (_args, ctx) => {
    if (ctx.mode !== "tui") return;

    const result = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
      const loader = new BorderedLoader(tui, theme, "Fetching data...");
      loader.onAbort = () => done(null);

      void fetchData(loader.signal).then(done, () => done(null));
      return loader;
    });

    if (result === null) {
      ctx.ui.notify("Cancelled", "info");
    } else {
      ctx.ui.setEditorText(result);
    }
  },
});
```

**Examples:** [qna.ts](../examples/extensions/qna.ts), [handoff.ts](../examples/extensions/handoff.ts)

### Pattern 3: Settings and Toggles (`SettingsList`)

Use Pi's semantic settings-list theme. Rebuild this small list on invalidation so its pre-styled cursor also follows a theme change.

```typescript
import { getSettingsListTheme } from "@astralyn/pi";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";

pi.registerCommand("settings", {
  handler: async (_args, ctx) => {
    if (ctx.mode !== "tui") return;

    const items: SettingItem[] = [
      { id: "verbose", label: "Verbose mode", currentValue: "off", values: ["on", "off"] },
      { id: "color", label: "Color output", currentValue: "on", values: ["on", "off"] },
    ];

    await ctx.ui.custom((tui, theme, _keybindings, done) => {
      const container = new Container();
      const title = new Text("", 1, 1);
      container.addChild(title);
      let settingsList: SettingsList | undefined;

      const rebuild = () => {
        title.setText(theme.fg("accent", theme.bold("Settings")));
        if (settingsList) container.removeChild(settingsList);
        settingsList = new SettingsList(
          items,
          Math.min(items.length + 2, 15),
          getSettingsListTheme(),
          (id, newValue) => ctx.ui.notify(`${id} = ${newValue}`, "info"),
          () => done(undefined),
          { enableSearch: true },
        );
        container.addChild(settingsList);
      };

      rebuild();
      return {
        render: (width: number) => container.render(width),
        invalidate: () => {
          rebuild();
          container.invalidate();
        },
        handleInput: (data: string) => {
          settingsList?.handleInput(data);
          tui.requestRender();
        },
      };
    });
  },
});
```

**Examples:** [tools.ts](../examples/extensions/tools.ts)

### Pattern 4: Persistent Status Indicator

```typescript
ctx.ui.setStatus("my-extension", ctx.ui.theme.fg("accent", "● active"));
ctx.ui.setStatus("my-extension", undefined); // Clear
```

**Examples:** [status-line.ts](../examples/extensions/status-line.ts), [preset.ts](../examples/extensions/preset.ts)

### Pattern 4b: Working Indicator Customization

```typescript
// Static indicator
ctx.ui.setWorkingIndicator({ frames: [ctx.ui.theme.fg("accent", "●")] });

// Custom animation. Frames are rendered verbatim, so style them explicitly.
ctx.ui.setWorkingIndicator({
  frames: [
    ctx.ui.theme.fg("dim", "·"),
    ctx.ui.theme.fg("muted", "•"),
    ctx.ui.theme.fg("accent", "●"),
    ctx.ui.theme.fg("muted", "•"),
  ],
  intervalMs: 120,
});

ctx.ui.setWorkingIndicator({ frames: [] }); // Hide
ctx.ui.setWorkingIndicator(); // Restore Pi's default
```

**Examples:** [working-indicator.ts](../examples/extensions/working-indicator.ts)

### Pattern 5: Widgets Above or Below the Editor

```typescript
import { truncateToWidth } from "@earendil-works/pi-tui";

const tasks = [
  { text: "Review changes", done: true },
  { text: "Run checks", done: false },
];

ctx.ui.setWidget("my-widget", (_tui, theme) => ({
  render(width: number): string[] {
    return tasks.map((task) =>
      truncateToWidth(
        task.done
          ? theme.fg("success", "✓ ") + theme.fg("muted", task.text)
          : theme.fg("dim", "○ ") + theme.fg("text", task.text),
        width,
      ),
    );
  },
  invalidate(): void {},
}));

ctx.ui.setWidget("my-widget", undefined); // Clear
ctx.ui.setWidget("my-widget", ["Below the editor"], { placement: "belowEditor" });
```

The factory's component is disposed when that widget key is replaced or cleared. If mutable widget state changes, retain the factory's `tui` argument and call `tui.requestRender()`.

**Examples:** [widget-placement.ts](../examples/extensions/widget-placement.ts)

### Pattern 6: Custom Footer

A footer factory receives branch and extension-status data unavailable elsewhere. Return the unsubscribe function as `dispose` so it is released when the footer changes.

```typescript
import { truncateToWidth } from "@earendil-works/pi-tui";

ctx.ui.setFooter((tui, theme, footerData) => ({
  render(width: number): string[] {
    const branch = footerData.getGitBranch() ?? "no git";
    const text = theme.fg("dim", `${ctx.model?.id ?? "no model"} (${branch})`);
    return [truncateToWidth(text, width)];
  },
  invalidate(): void {},
  dispose: footerData.onBranchChange(() => tui.requestRender()),
}));

ctx.ui.setFooter(undefined); // Restore Pi's default footer
```

`footerData.getExtensionStatuses()` returns the read-only status map set through `ctx.ui.setStatus()`. Session statistics are available from `ctx.sessionManager` and `ctx.model`.

**Examples:** [custom-footer.ts](../examples/extensions/custom-footer.ts)

### Pattern 7: Custom Editor

Extend `CustomEditor` to preserve Pi's application keybindings. This example uses the configured `app.interrupt` binding to enter normal mode and `decodeKittyPrintable()` for vim's printable commands.

```typescript
import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from "@astralyn/pi";
import {
  decodeKittyPrintable,
  truncateToWidth,
  type EditorTheme,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";

type Mode = "normal" | "insert";

class VimEditor extends CustomEditor {
  private mode: Mode = "insert";

  constructor(tui: TUI, theme: EditorTheme, private readonly bindings: KeybindingsManager) {
    super(tui, theme, bindings);
  }

  private setMode(mode: Mode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.invalidate();
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.bindings.matches(data, "app.interrupt")) {
      if (this.mode === "insert") {
        this.setMode("normal");
      } else {
        super.handleInput(data);
      }
      return;
    }

    if (this.mode === "insert") {
      super.handleInput(data);
      return;
    }

    const key = decodeKittyPrintable(data) ?? data;
    switch (key) {
      case "i":
        this.setMode("insert");
        return;
      case "h":
        super.handleInput("\x1b[D");
        return;
      case "j":
        super.handleInput("\x1b[B");
        return;
      case "k":
        super.handleInput("\x1b[A");
        return;
      case "l":
        super.handleInput("\x1b[C");
        return;
    }

    // Keep application controls, but do not insert normal-mode text.
    if (key.length === 1 && key.charCodeAt(0) >= 32) return;
    super.handleInput(data);
  }

  render(width: number): string[] {
    const lines = super.render(width);
    const last = lines.length - 1;
    if (last < 0) return lines;

    const label = this.mode === "normal" ? " NORMAL " : " INSERT ";
    if (width >= label.length && visibleWidth(lines[last]!) >= label.length) {
      lines[last] = truncateToWidth(lines[last]!, width - label.length, "") + label;
    }
    return lines;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new VimEditor(tui, theme, keybindings));
  });
}
```

Pass `undefined` to `ctx.ui.setEditorComponent()` to restore Pi's default editor.

**Examples:** [modal-editor.ts](../examples/extensions/modal-editor.ts)

## Debug Logging

Set `PI_TUI_WRITE_LOG` to capture the ANSI stream written to stdout.

```bash
PI_TUI_WRITE_LOG=/tmp/tui-ansi.log pi
```

## Key Rules

1. Guard terminal-only UI with `ctx.mode === "tui"`.
2. Use the callback `theme` or `ctx.ui.theme`; use semantic `fg()` and `bg()` helpers, never fixed ANSI colors.
3. Use `keybindings.matches()` and `keyHint()` for configurable Pi actions. Reserve `matchesKey()` for deliberately fixed extension-specific keys.
4. Keep every rendered line within the supplied width, including styled lines.
5. Invalidate cached output and call `tui.requestRender()` after state changes.
6. Implement `dispose()` for timers, subscriptions, or other owned resources.
7. Prefer `SelectList`, `SettingsList`, and `BorderedLoader` over rebuilding their behavior.

## Additional examples

- **Game loop and disposal:** [examples/extensions/snake.ts](../examples/extensions/snake.ts)
- **Custom tool rendering:** [examples/extensions/todo.ts](../examples/extensions/todo.ts)
