# Containerization

Pi runs with all permissions by default, but in some cases, you will want to have more control over what directories Pi can write to and which accesses it has.

There are two general options. You can either
1. run the whole `pi` process inside an isolated environment, or
2. run `pi` on the host and route tool execution into an isolated environment.

## Choose a pattern

| Pattern | What is isolated | Best for | Notes |
| --- | --- | --- | --- |
| Gondolin extension | Built-in tools and `!` commands | Local micro-VM isolation while keeping auth on host | See [`examples/extensions/gondolin/`](../examples/extensions/gondolin/). |
| Plain Docker | Whole `pi` process in a local container | Simple local isolation | Provider API keys enter the container. |
| OpenShell | Whole `pi` process in a policy-controlled sandbox | Local or remote managed sandbox | Requires an OpenShell gateway |
| Docker Sandboxes | Whole `pi` process in a managed sandbox | Local isolation with provider keys kept on the host | Requires `sbx` and a kit image containing `@astralyn/pi`. |

Extensions run wherever the `pi` process runs. If you run host `pi` with a tool-routing extension, other custom extension tools still run on the host unless they also delegate their operations.

## Gondolin

[Gondolin](https://github.com/earendil-works/gondolin) is a local Linux micro-VM.
Use the [example extension](../examples/extensions/gondolin) when you want `pi` on the host but all built-in tools routed into the VM.

Setup:

```bash
cp -R examples/extensions/gondolin ~/.pi/agent/extensions/gondolin
cd ~/.pi/agent/extensions/gondolin
npm install --ignore-scripts
```

Run from the project you want mounted:

```bash
cd /path/to/project
pi -e ~/.pi/agent/extensions/gondolin
```

The extension mounts the host cwd at `/workspace` in the VM and overrides `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`.
User `!` commands are routed into the VM, as well.
File changes under `/workspace` write through to the host.

Requirements: Node.js >= 23.6.0 for `@earendil-works/gondolin`, plus QEMU (requires installation through your package manager).

## Plain Docker

Run the whole `pi` process in Docker when you want the simplest local container boundary.

`Dockerfile.pi`:

```dockerfile
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts @astralyn/pi

WORKDIR /workspace
ENTRYPOINT ["pi"]
```

Build and run:

```bash
docker build -t pi-sandbox -f Dockerfile.pi .

docker run --rm -it \
  -e ANTHROPIC_API_KEY \
  -v "$PWD:/workspace" \
  -v pi-agent-home:/root/.pi/agent \
  pi-sandbox
```

The `-v "$PWD:/workspace"` mounts your current directory into the container at /workspace such that reads and writes in `/workspace` inside Docker directly affect your host files, like in the Gondolin example.

Use a named volume for `/root/.pi/agent` if you want container-local settings and sessions. Mounting your host `~/.pi/agent` exposes host auth and session files to the container.

## OpenShell

Use [NVIDIA OpenShell](https://docs.nvidia.com/openshell/about/overview) when you want a policy-controlled sandbox with filesystem, process, network, credential, and inference controls.
OpenShell can run sandboxes through a local gateway backed by Docker, Podman, or a VM runtime, or through a remote Kubernetes gateway.

Every sandbox requires an active gateway.
Register and select one before creating a sandbox:

```bash
openshell gateway add <gateway-url> --name <name>
openshell gateway select <name>
```

Launch `pi` inside an OpenShell sandbox:

```bash
openshell sandbox create --name pi-sandbox --from pi -- pi
```

In this pattern, the whole `pi` process runs inside the sandbox.
Built-in tools, `!` commands, and extension tools execute inside the OpenShell boundary.

If the gateway is remote, project files are not bind-mounted from the host, meaning writes in the sandbox are not reflected on your machine.
Clone the repository inside the sandbox or use OpenShell file transfer commands:

```bash
openshell sandbox upload pi-sandbox ./repo /workspace
openshell sandbox download pi-sandbox /workspace/repo ./repo-out
```

OpenShell providers can keep raw model API keys outside the sandbox.
When inference routing is configured, code inside the sandbox can call `https://inference.local`, and the gateway injects the configured provider credentials upstream.
Configure Pi to use the corresponding OpenAI-compatible or Anthropic-compatible endpoint if you want model traffic to use this route.

## Docker Sandboxes

[Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) runs the whole `pi` process inside a managed sandbox. Its proxy can keep provider credentials on the host and substitute the real credential for a sentinel when requests leave the sandbox.

Use the [community Pi kit](https://github.com/docker/sbx-kits-contrib/tree/main/pi) as a template for a local `./pi-kit`. Its published `docker.io/sbx/pi-kit` image installs upstream Pi. To use this distribution, change the kit's image build to install an exact `@astralyn/pi` version, build that image, and point the kit's `sandbox.image` at it.

Store the credential on the host before creating the sandbox. For an Anthropic API key:

```bash
sbx secret set anthropic
sbx run --kit ./pi-kit pi
```

For a Claude subscription token obtained with `claude setup-token`, use a custom credential binding instead of the `anthropic` service secret. If the service secret is already bound, remove that binding first so the proxy does not add both API-key and Bearer headers:

```bash
sbx secret rm anthropic
sbx secret set-custom \
  --host api.anthropic.com \
  --env ANTHROPIC_OAUTH_TOKEN \
  --placeholder 'sk-ant-oat01-{rand}'
```

`set-custom` reads the token from stdin. The sandbox receives an OAuth-shaped placeholder, and the proxy substitutes the real token on egress. Create a new sandbox after changing credential bindings. Authenticate on the host: running `/login` inside the sandbox writes a real token into its filesystem.

Scripted use runs against the same sandbox:

```bash
sbx exec <sandbox-name> -- pi -p "list the failing tests"
```

See the kit documentation for image builds, credential options, egress policies, and version pinning.
