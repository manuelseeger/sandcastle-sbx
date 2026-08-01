# Sandcastle sbx provider

A reusable [Sandcastle](https://www.npmjs.com/package/@ai-hero/sandcastle) isolated-sandbox provider backed by Docker Sandboxes (`sbx`). It creates an empty microVM workspace, lets Sandcastle transfer its Git bundle, and removes every created VM when the scoped operation finishes.

## Use from a Sandcastle script

Install this package alongside `@ai-hero/sandcastle`, then wrap each Sandcastle operation:

```ts
import * as sandcastle from "@ai-hero/sandcastle";
import { withDockerSbxProvider } from "sandcastle-sbx";

await withDockerSbxProvider({
  template: "my-sandcastle-sbx:dev",
  namePrefix: "my-project",
  env: { GH_REPO: "owner/repository" },
}, (provider) => sandcastle.run({ sandbox: provider /* ... */ }));
```

`withDockerSbxProvider` owns cleanup for a single Sandcastle operation. Use a separate call for concurrently running operations.

### Agents

Claude is the default agent and uses `docker-sbx:dev` unless `template` is supplied. To use Codex, set `agent: "codex"`; it defaults to `docker-sbx-codex:dev`:

```ts
await withDockerSbxProvider({
  agent: "codex",
  namePrefix: "my-project",
}, (provider) => sandcastle.run({ sandbox: provider /* use sandcastle.codex(...) here */ }));
```

An explicit `template` always overrides these defaults, but it must be built from the matching Docker Sandboxes base-agent template. Other agent strings are passed through unchanged and require an explicit compatible template.

The optional `projectRoot` copies that project's `.claude/skills` directory into Claude guests as a one-way snapshot. It rejects symbolic links and non-regular files; credentials and project files are never mounted. Codex does not receive this Claude-specific directory; repository instructions such as `AGENTS.md` arrive through Sandcastle's Git bundle.

## Templates

`Dockerfile.sbx` builds generic Claude Code and Codex coding templates with GitHub CLI, `uv`, and Playwright/Chrome available. Build and load the template for the agent you will run:

```sh
# Claude (the default)
docker build -f Dockerfile.sbx -t docker-sbx:dev .
docker image save docker-sbx:dev -o /tmp/docker-sbx-dev.tar
sbx template load /tmp/docker-sbx-dev.tar

# Codex
docker build -f Dockerfile.sbx -t docker-sbx-codex:dev \
  --build-arg BASE_IMAGE=docker.io/docker/sandbox-templates:codex \
  --build-arg AGENT_NPM_PACKAGE=@openai/codex \
  --build-arg AGENT_BIN=codex .
docker image save docker-sbx-codex:dev -o /tmp/docker-sbx-codex-dev.tar
sbx template load /tmp/docker-sbx-codex-dev.tar
```

Before running Codex, configure OpenAI access with Docker Sandboxes on the host rather than copying host credentials into a guest. For example, use `sbx secret set -g openai --oauth` for ChatGPT OAuth, or `sbx secret set -g openai` for an API key.

Application-specific runtimes, package caches, and sandbox setup belong in the consuming project's Sandcastle hooks or its own template.
