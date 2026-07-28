# Custom Models

Use `~/.pi/agent/models.json` to add static providers and models, such as Ollama, vLLM, LM Studio, and compatible proxies. For a provider that needs OAuth, dynamic discovery, request rewriting, or a protocol Pi AI does not implement, use an [extension](custom-provider.md) instead.

Pi reads this file at startup and on a model refresh, including when you open `/model`; restart is not required. It is a configuration overlay, not a discovered catalog stored in `models-store.json`.

## Table of Contents

- [Minimal Example](#minimal-example)
- [Full Example](#full-example)
- [Google Generative AI Example](#google-generative-ai-example)
- [API Tags](#api-tags)
- [Provider Configuration](#provider-configuration)
  - [Value Resolution](#value-resolution)
  - [Custom Headers](#custom-headers)
- [Model Configuration](#model-configuration)
  - [Thinking Level Map](#thinking-level-map)
- [Overriding Built-in Providers](#overriding-built-in-providers)
- [Per-model Overrides](#per-model-overrides)
- [Compatibility Options](#compatibility-options)
  - [Anthropic Messages Compatibility](#anthropic-messages-compatibility)
  - [OpenAI Compatibility](#openai-compatibility)
    - [OpenAI Chat Completions](#openai-chat-completions)
    - [OpenAI Responses](#openai-responses)

## Minimal Example

For local OpenAI-compatible servers such as Ollama, LM Studio, and vLLM, each model needs only an `id` when the provider supplies the endpoint and API tag:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "llama3.1:8b" },
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```

`"ollama"` is a literal placeholder: Ollama ignores it, while Pi uses its presence to mark the provider as configured so its models appear in `/model`. A keyless server can instead use a saved key from `/login` or a CLI `--api-key` supplied with an explicit model selection.

Some OpenAI-compatible servers do not understand the `developer` role Pi uses for reasoning models, or `reasoning_effort`. Set the corresponding compatibility flags when necessary:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "gpt-oss:20b",
          "reasoning": true
        }
      ]
    }
  }
}
```

Provider `compat` supplies defaults for its models; a model's `compat` refines those defaults. See [Compatibility Options](#compatibility-options).

## Full Example

Override defaults when you need specific metadata:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        {
          "id": "llama3.1:8b",
          "name": "Llama 3.1 8B (Local)",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 32000,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

## Google Generative AI Example

Use `google-generative-ai` with a base URL for a new Google Generative AI-compatible provider:

```json
{
  "providers": {
    "my-google": {
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
      "api": "google-generative-ai",
      "apiKey": "$GEMINI_API_KEY",
      "models": [
        {
          "id": "gemma-4-31b-it",
          "name": "Gemma 4 31B",
          "input": ["text", "image"],
          "contextWindow": 262144,
          "reasoning": true
        }
      ]
    }
  }
}
```

The `baseUrl` is required here because `my-google` has no existing catalog model to supply one. It is not a special requirement of `google-generative-ai`: a model can also declare its own `baseUrl`.

## API Tags

`api` is a nonempty string. Pi AI provides these built-in tags; the endpoint and authentication requirements still depend on the selected API and provider.

| API tag | Protocol |
| --- | --- |
| `anthropic-messages` | Anthropic Messages |
| `openai-completions` | OpenAI Chat Completions |
| `openai-responses` | OpenAI Responses |
| `azure-openai-responses` | Azure OpenAI Responses |
| `openai-codex-responses` | OpenAI Codex Responses |
| `mistral-conversations` | Mistral Conversations |
| `google-generative-ai` | Google Generative AI |
| `google-vertex` | Google Vertex AI |
| `bedrock-converse-stream` | Amazon Bedrock Converse Stream |
| `pi-messages` | Pi Messages, including Radius gateways |

See [Custom Providers: API and Model Configuration](custom-provider.md#api-and-model-configuration) for when to use each tag and an extension-owned custom API. An extension can register a custom API tag; `models.json` alone cannot implement an arbitrary protocol.

At provider level, `api` is the default for entries in that provider's `models` array. A model's `api` takes precedence. It does **not** change the API tag of an existing built-in or extension model; replace that model with a `models` entry using the same `id` if it must use another API.

## Provider Configuration

Each key in `providers` is the provider ID used by `/model`, `--provider`, saved credentials, and model references.

| Field | Description |
| --- | --- |
| `name` | Optional display name for the provider. Defaults to its ID. |
| `baseUrl` | Default endpoint for this provider's models. A new provider normally needs this for its first custom model; a model may override it. |
| `api` | Default [API tag](#api-tags) for entries in `models`. |
| `apiKey` | Optional fallback API-key value; see [Value Resolution](#value-resolution) and [credential resolution](providers.md#resolution-order). |
| `oauth` | Dynamic OAuth provider type. `"radius"` is the only supported value and requires a Radius gateway `baseUrl`; see [Providers: Radius](providers.md#radius). |
| `headers` | Request headers for every model on the provider; see [Custom Headers](#custom-headers). |
| `authHeader` | Adds `Authorization: Bearer <resolved apiKey>` after resolving authentication. |
| `compat` | Compatibility defaults merged into the provider's models; see [Compatibility Options](#compatibility-options). |
| `models` | Custom model definitions. On a built-in provider they are added or replaced by `id`; other catalog models remain. |
| `modelOverrides` | Partial changes for matching final models, including built-in and extension-registered models; see [Per-model Overrides](#per-model-overrides). |

A custom model needs an effective `baseUrl` and `api`. For a new provider, put both on the provider (the usual approach) or on its first model. On a built-in provider, a model that replaces an existing ID can fall back to that catalog model's endpoint and API. `contextWindow` and `maxTokens`, when supplied in a `models` entry, must be positive.

`apiKey` is not required to parse the file. A provider becomes available when it has a CLI `--api-key`, saved `/login` credential, applicable environment credential, or configured `apiKey`. Without configured authentication, its models remain unavailable in `/model` and `--list-models`.

### Value Resolution

`apiKey` and every configured header value support shell commands, environment interpolation, and literals:

- **Shell command:** a value beginning with `!` runs the rest of the value as a shell command and uses trimmed stdout.
  ```json
  "apiKey": "!security find-generic-password -ws 'anthropic'"
  "apiKey": "!op read 'op://vault/item/credential'"
  ```
- **Environment interpolation:** `$ENV_VAR` and `${ENV_VAR}` interpolate a variable; interpolation also works inside larger literals.
  ```json
  "apiKey": "$MY_API_KEY"
  "apiKey": "${KEY_PREFIX}_${KEY_SUFFIX}"
  ```
  `$FOO_BAR` means the variable `FOO_BAR`; use `${FOO}_BAR` when `_BAR` is literal text. Missing variables leave the value unresolved.
- **Escapes:** `$$` emits a literal `$`; `$!` emits a literal `!` without turning the value into a command.
  ```json
  "apiKey": "$$literal-dollar-prefix"
  "apiKey": "$!literal-bang-prefix"
  ```
- **Literal:** any other text is used as-is. Uppercase strings are not inferred as environment variables.
  ```json
  "apiKey": "sk-..."
  "apiKey": "MY_API_KEY"
  ```

When a `models.json` value is used, it is resolved for every request. In particular, commands are not cached, reused after a failure, or given a built-in TTL; implement any required caching or fallback in your command or script. A failed command or unresolved header/environment reference fails that request. `/model` availability checks do not execute commands.

Provider-scoped `env` values saved with an API-key credential in `auth.json` take precedence over the process environment during this resolution. See [Providers: Auth File](providers.md#auth-file).

### Custom Headers

`headers` can be set on a provider, a `models` entry, or a `modelOverrides` entry:

```json
{
  "providers": {
    "custom-proxy": {
      "baseUrl": "https://proxy.example.com/v1",
      "apiKey": "$MY_API_KEY",
      "api": "anthropic-messages",
      "headers": {
        "x-portkey-api-key": "$PORTKEY_API_KEY",
        "x-secret": "!op read 'op://vault/item/secret'"
      },
      "models": [
        {
          "id": "proxy-model",
          "headers": {
            "x-model-route": "fast"
          }
        }
      ]
    }
  }
}
```

Provider headers apply to every request. A configured model header overrides the same provider header case-insensitively. If both a `models` entry and `modelOverrides` configure the same header for one model, the `models` entry wins; a model header from a named extension provider registration wins over both. Pi AI and built-in providers can add their own headers; configured model headers are merged last.

`models.json` header values must be strings. Unlike the public Pi AI request-header type, `null` cannot remove a built-in header here; use the [`before_provider_headers` extension hook](extensions.md#before_provider_headers) when a request must remove or rewrite headers. `authHeader` requires a resolved API key and adds its bearer header before model-specific headers are merged.

## Model Configuration

A `models` entry supplies a complete custom model definition with useful defaults. A model matching a built-in ID replaces that catalog entry rather than partially modifying it; use [`modelOverrides`](#per-model-overrides) for partial changes.

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `id` | Yes | — | Model identifier sent to the API. |
| `name` | No | `id` | Human-readable label. It is searchable by `--model` patterns and shown as model detail text. |
| `api` | No | Provider `api` | [API tag](#api-tags) for this model. |
| `baseUrl` | No | Provider `baseUrl` | Endpoint override for this model. |
| `reasoning` | No | `false` | Whether the model supports Pi thinking levels. |
| `thinkingLevelMap` | No | omitted | Maps Pi thinking levels to provider values and declares unsupported levels; see below. |
| `input` | No | `["text"]` | Supported input kinds: `text` and `image`. |
| `contextWindow` | No | `128000` | Context window in tokens. |
| `maxTokens` | No | `16384` | Maximum generated tokens. |
| `cost` | No | all rates `0` | Per-million-token rates and optional request-wide price tiers. |
| `headers` | No | omitted | Model-specific request headers; see [Custom Headers](#custom-headers). |
| `compat` | No | provider `compat` | Compatibility refinements merged with provider defaults. |

`/model`, `--list-models`, and the footer show a model's `id`; `name` does not replace it. The model selector and `--model` pattern matching also search `name`.

When `cost` is supplied on a `models` entry, it must contain all four base rates: `input`, `output`, `cacheRead`, and `cacheWrite`. Rates are per million tokens. Each tier likewise supplies all four rates and an `inputTokensAbove` threshold. A matching tier prices the entire request; Pi uses the tier with the highest threshold strictly below total input usage (`input + cacheRead + cacheWrite`).

```json
{
  "cost": {
    "input": 5,
    "output": 30,
    "cacheRead": 0.5,
    "cacheWrite": 6.25,
    "tiers": [
      {
        "inputTokensAbove": 272000,
        "input": 10,
        "output": 45,
        "cacheRead": 1,
        "cacheWrite": 12.5
      }
    ]
  }
}
```

### Thinking Level Map

`thinkingLevelMap` uses these Pi levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. It only affects a model with `reasoning: true`; a non-reasoning model exposes `off` only.

| Map value for a level | Effect |
| --- | --- |
| omitted | `off` through `high` remain supported with the API's default mapping. `xhigh` and `max` are unsupported unless they have a string mapping. |
| string | The level is supported and this value is sent to the provider. |
| `null` | The level is unsupported and hidden from the selector. |

Maps may contain holes. If a requested level is unavailable, Pi clamps to the next available higher level, then to the nearest lower one. For example, this model exposes `off`, `high`, and `max`:

```json
{
  "id": "deepseek-v4-pro",
  "reasoning": true,
  "thinkingLevelMap": {
    "minimal": null,
    "low": null,
    "medium": null,
    "high": "high",
    "xhigh": null,
    "max": "max"
  }
}
```

For a model that cannot disable thinking, mark `off` unsupported:

```json
{
  "id": "always-thinking-model",
  "reasoning": true,
  "thinkingLevelMap": {
    "off": null
  }
}
```

## Overriding Built-in Providers

Change a built-in provider's endpoint without redefining its models:

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://my-proxy.example.com/v1"
    }
  }
}
```

The built-in Anthropic catalog and its normal authentication remain in place. Credential precedence, including a configured `apiKey` fallback, is described in [Providers: Resolution Order](providers.md#resolution-order).

To add models to a built-in provider, include `models`:

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://my-proxy.example.com/v1",
      "apiKey": "$ANTHROPIC_API_KEY",
      "api": "anthropic-messages",
      "models": [
        { "id": "my-claude-alias", "reasoning": true }
      ]
    }
  }
}
```

The built-in models remain. A new custom `id` is added, while a matching ID is replaced by the custom definition and its defaults. Provider-level `baseUrl` and `compat` apply to the catalog models as well. To preserve catalog metadata while changing only selected fields, use `modelOverrides`.

## Per-model Overrides

`modelOverrides` applies partial changes to matching models after built-in/native models, `models` upserts, and extension-provided models have been composed. It does not create an unknown model and cannot change `id`, `api`, or `baseUrl`.

```json
{
  "providers": {
    "openrouter": {
      "modelOverrides": {
        "anthropic/claude-sonnet-4": {
          "name": "Claude Sonnet 4 (Bedrock Route)",
          "compat": {
            "openRouterRouting": {
              "only": ["amazon-bedrock"]
            }
          }
        }
      }
    }
  }
}
```

An override supports `name`, `reasoning`, `thinkingLevelMap`, `input`, `cost`, `contextWindow`, `maxTokens`, `headers`, and `compat`. Its `cost` base rates are individually optional and retain omitted values; a supplied `tiers` array replaces the existing array. Thinking maps merge by level. `compat` merges by field, and its `openRouterRouting`, `vercelGatewayRouting`, and `chatTemplateKwargs` objects merge by key.

If an override and a `models` entry use the same ID, the override still changes the final model. For headers only, the `models` entry wins on a duplicate header name as described in [Custom Headers](#custom-headers). Overrides also apply to matching extension-registered models; see [Custom Providers: Composition, Updates, and Removal](custom-provider.md#composition-updates-and-removal).

Direct OpenAI GPT-5.6 Sol, Terra, and Luna default to a `272000` context window so requests remain within OpenAI's short-context pricing tier. To use the 1.05M context window, override each model you use:

```json
{
  "providers": {
    "openai": {
      "modelOverrides": {
        "gpt-5.6-sol": {
          "contextWindow": 1050000
        }
      }
    }
  }
}
```

The override preserves catalog pricing metadata. Requests whose total input usage exceeds 272K use the GPT-5.6 long-context rates for the entire request. Apply the same override to `gpt-5.6-terra` or `gpt-5.6-luna` when needed.

## Compatibility Options

Set `compat` on a provider for defaults or on a `models`/`modelOverrides` entry for a model-specific refinement. The selected API interprets these options; do not use an option for a different API in the expectation that Pi will translate it. Standard endpoint quirks are usually better expressed here than by writing a custom stream.

## Anthropic Messages Compatibility

For `api: "anthropic-messages"`, use these options for Anthropic-compatible endpoints:

| Field | Description |
| --- | --- |
| `supportsEagerToolInputStreaming` | Accepts per-tool `eager_input_streaming`. Default: `true`. When `false`, Pi omits it and sends the legacy `fine-grained-tool-streaming-2025-05-14` beta header for tool-enabled requests. |
| `supportsLongCacheRetention` | Accepts `cache_control.ttl: "1h"` for long cache retention. Default: `true`. |
| `sendSessionAffinityHeaders` | Sends `x-session-affinity` from the session ID when caching is enabled. Default: `false`; built-in model metadata can enable it for providers that need it. |
| `supportsCacheControlOnTools` | Accepts Anthropic `cache_control` on tool definitions. Default: `true`. |
| `supportsTemperature` | Accepts non-default `temperature`. Default: `true`; set `false` for endpoints such as Claude Opus 4.7+ that reject it. |
| `forceAdaptiveThinking` | Uses adaptive thinking (`thinking.type: "adaptive"` and `output_config.effort`) regardless of model ID. Default: `false`. |
| `allowEmptySignature` | Replays an empty thinking signature as `signature: ""` instead of converting the thinking block to text. Default: `false`. |
| `supportsStrictTools` | Accepts strict JSON-schema tool definitions. Default: `false`; capable built-in Anthropic models set it in their metadata. |
| `supportsToolReferences` | Accepts deferred tool loading with `tool_reference` blocks. The default is enabled only for supported recent first-party Anthropic models, and otherwise `false`. |

For example, a proxy that lacks eager streaming but supports long cache retention and adaptive thinking can use:

```json
{
  "providers": {
    "anthropic-proxy": {
      "baseUrl": "https://proxy.example.com",
      "api": "anthropic-messages",
      "apiKey": "$ANTHROPIC_PROXY_KEY",
      "compat": {
        "supportsEagerToolInputStreaming": false,
        "supportsLongCacheRetention": true,
        "forceAdaptiveThinking": true,
        "allowEmptySignature": true
      },
      "models": [
        {
          "id": "claude-opus-4-7",
          "reasoning": true,
          "input": ["text", "image"]
        }
      ]
    }
  }
}
```

## OpenAI Compatibility

### OpenAI Chat Completions

For `api: "openai-completions"`, Pi auto-detects many defaults from the provider ID and base URL. Set an option only when the endpoint differs from that behavior.

| Field | Description |
| --- | --- |
| `supportsStore` | Accepts `store: false`. Default: URL-detected. |
| `supportsDeveloperRole` | Uses `developer` rather than `system` for reasoning models. Default: URL-detected. |
| `supportsReasoningEffort` | Accepts `reasoning_effort` when the selected thinking format uses it. Default: URL-detected. |
| `supportsUsageInStreaming` | Accepts `stream_options: { "include_usage": true }`. Default: `true`. |
| `maxTokensField` | Selects `max_completion_tokens` or `max_tokens`. Default: URL-detected. |
| `requiresToolResultName` | Requires `name` on tool-result messages. Default: URL-detected. |
| `requiresAssistantAfterToolResult` | Requires an assistant message before a user message following tool results. Default: URL-detected. |
| `requiresThinkingAsText` | Replays thinking blocks as text delimited by `<thinking>`. Default: URL-detected. |
| `requiresReasoningContentOnAssistantMessages` | Includes empty `reasoning_content` on replayed assistant messages when reasoning is enabled. Default: URL-detected. |
| `thinkingFormat` | One of `openai`, `openrouter`, `deepseek`, `together`, `zai`, `qwen`, `chat-template`, `qwen-chat-template`, `string-thinking`, or `ant-ling`. Default: `openai` unless URL detection selects a known provider format. |
| `chatTemplateKwargs` | `chat_template_kwargs` for `thinkingFormat: "chat-template"`. Values may be strings, numbers, booleans, `null`, or `{ "$var": "thinking.enabled" | "thinking.effort", "omitWhenOff"?: true }`. |
| `zaiToolStream` | Sends top-level `tool_stream: true` when tools are present. Default: `false`; use only for Z.AI-compatible endpoints that require it. |
| `cacheControlFormat` | `anthropic` applies Anthropic-style `cache_control` markers to the system prompt, last tool definition, and final text content when caching is enabled. |
| `sendSessionAffinityHeaders` | Sends session-affinity headers from the session ID when caching is enabled. Default: `false`. |
| `sessionAffinityFormat` | `openai` sends `session_id`, `x-client-request-id`, and `x-session-affinity`; `openai-nosession` omits `session_id`; `openrouter` sends `x-session-id`. It does not change `prompt_cache_key`. Default: URL-detected. |
| `supportsStrictMode` | Accepts strict JSON-schema function tools. Default: URL-detected. |
| `supportsOpenAIGrammarTools` | Emits OpenAI Lark/regex grammar tools. When `false`, grammar-constrained tools fall back to normal function tools. Default: `false`. |
| `deferredToolsMode` | Provider-specific deferred-tool serialization. The only value is `kimi`. |
| `supportsLongCacheRetention` | Accepts long prompt-cache retention: `prompt_cache_retention: "24h"`, or `cache_control.ttl: "1h"` with `cacheControlFormat: "anthropic"`. Default: `true` except URL-detected incompatible endpoints. |
| `openRouterRouting` | OpenRouter routing preferences sent unchanged in the request `provider` field. |
| `vercelGatewayRouting` | Vercel AI Gateway routing preferences (`only`, `order`) sent as `providerOptions.gateway`. |

Thinking formats use these request shapes: `openai` sends `reasoning_effort`; `openrouter` sends `reasoning: { effort }`; `deepseek` sends `thinking: { type }` and, when enabled, `reasoning_effort`; `together` sends `reasoning: { enabled }` and optionally `reasoning_effort`; `zai` sends `thinking: { type }`; `qwen` sends `enable_thinking`; `qwen-chat-template` sends `chat_template_kwargs.enable_thinking` and `preserve_thinking`; `string-thinking` sends top-level `thinking` as a string; and `ant-ling` sends `reasoning: { effort }` only for a non-null mapped effort. `chat-template` sends the configured `chatTemplateKwargs`.

Use `qwen-chat-template` for local Qwen-compatible servers that need its fixed chat-template kwargs. Use `chat-template` for vLLM or Hugging Face templates that need custom kwargs, for example:

```json
{
  "compat": {
    "thinkingFormat": "chat-template",
    "chatTemplateKwargs": {
      "thinking": { "$var": "thinking.enabled" },
      "thinking_effort": { "$var": "thinking.effort", "omitWhenOff": true }
    }
  }
}
```

`cacheControlFormat: "anthropic"` is for OpenAI-compatible servers that expose Anthropic-style prompt caching. `openRouterRouting` and `vercelGatewayRouting` have the shapes defined by the [OpenRouter routing API](https://openrouter.ai/docs/guides/routing/provider-selection) and [Vercel AI Gateway](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options), respectively.

OpenRouter example:

```json
{
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "$OPENROUTER_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "anthropic/claude-3.5-sonnet",
          "name": "OpenRouter Claude 3.5 Sonnet",
          "compat": {
            "openRouterRouting": {
              "allow_fallbacks": true,
              "require_parameters": false,
              "data_collection": "deny",
              "zdr": true,
              "enforce_distillable_text": false,
              "order": ["anthropic", "amazon-bedrock", "google-vertex"],
              "only": ["anthropic", "amazon-bedrock"],
              "ignore": ["gmicloud", "friendli"],
              "quantizations": ["fp16", "bf16"],
              "sort": {
                "by": "price",
                "partition": "model"
              },
              "max_price": {
                "prompt": 10,
                "completion": 20
              },
              "preferred_min_throughput": {
                "p50": 100,
                "p90": 50
              },
              "preferred_max_latency": {
                "p50": 1,
                "p90": 3,
                "p99": 5
              }
            }
          }
        }
      ]
    }
  }
}
```

Vercel AI Gateway example:

```json
{
  "providers": {
    "vercel-ai-gateway": {
      "baseUrl": "https://ai-gateway.vercel.sh/v1",
      "apiKey": "$AI_GATEWAY_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "moonshotai/kimi-k2.5",
          "name": "Kimi K2.5 (Fireworks via Vercel)",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 0.6, "output": 3, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 262144,
          "maxTokens": 262144,
          "compat": {
            "vercelGatewayRouting": {
              "only": ["fireworks", "novita"],
              "order": ["fireworks", "novita"]
            }
          }
        }
      ]
    }
  }
}
```

### OpenAI Responses

For `api: "openai-responses"`, the compatible fields are `supportsDeveloperRole`, `sessionAffinityFormat`, `supportsLongCacheRetention`, `supportsStrictMode`, `supportsOpenAIGrammarTools`, `supportsToolSearch`, and `supportsExplicitPromptCacheMode`.

| Field | Description |
| --- | --- |
| `supportsDeveloperRole` | Uses `developer` rather than `system` for reasoning models. Default: `true`. |
| `sessionAffinityFormat` | `openai` sends `session_id` and `x-client-request-id`; `openai-nosession` omits `session_id`; `openrouter` sends `x-session-id`. It does not change `prompt_cache_key`. |
| `supportsLongCacheRetention` | Accepts `prompt_cache_retention: "24h"` for long cache retention. Default: `true`. |
| `supportsStrictMode` | Accepts strict JSON-schema function tools. Default: `false`. |
| `supportsOpenAIGrammarTools` | Emits OpenAI Lark/regex grammar tools. Default: `false`. |
| `supportsToolSearch` | Supports client-executed deferred tool search. Default: `false`. |
| `supportsExplicitPromptCacheMode` | Accepts `prompt_cache_options: { mode: "explicit" }` when cache retention is `none`, which disables implicit prompt caching. Default: `false`. |

The public Pi AI model type also exposes the Responses compatibility shape for `azure-openai-responses` and `openai-codex-responses`. The Azure transport uses `supportsDeveloperRole`, `supportsStrictMode`, and `supportsOpenAIGrammarTools`; the Codex transport uses `supportsStrictMode`, `supportsOpenAIGrammarTools`, and `supportsToolSearch`. Other Responses options do not alter those transports.

For `bedrock-converse-stream`, `compat.supportsStrictMode` controls Bedrock strict JSON-schema tool definitions and defaults to `false`. The other built-in API tags do not define model compatibility options.
