# Examples

Example code for the `@astralyn/pi` SDK, process integration, and extensions.

## Standalone

### [rpc-client.ts](rpc-client.ts)
Runs one prompt through a Pi RPC child process with the typed `RpcClient`: it starts Pi, streams events, and waits for the run to settle.

Build the package before running it from a repository checkout:

```bash
npx tsx examples/rpc-client.ts "Explain this repository"
```

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
- [RPC Protocol](../docs/rpc.md)
- [Extensions Documentation](../docs/extensions.md)
- [Skills Documentation](../docs/skills.md)
