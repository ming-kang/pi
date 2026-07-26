# Bundled extensions

These are extensions shipped by the distribution. For the public API used to write external extensions, see the [Extension API documentation](../../extensions.md).

The bundled extensions are maintained as self-contained TypeScript modules under `src/extensions/` and registered as hidden built-in extensions.

| Extension | Tool or command | Documentation |
|---|---|---|
| `deepwiki` | `deepwiki` | [deepwiki.md](deepwiki.md) |
| `question` | `question` | [question.md](question.md) |
| `todo` | `todo`, `/todos` | [todo.md](todo.md) |
| `rewind` | `/rewind`, `/tree` lifecycle | [rewind.md](rewind.md) |
| `router` | `/router` | [router.md](router.md) |
| `statusline` | Footer | [statusline.md](statusline.md) |
| `subagent` | `subagent`, `/agents` | [subagent.md](subagent.md) |

The extensions continue to use Pi's public Extension API. Keeping their distribution notes here does not merge their implementations into the coding-agent core.
