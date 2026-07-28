# Custom Providers

Use an extension when a provider needs runtime behavior: an OAuth flow, dynamic catalog, proxy-specific headers, payload rewriting, or a streaming protocol that Pi does not already support. For built-in provider setup, see [Providers](providers.md); for a static OpenAI-compatible endpoint, `models.json` is usually simpler; see [Custom Models](models.md).

## Example Extensions

These published extensions are the maintained end-to-end references:

- [`custom-provider-anthropic`](../examples/extensions/custom-provider-anthropic/) implements OAuth and a custom event stream.
- [`custom-provider-gitlab-duo`](../examples/extensions/custom-provider-gitlab-duo/) obtains provider-specific credentials, then delegates to Pi AI's public Anthropic and OpenAI stream APIs.

## Table of Contents

- [Provider Registration](#provider-registration)
  - [Configuration Form](#configuration-form)
  - [Complete pi-ai Provider](#complete-pi-ai-provider)
  - [Composition, Updates, and Removal](#composition-updates-and-removal)
  - [Dynamic Model Catalogs](#dynamic-model-catalogs)
- [API and Model Configuration](#api-and-model-configuration)
- [Authentication, Headers, and Request Hooks](#authentication-headers-and-request-hooks)
  - [API Keys and Registered Headers](#api-keys-and-registered-headers)
  - [OAuth](#oauth)
  - [Payload and Header Hooks](#payload-and-header-hooks)
- [Custom Streaming APIs](#custom-streaming-apis)
  - [Stream Contract](#stream-contract)
  - [Forwarding Hooks from a Custom Stream](#forwarding-hooks-from-a-custom-stream)
- [Context Overflow Recovery](#context-overflow-recovery)
- [Testing](#testing)

## Provider Registration

`pi.registerProvider()` has two forms:

1. `pi.registerProvider(name, config)` configures a provider, models, optional OAuth, and an optional custom `streamSimple` handler.
2. `pi.registerProvider(provider)` registers a complete public pi-ai `Provider` when the extension owns native auth, catalog, filtering, or both stream methods.

An extension factory may be `async`; Pi waits for it before startup continues. Register during the factory when models must be present in `/model` and `pi --list-models`. See [Writing an Extension](extensions.md#writing-an-extension).

### Configuration Form

Use the configuration form for a standard supported API or to override a built-in provider:

```typescript
import type { ExtensionAPI } from "@astralyn/pi";

export default function (pi: ExtensionAPI) {
  // Keeps Anthropic's existing models and auth; only the endpoint changes.
  pi.registerProvider("anthropic", {
    baseUrl: "https://proxy.example.com/anthropic",
    headers: { "X-Proxy-Tenant": "$PROXY_TENANT" },
  });

  // A new OpenAI-compatible provider.
  pi.registerProvider("local-openai", {
    name: "Local OpenAI",
    baseUrl: "http://127.0.0.1:8080/v1",
    apiKey: "local", // A literal placeholder for a server that ignores keys.
    api: "openai-completions",
    models: [
      {
        id: "local-model",
        name: "Local Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
  });
}
```

When `models` is omitted, existing models are retained. When it is supplied, it replaces the models supplied by the built-in/native provider and earlier extension registration for that provider. A model can set its own `api` or `baseUrl` to override the provider default.

A `streamSimple` registration must also set the provider-level `api`. Pi invokes that handler only for models whose effective `api` matches the registered API tag. A custom tag such as `"my-company-api"` is valid; do **not** call the compatibility API registry's `registerApiProvider()` merely to use it with `pi.registerProvider()`.

### Complete pi-ai Provider

For a provider with native behavior, construct a public pi-ai `Provider` and register it directly. `createProvider`, `envApiKeyAuth`, and the `Provider`/`Model` types are public root exports. The lazy built-in API factories, including `openAICompletionsApi`, are public from `@earendil-works/pi-ai/compat`.

```typescript
import type { ExtensionAPI } from "@astralyn/pi";
import { createProvider, envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";

const model: Model<"openai-completions"> = {
  id: "local-model",
  name: "Local Model",
  api: "openai-completions",
  provider: "native-local",
  baseUrl: "http://127.0.0.1:8080/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};

export default function (pi: ExtensionAPI) {
  pi.registerProvider(
    createProvider({
      id: "native-local",
      name: "Native Local",
      baseUrl: model.baseUrl,
      auth: {
        apiKey: envApiKeyAuth("Local server API key", ["LOCAL_OPENAI_API_KEY"]),
      },
      models: [model],
      api: openAICompletionsApi(),
    }),
  );
}
```

A complete `Provider` must have auth, `getModels()`, `stream()`, and `streamSimple()` behavior. `createProvider()` supplies the model/catalog plumbing and both stream methods from the public `ProviderStreams` value passed as `api`; use a hand-written `Provider` only when that helper does not fit. For hand-written API-key auth, `login(interaction)` returns an `ApiKeyCredential` and `resolve({ ctx, credential })` returns an `AuthResult` or `undefined`; `envApiKeyAuth()` implements that standard pattern.

### Composition, Updates, and Removal

A complete registered `Provider` is the base provider for its ID. Pi applies `models.json` configuration above that base, including final `modelOverrides`; see [Per-model Overrides](models.md#per-model-overrides). A named configuration registration is instead applied over the native/built-in provider and `models.json` layers.

A later named registration for the same ID merges its defined configuration values with the prior named registration. Registering a complete `Provider` for that ID replaces the named registration; registering by name replaces a complete extension provider for that ID.

Provider calls made from the factory are queued until the extension runner is ready. Calls made later, such as from a command, take effect immediately; no `/reload` is needed.

```typescript
pi.unregisterProvider("local-openai");
```

`unregisterProvider()` removes either form registered by the extension and recomposes the remaining layers. A built-in provider is restored when one exists; `models.json` configuration remains, while a provider defined only by the extension disappears.

### Dynamic Model Catalogs

The configuration form can refresh an extension-owned model list. Pi calls `refreshModels` during model refresh. Its returned list replaces the extension-provided models. Use `context.signal` for requests and `context.store` only when the catalog should persist across sessions.

```typescript
pi.registerProvider("local-openai", {
  baseUrl: "http://127.0.0.1:8080/v1",
  apiKey: "local",
  api: "openai-completions",
  async refreshModels({ signal }) {
    const response = await fetch("http://127.0.0.1:8080/v1/models", { signal });
    if (!response.ok) throw new Error(`Model discovery failed: ${response.status}`);

    const payload = (await response.json()) as { data: Array<{ id: string }> };
    return payload.data.map((entry) => ({
      id: entry.id,
      name: entry.id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    }));
  },
});
```

For one-time discovery that must finish before model selection, make the extension factory `async`, fetch the catalog there, and then call `registerProvider()` with `models`.

## API and Model Configuration

Set `api` on the provider as the default, or on a model when one provider has models served by different APIs. The built-in API tags are:

| API | Use |
| --- | --- |
| `anthropic-messages` | Anthropic Messages-compatible APIs |
| `openai-completions` | OpenAI Chat Completions-compatible APIs |
| `openai-responses` | OpenAI Responses APIs |
| `azure-openai-responses` | Azure OpenAI Responses APIs |
| `openai-codex-responses` | OpenAI Codex Responses APIs |
| `mistral-conversations` | Mistral Conversations APIs |
| `google-generative-ai` | Google Generative AI APIs |
| `google-vertex` | Google Vertex AI APIs |
| `bedrock-converse-stream` | Amazon Bedrock Converse Stream APIs |
| `pi-messages` | Pi Messages APIs |

A configuration-form model requires `id`, `name`, `reasoning`, `input`, `cost`, `contextWindow`, and `maxTokens`. It may also set `api`, `baseUrl`, `headers`, `thinkingLevelMap`, and `compat`. `cost` rates are per million tokens. `thinkingLevelMap` maps Pi's `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` levels; `null` hides an unsupported level.

Keep endpoint-specific compatibility settings in `compat` rather than reimplementing a standard protocol. The full model fields, thinking maps, cost tiers, and Anthropic/OpenAI compatibility options are documented in [Custom Models](models.md#model-configuration), [Anthropic Messages Compatibility](models.md#anthropic-messages-compatibility), and [OpenAI Compatibility](models.md#openai-compatibility).

## Authentication, Headers, and Request Hooks

### API Keys and Registered Headers

For a new config-form provider, supply `apiKey` unless it has OAuth or a complete native provider supplies auth. `apiKey`, provider `headers`, and model `headers` use the same value syntax as `models.json`:

- `$NAME` and `${NAME}` interpolate environment variables.
- A value beginning with `!` runs a command for the whole value.
- `$$` and `$!` emit literal `$` and `!`.
- Other text, including uppercase text, is literal.

Values are resolved at request time. See [Value Resolution](models.md#value-resolution) for command behavior and security considerations.

```typescript
pi.registerProvider("company-api", {
  baseUrl: "https://api.example.com/v1",
  apiKey: "$COMPANY_API_KEY",
  api: "openai-completions",
  headers: {
    "X-Tenant": "$COMPANY_TENANT",
    "X-Proxy-Token": "!company-token print",
  },
  authHeader: true, // Adds Authorization: Bearer <resolved API key>.
  models: [/* ... */],
});
```

`authHeader` is useful for a custom API that expects a bearer token but does not create that header itself. Standard Pi AI API implementations already apply their own authentication. A custom stream receives the resolved key as `options.apiKey` and the final headers as `options.headers`; forward both as appropriate for its protocol.

### OAuth

The configuration form adapts the extension OAuth callbacks to Pi AI's provider auth and exposes the provider through `/login`. This callback shape is specific to `ProviderConfig.oauth`: a complete native `Provider` instead supplies `auth.oauth.login(interaction)`, `refresh(credential, signal?)`, and `toAuth(credential)`. Do not use the configuration form's `refreshToken` or `getApiKey` names on native `auth.oauth`.

```typescript
import type { ExtensionAPI } from "@astralyn/pi";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  callbacks.onAuth({
    url: "https://sso.example.com/authorize?...",
    instructions: "Sign in, then paste the authorization code.",
  });
  const code = await callbacks.onPrompt({ message: "Authorization code" });

  // Exchange the code with this provider's OAuth server. Pass callbacks.signal
  // to provider requests when supported.
  return exchangeAuthorizationCode(code, callbacks.signal);
}

async function refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  return refreshAuthorization(credentials.refresh);
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("company-api", {
    baseUrl: "https://api.example.com/v1",
    api: "openai-responses",
    models: [/* ... */],
    oauth: {
      name: "Company AI",
      login,
      refreshToken,
      getApiKey: (credentials) => credentials.access,
    },
  });
}
```

Return credentials with `refresh`, `access`, and `expires` (a millisecond timestamp). Pi adds the stored OAuth credential's internal type tag; extension callbacks return `OAuthCredentials`, not a credential with `type: "oauth"`.

`OAuthLoginCallbacks` provides these UI-neutral operations:

- `onAuth({ url, instructions? })` opens/displays an authorization URL.
- `onDeviceCode({ userCode, verificationUri, intervalSeconds?, expiresInSeconds? })` displays a device flow code.
- `onPrompt({ message, placeholder?, allowEmpty? })` asks for text and resolves to the entered string.
- `onSelect({ message, options: [{ id, label }] })` resolves to an option ID or `undefined`.
- `onManualCodeInput?.()` optionally requests a manually pasted code.
- `onProgress?.(message)` reports transient progress, and `signal` is an optional `AbortSignal` for the login flow.

Do not use `usesCallbackServer`; it is deprecated and ignored by the canonical OAuth flow. Keep OAuth tokens out of logs and error messages.

### Payload and Header Hooks

For a standard Pi AI API stream, Pi's extension hooks work automatically:

- `before_provider_headers` mutates the fully assembled headers. A `null` header value removes that header.
- `before_provider_request` inspects or replaces the serialized payload.
- `after_provider_response` sees the status and normalized headers before the response body is consumed.

See [provider request events](extensions.md#before_provider_headers) for ordering and examples. `onPayload`, `onResponse`, and `transformHeaders` are **not** `ProviderConfig` fields. Pi passes the first two to a stream as `SimpleStreamOptions`; header transformation has already happened before a custom `streamSimple` is called.

A custom stream that sends HTTP itself must call `options.onPayload` and `options.onResponse` to preserve the payload/response hooks. It must also use the supplied headers. For example, immediately before consuming a custom HTTP response:

```typescript
const payload = { model: model.id, stream: true };
const replacement = await options?.onPayload?.(payload, model);
const requestPayload = replacement === undefined ? payload : replacement;

const headers = Object.fromEntries(
  Object.entries(options?.headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== null),
);
const response = await fetch(`${model.baseUrl}/stream`, {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(requestPayload),
  signal: options?.signal,
});
await options?.onResponse?.(
  { status: response.status, headers: Object.fromEntries(response.headers.entries()) },
  model,
);
if (!response.ok) throw new Error(`Request failed: ${response.status}`);
```

When a custom stream delegates to a public Pi AI API stream, pass through `options` (and merge rather than discard `options.headers`) so those hooks continue to run. The GitLab Duo example follows this pattern.

## Custom Streaming APIs

Implement `streamSimple` only for a protocol that cannot use a built-in API tag or a public Pi AI API stream. The custom Anthropic example implements the event protocol directly; the GitLab Duo example shows the preferred delegation approach when an endpoint is still Anthropic- or OpenAI-compatible.

### Stream Contract

The configuration-form handler signature is exactly:

```typescript
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  calculateCost,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

function streamMyProvider(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      stream.push({ type: "start", partial: output });

      // Send the request, consume the provider stream, and update output.
      const contentIndex = output.content.length;
      output.content.push({ type: "text", text: "" });
      stream.push({ type: "text_start", contentIndex, partial: output });

      // For each provider text delta:
      const delta = "...";
      const block = output.content[contentIndex];
      if (block.type === "text") {
        block.text += delta;
        stream.push({ type: "text_delta", contentIndex, delta, partial: output });
      }

      // After the provider completes this block:
      if (block.type === "text") {
        stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
      }

      // Update usage whenever the provider reports it, then recalculate cost.
      output.usage.totalTokens =
        output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
      calculateCost(model, output.usage);

      output.stopReason = "stop";
      stream.push({ type: "done", reason: "stop", message: output });
    } catch (error) {
      const reason = options?.signal?.aborted ? "aborted" : "error";
      output.stopReason = reason;
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason, error: output });
    } finally {
      stream.end();
    }
  })();

  return stream;
}
```

Emit `start` before partial content events, update `output.content` before each event's `partial`, and end exactly once after either terminal event. The terminal event shapes are deliberately narrow: `done.reason` is `"stop" | "length" | "toolUse"`; `error.reason` is `"error" | "aborted"`. Map the upstream stop reason to one of those values and keep it equal to `output.stopReason`.

Use the index of each block in `output.content` as `contentIndex` and emit matching start, delta, and end events:

| Block | Events | Final content field |
| --- | --- | --- |
| Text | `text_start`, `text_delta`, `text_end` | `text` |
| Thinking | `thinking_start`, `thinking_delta`, `thinking_end` | `thinking` |
| Tool call | `toolcall_start`, `toolcall_delta`, `toolcall_end` | `ToolCall` |

Tool calls need an `id`, `name`, and parsed `arguments` object in the final `toolcall_end`. Accumulate streamed JSON before parsing it. For replayable thinking, preserve any provider signature in the block's `thinkingSignature` field. Populate `usage` with provider-reported values (`input`, `output`, `cacheRead`, `cacheWrite`, and optional `cacheWrite1h`/`reasoning`) before calling `calculateCost()`.

Register the handler with a matching custom API tag:

```typescript
pi.registerProvider("my-provider", {
  baseUrl: "https://api.example.com",
  apiKey: "$MY_PROVIDER_API_KEY",
  api: "my-provider-stream",
  models: [/* models whose effective api is my-provider-stream */],
  streamSimple: streamMyProvider,
});
```

### Forwarding Hooks from a Custom Stream

`SimpleStreamOptions` also carries cancellation, the resolved API key, reasoning level, thinking budgets, cache/session settings, retry/timeout options, headers, and the payload/response callbacks. Honor the options your protocol supports, especially `signal`, `apiKey`, and `headers`. Do not silently replace the supplied options when delegating:

```typescript
import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";

const responsesApi = openAIResponsesApi();

// Inside a custom handler, after adapting the model/API as necessary:
return responsesApi.streamSimple(adaptedModel, context, {
  ...options,
  headers: { ...options?.headers, "X-Relay": "company" },
});
```

This is a public API. It avoids depending on pi-ai implementation files and preserves Pi's request hooks.

## Context Overflow Recovery

Pi uses the public `isContextOverflow(message, contextWindow)` helper when deciding whether to auto-compact. It recognizes its built-in error patterns and also detects a few silent-overflow usage shapes. A custom stream should emit `stopReason: "error"` with the provider's real error in `errorMessage`.

If an upstream uses an unrecognized overflow message, normalize only that provider's known overflow error. The generic `context_length_exceeded` prefix is recognized. A `message_end` replacement occurs before Pi's overflow recovery check:

```typescript
import type { ExtensionAPI } from "@astralyn/pi";

const PROVIDER_OVERFLOW = /request exceeds the acme input limit/i;

export default function (pi: ExtensionAPI) {
  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant" || message.provider !== "my-provider") return;
    if (message.stopReason !== "error") return;

    const errorMessage = message.errorMessage ?? "";
    if (errorMessage.includes("context_length_exceeded")) return;
    if (!PROVIDER_OVERFLOW.test(errorMessage)) return;

    return {
      message: {
        ...message,
        errorMessage: `context_length_exceeded: ${errorMessage}`,
      },
    };
  });
}
```

Do not rewrite rate limits, authentication failures, or generic server errors as overflows. With auto-compaction enabled, Pi removes the failed assistant message from live context, compacts, and retries once. Test the normalized message with the public `isContextOverflow()` helper and the model's configured `contextWindow`.

## Testing

Use the local examples as references rather than copying pi-ai's private implementation or test sources. Test a custom stream directly by iterating its public `AssistantMessageEventStream`, then awaiting `stream.result()` for the final message.

At minimum, cover:

- registration and discovery with `pi -e path/to/extension --list-models`;
- normal text, thinking, and tool-call event ordering, including fragmented tool JSON;
- final usage/cost values, empty responses, provider errors, and aborts;
- resolved API keys and headers, plus payload/response hook forwarding for a stream that makes HTTP itself;
- the configured context window and overflow normalization with `isContextOverflow(message, model.contextWindow)`;
- one interactive request with the selected provider, including a tool call if the provider claims tool support.

The two example extensions above cover the two main test seams: direct custom event production and delegation to Pi AI's public streaming APIs.
