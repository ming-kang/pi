# Bundled extensions

These are extensions shipped in the `@astralyn/pi` npm package. For the public API used to write external extensions, see the [Extension API documentation](../../extensions.md).

They are registered as hidden built-in extensions and use the same public Extension API available to external extensions. Their implementation details are internal to the package and are not required for installation or configuration.

| Extension | Tool or command | Documentation |
|---|---|---|
| `llama.cpp` | `/llama` | [llama.cpp](../../llama-cpp.md) |
| `deepwiki` | `deepwiki` | [deepwiki.md](deepwiki.md) |
| `plan` | `exit_plan`, `/plan`, `/plans` | [plan.md](plan.md) |
| `question` | `question` | [question.md](question.md) |
| `todo` | `todo`, `/todos` | [todo.md](todo.md) |
| `rewind` | `/rewind`, `/tree` lifecycle | [rewind.md](rewind.md) |
| `router` | `/router` | [router.md](router.md) |
| `statusline` | Footer | [statusline.md](statusline.md) |
| `subagent` | `subagent`, `/agents` | [subagent.md](subagent.md) |

The catalog documents installed-package behavior and configuration; it does not require access to the package's internal source.
