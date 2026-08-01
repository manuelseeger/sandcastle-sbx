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

The optional `projectRoot` copies that project's `.claude/skills` directory into the guest as a one-way snapshot. It rejects symbolic links and non-regular files; credentials and project files are never mounted.

## Template

`Dockerfile.sbx` is a generic Claude Code coding template with GitHub CLI, `uv`, and Playwright/Chrome available. Build it from this repository and load it into `sbx`:

```sh
docker build -f Dockerfile.sbx -t docker-sbx:dev .
docker image save docker-sbx:dev -o /tmp/docker-sbx-dev.tar
sbx template load /tmp/docker-sbx-dev.tar
```

Application-specific runtimes, package caches, and sandbox setup belong in the consuming project's Sandcastle hooks or its own template.
