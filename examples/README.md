# Examples

Example code for the `@astralyn/pi` SDK and extensions.

## Standalone

### [rpc-extension-ui.ts](rpc-extension-ui.ts)
A lightweight RPC chat client that handles extension UI requests; pair it with [the RPC demo extension](extensions/rpc-demo.ts).

## Directories

### [sdk/](sdk/)
Programmatic usage via `createAgentSession()`. Shows how to customize models, prompts, tools, extensions, and session management.

### [extensions/](extensions/)
Example extensions demonstrating:
- Lifecycle event handlers (tool interception, safety gates, context modifications)
- Custom tools (todo lists, questions, output truncation)
- Commands and keyboard shortcuts
- Custom UI (footers, headers, editors, overlays)
- Git integration (checkpoints, auto-commit)
- System prompt modifications and custom compaction
- External integrations (SSH, file watchers, system theme sync)
- Custom providers (Anthropic with custom streaming, GitLab Duo)

## Documentation

- [SDK Reference](sdk/README.md)
- [Extensions Documentation](../docs/extensions.md)
- [Skills Documentation](../docs/skills.md)
