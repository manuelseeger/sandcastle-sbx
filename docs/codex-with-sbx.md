# Run Codex in a Sandcastle sbx project

This guide shows how a project such as `mes-bio` can run Sandcastle's Codex agent in Docker Sandboxes (`sbx`) while authenticating with a ChatGPT subscription. It assumes a version of `sandcastle-sbx` that supports `agent: "codex"`.

## 1. Build and load a Codex template

Build and load the provider's two standard images from the `sandcastle-sbx` checkout:

```sh
npm run prepare:sbx
```

This makes the following templates available to `sbx` on that host:

- `docker-sbx:dev` — Claude
- `docker-sbx-codex:dev` — Codex

The image tag and the `agent` value must match: `docker-sbx-codex:dev` must be created with `agent: "codex"`.

## 2. Authenticate sbx once on the host

For a ChatGPT/Codex subscription, use the Docker Sandboxes OAuth flow:

```sh
sbx secret set -g openai --oauth
```

Complete the browser login once on the machine that runs Sandcastle. The global sbx secret keeps the OAuth access and refresh state on the host; Docker Sandboxes' credential proxy uses it for subsequently created Codex VMs. The OpenAI refresh credential is not copied into the VM.

Do not set `OPENAI_API_KEY` for this subscription-backed path: that selects API-key billing rather than subscription authentication. Keep project credentials unrelated to OpenAI, such as `GH_TOKEN`, in `.sandcastle/.env` as usual.

If OAuth is revoked or can no longer refresh, an unattended run will fail authentication. Re-run the command above interactively on the host, and monitor Sandcastle logs for authentication failures.

## 3. Select Codex in the Sandcastle script

In mes-bio, the Sandcastle entrypoint is `.sandcastle/main.ts`. Change the Sandcastle agent factories from `claudeCode(...)` to `codex(...)`:

```ts
const highCapAgent = sandcastle.codex("gpt-5.4", { effort: "xhigh" });
const midCapAgent = sandcastle.codex("gpt-5.4", { effort: "high" });
const lowCapAgent = sandcastle.codex("gpt-5.4", { effort: "low" });
```

Then ensure the provider creates a Codex VM. If the project helper already sets a template, override it with the standard Codex image:

```ts
const createSandcastleSbxOptions = (scope: string) => {
  const timeoutMs = Number(process.env.SANDCASTLE_SBX_TIMEOUT_MS ?? 60 * 60_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("SANDCASTLE_SBX_TIMEOUT_MS must be a positive integer");
  }

  return {
    ...createSbxOptions(githubRepository, projectRoot, scope),
    agent: "codex",
    template: "docker-sbx-codex:dev",
    timeoutMs,
  };
};
```

`agent: "codex"` controls the Docker Sandboxes agent metadata and selects the provider's Codex template default. `sandcastle.codex("gpt-5.4", ...)` controls the CLI and model that run inside that VM. Set both together.

## 4. Run unattended

After the one-time host OAuth setup, run the existing project command normally:

```sh
npm run sandcastle
```

The provider creates a fresh Codex VM per operation, Sandcastle transfers the Git bundle, and `sbx` supplies subscription authentication through its host-side proxy. Codex session files are captured by Sandcastle; host `~/.codex/auth.json` is not mounted or copied.

Project `AGENTS.md` instructions arrive in the VM through the Git bundle. The provider deliberately does not copy `.claude/skills` to Codex VMs.

## Optional: retain Claude for selected roles

A run must pair the Sandcastle agent with its VM agent/template. If a project wants a Claude picker and a Codex implementer, create provider options separately for each invocation:

- Claude invocation: `agent: "claude"` with `docker-sbx:dev`.
- Codex invocation: `agent: "codex"` with `docker-sbx-codex:dev`.

Do not run `sandcastle.codex(...)` in a Claude-metadata sbx template or the reverse.
