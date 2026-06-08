# Models architecture

This document describes the target design for the next `pi-ai` model/provider refactor. It intentionally describes the desired shape, not the current implementation.

Goals:

- `Models` is a dumb runtime collection of providers.
- Concrete providers own metadata, auth, model listing, and stream behavior.
- API implementations live under `src/ai/` and are reusable/lazy.
- Concrete provider factories live under `src/providers/`.
- Users can import only the providers they need.
- Importing a provider should not eagerly import heavy SDKs.
- Dynamic model lists are first-class and side-effect-free.
- `models.json` and extensions layer by wrapping providers, not by mutating provider internals ad hoc.

Non-goals for the immediate `pi-ai` pass:

- Do not migrate coding-agent `ModelRegistry` yet.
- Do not preserve old process-global APIs unless as explicit temporary compatibility shims.
- Do not keep the stream/API registry inside `Models`.

## Package layout

Target source layout:

```txt
packages/ai/src/
  index.ts                    # core exports only; no built-in provider imports
  models.ts                   # Models, Provider, auth, runtime types
  auth/                       # shared auth helpers, local/OAuth wrappers
  ai/                         # API implementations and lazy API wrappers
    openai-compatible.ts      # real implementation, imports SDKs
    openai-compatible-lazy.ts # lightweight lazy wrapper
    anthropic.ts
    anthropic-lazy.ts
    bedrock.ts
    bedrock-lazy.ts
    ...
  providers/                  # concrete provider factories and per-provider catalogs
    openai.ts
    openai.models.ts          # OpenAI provider catalog
    openai-codex.ts
    openai-codex.models.ts    # OpenAI Codex provider catalog
    openrouter.ts
    openrouter.models.ts
    anthropic.ts
    anthropic.models.ts
    google-vertex.ts
    google-vertex.models.ts
    bedrock.ts
    bedrock.models.ts
    cloudflare-ai-gateway.ts
    cloudflare-ai-gateway.models.ts
    all.ts                    # explicit aggregate for pi CLI/coding-agent
```

`src/index.ts` must stay core-only. It must not import:

- all generated model metadata
- built-in provider factories
- provider SDK implementations
- Node-only OAuth modules
- `providers/all`

Provider and API entrypoints are explicit subpath exports.

## Public usage

Minimal provider usage:

```ts
import { createModels } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

const models = createModels();
models.setProvider(openaiProvider());

const model = await models.getModel("openai", "gpt-4o-mini");
if (!model) throw new Error("model not found");

const response = await models.complete(model, context);
```

Multiple providers:

```ts
import { createModels } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

const models = createModels();
models.setProvider(openaiProvider());
models.setProvider(openrouterProvider());
```

All built-ins, explicitly heavy metadata entrypoint:

```ts
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

const models = builtinModels();
```

`providers/all` may import all provider metadata/catalogs. It still must not eagerly import heavy SDK implementations; provider streams use lazy wrappers.

## Core runtime: Models

`Models` is a provider collection plus auth application and stream convenience. It does not contain a stream registry.

```ts
export interface Models {
  getProviders(): readonly Provider[];
  getProvider(id: string): Provider | undefined;

  getModels(provider?: string, options?: { forceRefresh?: boolean }): Promise<readonly Model<Api>[]>;
  getModel(provider: string, id: string, options?: { forceRefresh?: boolean }): Promise<Model<Api> | undefined>;

  getAuth(model: Model<Api>): Promise<ModelAuth | undefined>;

  stream<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ApiStreamOptions<TApi>,
  ): AssistantMessageEventStream;

  complete<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ApiStreamOptions<TApi>,
  ): Promise<AssistantMessage>;

  streamSimple<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream;

  completeSimple<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: SimpleStreamOptions,
  ): Promise<AssistantMessage>;
}

export interface MutableModels extends Models {
  /** Upsert/replace by provider.id. Provider ids are unique. */
  setProvider(provider: Provider): void;
  deleteProvider(id: string): void;
  clearProviders(): void;

  getAuthResolver(): ModelAuthResolver;
  setAuthResolver(resolver: ModelAuthResolver): void;
}
```

No stream registry:

```txt
remove Models.setStreamFunctions()
remove Models.getStreamFunctions()
remove api-registry as real API
```

No provider builder mutation API as public API:

```txt
remove/avoid Models.provider(id)
remove setModel/upsertModel/patchModel public lifecycle
```

A `MutableModels` implementation may still use internal maps, but the public object is provider-oriented.

## Provider

A provider is the concrete runtime unit. It owns:

- id/name/base metadata
- auth behavior
- model listing
- stream behavior

Full stream options are API-specific. The generic `Model<TApi>` only pays off if the stream option type is derived from `TApi`.

```ts
export type ApiStreamOptions<TApi extends Api> = StreamOptionsForApi<TApi>;

export interface Provider {
  readonly id: string;
  readonly name: string;

  /** Default model API metadata/diagnostics, not Models dispatch. */
  readonly api?: Api;

  readonly baseUrl?: string;
  readonly headers?: Record<string, string>;

  /** Required. Use {} for no-auth providers. */
  readonly auth: ProviderAuth;

  getModels(options?: { forceRefresh?: boolean }): Promise<readonly Model<Api>[]>;

  stream<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ApiStreamOptions<TApi>,
  ): AssistantMessageEventStream;

  streamSimple<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream;
}
```

`Model.api` should remain for now because:

- existing metadata and tests use it
- it is useful for diagnostics
- custom provider helpers may use it for API implementation selection

But `Models` no longer dispatches through `model.api`. The provider does.

## Provider model sources

Provider model listing is async.

```ts
export type ProviderModelSource =
  | readonly Model<Api>[]
  | ((options?: { forceRefresh?: boolean }) => Promise<readonly Model<Api>[]>);
```

Provider helpers can accept `ProviderModel[]` and resolve provider defaults, but public `Provider.getModels()` returns full `Model<Api>` objects.

Dynamic model sources must be side-effect-free discovery:

```txt
OK: fetch /v1/models, enumerate local catalog, refresh cached remote model list
Not OK: load model, download model, mutate server state, run request probe
```

Provider-specific model lifecycle belongs in app/provider-management commands, not in `getModels()`.

## Streaming path

`Models.stream()` finds the provider by `model.provider`, resolves request auth, applies request-scoped auth, and delegates to the provider.

```ts
async function stream(model, context, options) {
  const provider = getProvider(model.provider);
  if (!provider) throw new ModelsError(...);

  const auth = await getAuth(model);
  const requestModel = auth?.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
  const requestOptions = mergeAuthIntoOptions(options, auth);

  return provider.stream(requestModel, context, requestOptions);
}
```

`stream()` still returns `AssistantMessageEventStream` synchronously. Async setup happens inside the returned stream, as today.

No request hot-path model canonicalization. If an app wants fresh model metadata after refresh, it must call:

```ts
const model = await models.getModel(provider, id, { forceRefresh: true });
```

before starting the turn.

## API implementations under `src/ai`

An API implementation is reusable stream behavior. It is not a provider.

Example real implementation:

```ts
// src/ai/openai-compatible.ts
import OpenAI from "openai";

export function streamOpenAICompatible(...) { ... }
export function streamSimpleOpenAICompatible(...) { ... }
```

Example lazy wrapper:

```ts
// src/ai/openai-compatible-lazy.ts
export function openAICompatibleApi(): ProviderStreams {
  return {
    stream(model, context, options) {
      return lazyStream(() =>
        import("./openai-compatible.ts").then((m) =>
          m.streamOpenAICompatible(model, context, options),
        ),
      );
    },

    streamSimple(model, context, options) {
      return lazyStream(() =>
        import("./openai-compatible.ts").then((m) =>
          m.streamSimpleOpenAICompatible(model, context, options),
        ),
      );
    },
  };
}
```

Provider modules import lazy API wrappers, never real SDK-heavy implementation modules.

```txt
provider module -> lazy API wrapper -> dynamic import(real API impl) -> SDK deps
```

This preserves both:

- provider-owned stream behavior
- lazy SDK loading

## Shared API implementations across concrete providers

Many concrete providers share an API implementation. Example:

- OpenAI
- OpenRouter
- Groq
- Together
- DeepSeek
- Cloudflare AI Gateway OpenAI-compatible models

They should share lazy API objects by reference, not through `Models` stream registry.

```ts
import { openAICompatibleApi } from "../ai/openai-compatible-lazy.ts";

const api = openAICompatibleApi();

export function openrouterProvider(): Provider {
  return {
    id: "openrouter",
    name: "OpenRouter",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    auth: { local: envLocalAuth(["OPENROUTER_API_KEY"]) },
    getModels: staticModels(OPENROUTER_MODELS),
    stream: api.stream,
    streamSimple: api.streamSimple,
  };
}
```

This copies Vercel AI SDK’s useful property: users import concrete providers, while shared protocol implementation is internal.

## Auth

Request auth output stays small.

```ts
export interface ModelAuth {
  apiKey?: string;
  headers?: Record<string, string>;
  baseUrl?: string;
}
```

No `streamOptions` in auth. If a value cannot be expressed as `apiKey`, `headers`, or `baseUrl`, it is provider config, not auth.

Provider auth:

```ts
export interface ProviderAuth {
  local?: LocalAuthProvider;
  oauth?: OAuthProvider;
}
```

`auth` is required on `Provider`; no-auth providers use `{}`.

### Local auth

Local auth covers non-OAuth credentials:

- env API keys
- files on disk
- ambient SDK credentials
- AuthStorage local credentials
- models.json local credentials
- provider-specific credential metadata

```ts
export interface ProviderAuthContext {
  env(name: string): Promise<string | undefined>;
  fileExists(path: string): Promise<boolean>; // supports leading ~
}

export interface LocalCredential {
  type: "local";
  key?: string;
  metadata?: Record<string, string>;
}

export interface OAuthCredential extends OAuthCredentials {
  type: "oauth";
}

export type Credential = LocalCredential | OAuthCredential;

export interface LocalAuthProvider {
  id: string;
  name: string;

  login?(callbacks: AuthLoginCallbacks): Promise<LocalCredential>;

  resolve(input: {
    model: Model<Api>;
    ctx: ProviderAuthContext;
    credential?: LocalCredential;
  }): Promise<AuthResolution | undefined>;
}

export interface AuthResolution {
  auth: ModelAuth;
  sources: readonly ProviderAuthSource[];
}

export type ProviderAuthSource =
  | { type: "env"; name: string }
  | { type: "file"; path: string; label?: string }
  | { type: "ambient"; label: string };
```

Local auth receives an optional credential from the app. It does not read AuthStorage itself.

Examples:

- OpenAI: `credential.key ?? env("OPENAI_API_KEY")` -> `{ apiKey }`
- Bedrock: bearer token -> `{ apiKey }`; AWS profile/IAM/ECS/IRSA -> `{}`
- Vertex: API key -> `{ apiKey }`; ADC files -> `{}`
- Cloudflare: key + account/gateway metadata/env -> `{ apiKey, baseUrl }`

### OAuth

```ts
export interface OAuthProvider {
  id: string;
  name: string;
  usesCallbackServer?: boolean;

  login(callbacks: AuthLoginCallbacks): Promise<OAuthCredential>;

  resolve(credentials: OAuthCredential): Promise<{
    credentials: OAuthCredential;
    auth: ModelAuth;
  }>;
}
```

OAuth receives stored OAuth credentials, may refresh them, and returns updated credentials for the app to persist.

### Login callbacks

One callback interface serves local and OAuth login. Use the nicer `prompt()` / `notify()` shape now instead of carrying forward the ad hoc OAuth callback bag.

```ts
export interface AuthLoginCallbacks {
  signal?: AbortSignal;

  prompt<TPrompt extends AuthPrompt>(
    prompt: TPrompt,
    options?: { signal?: AbortSignal },
  ): Promise<AuthPromptResult<TPrompt>>;

  notify(event: AuthEvent): void;
}

export type AuthPrompt =
  | {
      type: "text";
      id: string;
      message: string;
      placeholder?: string;
      allowEmpty?: boolean;
      required?: boolean;
    }
  | {
      type: "secret";
      id: string;
      message: string;
      placeholder?: string;
      required?: boolean;
    }
  | {
      type: "select";
      id: string;
      message: string;
      options: readonly { id: string; label: string; description?: string }[];
    }
  | {
      type: "manual_code";
      id: string;
      message: string;
      placeholder?: string;
    };

export type AuthPromptResult<TPrompt extends AuthPrompt> = string;

export type AuthEvent =
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };
```

Codex browser login can race a `manual_code` prompt against a callback server by passing an abort signal to `prompt(..., { signal })` and aborting the prompt when the callback wins.

### OAuth implementation target

OAuth providers must not force Node-only code into browser bundles. Keep OAuth lazy, and let each concrete provider factory decide whether to attach a Node OAuth implementation, a web OAuth implementation, or no OAuth implementation.

Do not build a universal OAuth runtime abstraction in this refactor. The provider factory option is enough:

```ts
export type OAuthTarget = "node" | "web" | false;

export interface AnthropicProviderOptions {
  oauth?: OAuthTarget;
}

export function anthropicProvider(options: AnthropicProviderOptions = {}): Provider {
  return {
    id: "anthropic",
    name: "Anthropic",
    api: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    auth: {
      local: envLocalAuth("anthropic-api-key", "Anthropic API key", ["ANTHROPIC_API_KEY"]),
      oauth:
        options.oauth === "node"
          ? lazyOAuthProvider({
              id: "anthropic",
              name: "Anthropic (Claude Pro/Max)",
              usesCallbackServer: true,
              load: () => import("../oauth/anthropic-node.ts").then((m) => m.anthropicOAuthProvider),
            })
          : options.oauth === "web"
            ? lazyOAuthProvider({
                id: "anthropic",
                name: "Anthropic (Claude Pro/Max)",
                load: () => import("../oauth/anthropic-web.ts").then((m) => m.anthropicOAuthProvider),
              })
            : undefined,
    },
    getModels: staticModels(ANTHROPIC_MODELS),
    stream: anthropicApi().stream,
    streamSimple: anthropicApi().streamSimple,
  };
}
```

Recommended defaults:

- individual provider factories default to `oauth: false` unless we intentionally want Node defaults
- `providers/all` for pi CLI/coding-agent calls providers with `oauth: "node"`
- browser users call providers with `oauth: "web"`
- users that only want API-key/env auth leave OAuth disabled

Sitegeist demonstrates that browser-compatible OAuth is practical for Anthropic, OpenAI Codex, GitHub Copilot, and Gemini CLI. The browser implementations use Web Crypto, auth tabs, localhost redirect URL watching through extension tab APIs, `fetch` for token exchange, CORS permissions/proxies where needed, and device-code polling for Copilot.

So the target is not “OAuth is Node-only”. The target is: provider factories attach the right lazy OAuth module for the runtime the caller asked for.

Use a lazy wrapper so provider definitions can advertise OAuth without importing the actual implementation:

```ts
export function lazyOAuthProvider(input: {
  id: string;
  name: string;
  usesCallbackServer?: boolean;
  load: () => Promise<OAuthProvider>;
}): OAuthProvider {
  return {
    id: input.id,
    name: input.name,
    usesCallbackServer: input.usesCallbackServer,
    async login(callbacks) {
      return (await input.load()).login(callbacks);
    },
    async resolve(credentials) {
      return (await input.load()).resolve(credentials);
    },
  };
}
```

## Auth resolution policy

`pi-ai` can ship a default resolver using injected context/store. Applications can replace it.

Recommended default order, low to high precedence:

```txt
provider local auth defaults
-> CredentialStore local/OAuth credential
-> explicit request auth
```

coding-agent later adds models.json and CLI policy:

```txt
provider local auth defaults
-> AuthStorage credential
-> models.json auth sidecar
-> CLI/runtime explicit request auth
```

Auth values merge:

- later `apiKey` wins
- later `baseUrl` wins
- headers shallow-merge; later wins per header

Cloudflare requires merge, not early return. It may need env account/gateway + stored key, or stored metadata + env token.

## Provider wrappers and models.json

`models.json` is naturally a provider wrapper layer.

It should not mutate a provider in place. It should wrap:

```ts
function withProviderOverrides(base: Provider, overrides: ProviderOverrides): Provider {
  return {
    ...base,
    name: overrides.name ?? base.name,
    baseUrl: overrides.baseUrl ?? base.baseUrl,
    headers: mergeHeaders(base.headers, overrides.headers),

    async getModels(options) {
      const models = await base.getModels(options);
      return applyModelOverrides(models, overrides.models);
    },

    stream: base.stream,
    streamSimple: base.streamSimple,
  };
}
```

This composes with dynamic providers because `getModels()` delegates to the base provider source.

Request-auth config from models.json remains app-owned sidecar state. It is not stored in `Provider` unless it is true provider metadata such as base URL or headers.

## Custom providers from models.json

A models.json custom provider must become a concrete `Provider` object.

### Single API custom provider

If all models use one known API:

```json
{
  "providers": {
    "my-openai-proxy": {
      "api": "openai-completions",
      "baseUrl": "https://proxy.example/v1",
      "models": [ ... ]
    }
  }
}
```

coding-agent/pi-ai helper can build:

```ts
createApiBackedProvider({
  id: "my-openai-proxy",
  name: "my-openai-proxy",
  api: "openai-completions",
  baseUrl: "https://proxy.example/v1",
  auth: {},
  models,
  apiImplementation: openAICompatibleApi(),
});
```

This helper lives outside `Models`; it is provider construction sugar.

### Mixed API custom provider

Custom providers with mixed APIs must be supported. Existing providers such as opencode-go/zen can expose models backed by different APIs under one provider id. In this design that means the provider dispatches internally.

```ts
createDispatchProvider({
  id,
  models,
  apis: {
    "openai-completions": openAICompatibleApi(),
    "anthropic": anthropicApi(),
  },
});
```

The returned provider still exposes only:

```ts
stream(model, context, options)
streamSimple(model, context, options)
```

Internally it switches on `model.api` and calls the right lazy API implementation.

This preserves the rule that `Models` has no stream registry while supporting required mixed-API providers.

## Tree-shaking and lazy imports

Rules:

1. Main `@earendil-works/pi-ai` import is core-only.
2. Provider modules import metadata, model catalog, auth helpers, and lazy API wrappers only.
3. Lazy API wrappers dynamically import real API implementations.
4. Real API implementations import SDK dependencies.
5. OAuth providers are selected by provider factory option (`oauth: "node" | "web" | false`) and lazy-loaded; provider metadata must not eagerly import Node-only OAuth code.
6. `providers/all` is explicit and allowed to import all provider metadata, but still no eager SDK imports.
7. Provider modules are side-effect-free; importing a provider does not register it globally.
8. `package.json` should set `sideEffects: false` if all entrypoints are side-effect-free.

Example exports:

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./providers/openai": "./dist/providers/openai.js",
    "./providers/anthropic": "./dist/providers/anthropic.js",
    "./providers/openrouter": "./dist/providers/openrouter.js",
    "./providers/all": "./dist/providers/all.js",
    "./ai/openai-compatible": "./dist/ai/openai-compatible-lazy.js"
  }
}
```

To avoid metadata bloat for minimal users, generated model catalogs should be split per provider. Until then, any provider module importing the monolithic generated catalog can pull more metadata than necessary.

## Static typed helpers

The old global sync helpers are incompatible with dynamic providers:

```ts
getModel(...)
getModels(...)
getProviders(...)
```

If they mean runtime lookup, they must be async. If they remain sync and read only built-ins, they are misleading.

Target:

- remove old global runtime helpers, or make them async and default-instance backed only in a compatibility entrypoint
- add explicit static catalog helpers if type-safe built-in lookup is still desired

```ts
getBuiltinModel(provider, id)      // sync, generated catalog only
getBuiltinModels(provider)        // sync, generated catalog only
getBuiltinProviders()             // sync, generated catalog only
```

Runtime lookup is always:

```ts
await models.getModel(provider, id)
await models.getModels(provider)
```

## AgentHarness integration

`AgentHarness` receives a `Models` instance.

Rules:

- `AgentHarnessOptions.models` is required
- harness does not snapshot `Models` into turn state
- request path calls `models.streamSimple(model, context, options)` or equivalent
- request path does not call async `models.getModel()` to canonicalize
- if model metadata needs refresh, app updates the selected model before starting a turn

## coding-agent next phase

coding-agent should build providers in layers:

```txt
built-in providers
-> models.json provider wrappers
-> extension provider wrappers/additions
```

Then:

```ts
sessionModels.clearProviders();
for (const provider of layeredProviders) sessionModels.setProvider(provider);
sessionModels.setAuthResolver(codingAgentResolver);
```

coding-agent owns:

- AuthStorage local/OAuth files
- models.json auth sidecar
- `$ENV` and `!command`
- command execution policy
- provider status labels
- login/logout UI
- extension lifecycle
- provider-management slash commands

## Migration TODOs

1. Restore/remove half-implemented old auth/stream-registry changes before starting this design.
2. Redesign `packages/ai/src/models.ts` around provider-owned streams.
3. Remove `StreamFunctions` registry from `Models` public API.
4. Introduce `Provider` with required `auth`, async `getModels()`, `stream()`, and `streamSimple()`.
5. Add lazy API wrappers under `packages/ai/src/ai/`.
6. Move real API implementations under `packages/ai/src/ai/` or adapt existing stream files into that layout.
7. Add concrete provider factories under `packages/ai/src/providers/`.
8. Add `providers/all` explicit aggregate.
9. Add `lazyOAuthProvider()`, `OAuthTarget`, and provider factory options such as `anthropicProvider({ oauth: "node" | "web" | false })`.
10. Convert built-in OAuth attachment to lazy target-specific wrappers.
11. Split generated model catalogs per provider, or mark as follow-up if too large.
12. Replace old global `defaultModels()`/global helpers with explicit instance usage or compatibility entrypoint.
13. Add custom provider helpers:
    - `createApiBackedProvider()`
    - `createDispatchProvider()` for required mixed-API providers
14. Update `AgentHarness` to use provider-owned `models.streamSimple()` without stream registry lookups.
15. Keep coding-agent compatibility only as needed until the coding-agent `ModelManager` migration.
16. Update tests to construct explicit `Models` instances and install only needed providers/faux providers.

## Error behavior

`undefined` means not found or not configured.
Real failures reject or become stream errors.

Recommended error codes:

```ts
export type ModelsErrorCode =
  | "model_source"
  | "model_validation"
  | "provider"
  | "stream"
  | "auth"
  | "oauth";
```

`Models.stream()` should produce stream errors for async setup failures. `getModels()` should isolate provider source failures when listing all providers if possible, so one dynamic provider failure does not prevent listing other providers.
