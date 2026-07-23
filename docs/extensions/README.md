# Bundled extensions

These are extensions shipped by the Fork. For the public API used to write external extensions, see the coding-agent [Extension API documentation](../../packages/coding-agent/docs/extensions.md).

The bundled extensions are maintained as self-contained TypeScript modules under `packages/coding-agent/src/extensions/` and registered as hidden built-in extensions.

| Extension | Tool or command | Documentation |
|---|---|---|
| `deepwiki` | `deepwiki` | [deepwiki.md](deepwiki.md) |
| `question` | `question` | [question.md](question.md) |
| `todo` | `todo`, `/todos` | [todo.md](todo.md) |
| `rewind` | `/rewind`, `/tree` lifecycle | [rewind.md](rewind.md) |
| `router` | `/router` | [router.md](router.md) |
| `statusline` | Footer | [statusline.md](statusline.md) |

The extensions continue to use Pi's public Extension API. Moving their documentation to the root `docs/` tree does not merge their implementations into the coding-agent core.
