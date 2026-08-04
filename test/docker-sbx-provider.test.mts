import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  createDockerSbxHandle,
  withDockerSbxProvider,
  type SbxCommand,
} from "../src/docker-sbx-provider.mts";

const commands: string[][] = [];
const fakeCommand: SbxCommand = {
  async run(args) {
    commands.push([...args]);
  },
};

const failingCreateCommand: SbxCommand = {
  async run(args) {
    commands.push([...args]);
    if (args[0] === "create") throw new Error("create failed after allocation");
  },
};

async function makeProjectRoot(withSkills = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-project-"));
  if (withSkills) {
    const skills = join(root, ".agents", "skills", "example");
    await mkdir(skills, { recursive: true });
    await writeFile(join(skills, "SKILL.md"), "# Example\n");
  }
  return root;
}

test("createDockerSbxHandle copies approved .agents skills into Claude's compatibility path", async () => {
  commands.length = 0;
  const projectRoot = await makeProjectRoot();
  try {
    const handle = await createDockerSbxHandle(
      { command: fakeCommand, namePrefix: "test-sbx", projectRoot },
      { GH_TOKEN: "redacted" },
    );

    assert.equal(handle.worktreePath, "/home/agent/workspace");
    assert.deepEqual(commands[0]?.slice(0, 13), [
      "create", "--name", commands[0]?.[2]!, "--cpus", "4", "--memory", "8g",
      "--kit", resolve(".sbx/kits/nuget-restore"),
      "--no-share-skills", "--template", "docker-sbx:dev", "claude",
    ]);
    const name = commands[0]?.[2]!;
    assert.match(name, /^test-sbx-/);
    assert.deepEqual(commands.slice(1, 3), [
      ["exec", name, "mkdir", "-p", "/home/agent/.claude"],
      ["cp", join(projectRoot, ".agents", "skills"), `${name}:/home/agent/.claude/`],
    ]);

    await handle.copyIn("/tmp/repo.bundle", "/tmp/repo.bundle");
    await handle.copyFileOut("/tmp/session.jsonl", "/tmp/session.jsonl");
    await handle.close();
    await handle.close();

    assert.deepEqual(commands.slice(3), [
      ["cp", "/tmp/repo.bundle", `${name}:/tmp/repo.bundle`],
      ["cp", `${name}:/tmp/session.jsonl`, "/tmp/session.jsonl"],
      ["rm", "--force", name],
    ]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("createDockerSbxHandle uses the Codex template without home-directory skill provisioning", async () => {
  commands.length = 0;
  const projectRoot = await makeProjectRoot();
  try {
    const handle = await createDockerSbxHandle(
      { command: fakeCommand, agent: "codex", namePrefix: "codex-sbx", projectRoot },
      {},
    );

    const name = commands[0]?.[2]!;
    assert.deepEqual(commands[0]?.slice(0, 13), [
      "create", "--name", name, "--cpus", "4", "--memory", "8g",
      "--kit", resolve(".sbx/kits/nuget-restore"),
      "--no-share-skills", "--template", "docker-sbx-codex:dev", "codex",
    ]);
    assert.equal(commands.length, 1);

    await handle.close();
    assert.deepEqual(commands[1], ["rm", "--force", name]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("createDockerSbxHandle preserves an explicit Codex template override", async () => {
  commands.length = 0;
  const handle = await createDockerSbxHandle(
    { command: fakeCommand, agent: "codex", template: "project-codex:dev" },
    {},
  );

  const name = commands[0]?.[2]!;
  assert.deepEqual(commands[0]?.slice(10, 13), ["--template", "project-codex:dev", "codex"]);
  await handle.close();
  assert.deepEqual(commands[1], ["rm", "--force", name]);
});

test("createDockerSbxHandle applies caller kits after the NuGet restore kit", async () => {
  commands.length = 0;
  const handle = await createDockerSbxHandle(
    { command: fakeCommand, kits: ["project-policy", "project-tools"] },
    {},
  );

  assert.deepEqual(commands[0]?.slice(7, 13), [
    "--kit", resolve(".sbx/kits/nuget-restore"),
    "--kit", "project-policy", "--kit", "project-tools",
  ]);
  await handle.close();
});

test("createDockerSbxHandle skips skill provisioning when the project has no skills", async () => {
  commands.length = 0;
  const projectRoot = await makeProjectRoot(false);
  try {
    const handle = await createDockerSbxHandle({ command: fakeCommand, projectRoot }, {});
    const name = commands[0]?.[2]!;
    assert.equal(commands.length, 1);
    await handle.close();
    assert.deepEqual(commands[1], ["rm", "--force", name]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("createDockerSbxHandle rejects linked files in project skills and removes the VM", async () => {
  commands.length = 0;
  const projectRoot = await makeProjectRoot();
  try {
    await symlink("/etc/passwd", join(projectRoot, ".agents", "skills", "host-file"));
    await assert.rejects(
      createDockerSbxHandle({ command: fakeCommand, projectRoot, namePrefix: "unsafe-sbx" }, {}),
      /unsupported entry/,
    );
    const name = commands[0]?.[2]!;
    assert.deepEqual(commands.at(-1), ["rm", "--force", name]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("createDockerSbxHandle rejects an invalid lifecycle timeout", async () => {
  await assert.rejects(
    createDockerSbxHandle({ command: fakeCommand, timeoutMs: 0 }, {}),
    /positive integer/,
  );
});

test("createDockerSbxHandle removes a partially allocated VM when creation fails", async () => {
  commands.length = 0;

  await assert.rejects(
    createDockerSbxHandle({ command: failingCreateCommand, namePrefix: "failed-sbx" }, {}),
    /create failed after allocation/,
  );

  const name = commands[0]?.[2]!;
  assert.match(name, /^failed-sbx-/);
  assert.deepEqual(commands[1], ["rm", "--force", name]);
});

test("withDockerSbxProvider closes a VM when Sandcastle setup fails after creation", async () => {
  commands.length = 0;

  await assert.rejects(
    withDockerSbxProvider({ command: fakeCommand, namePrefix: "sync-fail-sbx" }, async (provider) => {
      // create() is intentionally hidden from the public provider type, but is
      // called by Sandcastle after accepting the public provider object.
      const internal = provider as unknown as {
        create(options: { env: Record<string, string> }): Promise<unknown>;
      };
      await internal.create({ env: {} });
      throw new Error("simulated Git synchronization failure");
    }),
    /simulated Git synchronization failure/,
  );

  const name = commands[0]?.[2]!;
  assert.match(name, /^sync-fail-sbx-/);
  assert.deepEqual(commands.at(-1), ["rm", "--force", name]);
});
