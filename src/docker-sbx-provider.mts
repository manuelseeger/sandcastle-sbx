import {
  createIsolatedSandboxProvider,
  type IsolatedSandboxHandle,
  type IsolatedSandboxProvider,
} from "@ai-hero/sandcastle";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TEMPLATE = "docker-sbx:dev";
const DEFAULT_HOME_PATH = "/home/agent";
const DEFAULT_WORKTREE_PATH = `${DEFAULT_HOME_PATH}/workspace`;
const MAX_OUTPUT_CHARS = 64 * 1024;

type ExecOptions = {
  onLine?: (line: string) => void;
  cwd?: string;
  sudo?: boolean;
  stdin?: string;
};

type ExecResult = { stdout: string; stderr: string; exitCode: number };

/** Minimal command seam: keeps provider tests independent of a local sbx installation. */
export type SbxCommand = {
  run(args: readonly string[], timeoutMs?: number): Promise<void>;
};

export type DockerSbxOptions = {
  /** An sbx template with the selected agent toolchain baked in. */
  template?: string;
  /** sbx agent metadata must match the template's base agent. */
  agent?: string;
  /** Prefix for discoverable, project-owned VM names. */
  namePrefix?: string;
  /** Repository root whose approved `.claude/skills` tree is copied into each guest. */
  projectRoot?: string;
  cpus?: number;
  memory?: string;
  /** Bound create, copy, and removal calls so a broken backend cannot hang a run. */
  timeoutMs?: number;
  env?: Record<string, string>;
  command?: SbxCommand;
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const boundedAppend = (current: string, chunk: string): string => {
  const combined = current + chunk;
  return combined.length <= MAX_OUTPUT_CHARS ? combined : combined.slice(-MAX_OUTPUT_CHARS);
};

const defaultCommand: SbxCommand = {
  async run(args, timeoutMs) {
    await execFileAsync("sbx", [...args], { maxBuffer: MAX_OUTPUT_CHARS, timeout: timeoutMs });
  },
};

const sandboxName = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;

/** Reject links and non-regular files so copying skills cannot escape the approved tree. */
async function validateSkillsTree(path: string): Promise<boolean> {
  let root;
  try {
    root = await lstat(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error(`approved skills path must be a real directory: ${path}`);
  }

  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new Error(`approved skills path contains unsupported entry: ${child}`);
    }
    if (entry.isDirectory()) await validateSkillsTree(child);
  }
  return true;
}

async function provisionProjectSkills(
  command: SbxCommand,
  name: string,
  timeoutMs: number,
  projectRoot: string | undefined,
): Promise<void> {
  const skillsPath = resolve(projectRoot ?? process.cwd(), ".claude", "skills");
  if (!await validateSkillsTree(skillsPath)) return;

  // This is a one-way snapshot, not a host mount or Docker Sandboxes' writable
  // shared skill store. Claude discovers skills in this standard guest path.
  await command.run(["exec", name, "mkdir", "-p", `${DEFAULT_HOME_PATH}/.claude`], timeoutMs);
  await command.run(["cp", skillsPath, `${name}:${DEFAULT_HOME_PATH}/.claude/`], timeoutMs);
}

/**
 * Create a public Sandcastle isolated-provider handle around Docker Sandboxes.
 *
 * sbx needs a host workspace when creating a VM. This provider gives it a fresh,
 * empty directory only; Sandcastle then transfers its Git bundle with `sbx cp`.
 * No project worktree, Docker socket, or agent state is mounted from the host.
 * The repository's explicitly approved `.claude/skills` tree is copied as a
 * one-way snapshot into each guest; it is never shared between castles.
 */
export async function createDockerSbxHandle(
  options: DockerSbxOptions,
  env: Record<string, string>,
): Promise<IsolatedSandboxHandle> {
  const command = options.command ?? defaultCommand;
  const template = options.template ?? DEFAULT_TEMPLATE;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("sbx timeout must be a positive integer");
  const name = sandboxName(options.namePrefix ?? "docker-sbx");
  const emptyWorkspace = await mkdtemp(join(tmpdir(), "sandcastle-sbx-"));
  let closed = false;

  try {
    await command.run([
      "create",
      "--name", name,
      "--cpus", String(options.cpus ?? 4),
      "--memory", options.memory ?? "8g",
      "--no-share-skills",
      "--template", template,
      options.agent ?? "claude",
      emptyWorkspace,
    ], timeoutMs);
    await provisionProjectSkills(command, name, timeoutMs, options.projectRoot);
  } catch (error) {
    // `sbx create` can fail after allocating the named VM. Best-effort removal
    // makes provider setup failure deterministic as well as normal close.
    await command.run(["rm", "--force", name], timeoutMs).catch(() => undefined);
    await rm(emptyWorkspace, { recursive: true, force: true });
    throw error;
  }

  const runSbx = async (args: readonly string[]): Promise<void> => command.run(args, timeoutMs);
  const environmentArgs = Object.entries({ ...env, ...options.env })
    .flatMap(([key, value]) => ["-e", `${key}=${value}`]);

  return {
    worktreePath: DEFAULT_WORKTREE_PATH,

    async exec(commandText: string, execOptions?: ExecOptions): Promise<ExecResult> {
      // Sandcastle executes sync bootstrap commands before worktreePath exists.
      // Explicit agent commands still receive worktreePath as their cwd.
      const cwd = execOptions?.cwd ?? DEFAULT_HOME_PATH;
      const effectiveCommand = execOptions?.sudo ? `sudo ${commandText}` : commandText;
      // Do not use execFile here: its maxBuffer applies to the complete child
      // stdout even when we stream and bound our own retained output. Claude's
      // stream-json protocol can exceed 64 KiB after a large Read result;
      // execFile then terminates the agent mid-run. spawn has no such buffer.
      const child = spawn(
        "sbx",
        ["exec", ...environmentArgs, name, "sh", "-lc", `cd ${shellQuote(cwd)} && ${effectiveCommand}`],
      );
      const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);

      let stdout = "";
      let stderr = "";
      let pendingStdout = "";
      let pendingStderr = "";
      const streamLines = (chunk: Buffer, pending: "stdout" | "stderr") => {
        const text = (pending === "stdout" ? pendingStdout : pendingStderr) + chunk.toString();
        const lines = text.split(/\r?\n/);
        const remainder = lines.pop() ?? "";
        if (pending === "stdout") pendingStdout = remainder;
        else pendingStderr = remainder;
        for (const line of lines) execOptions?.onLine?.(line);
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = boundedAppend(stdout, chunk.toString());
        streamLines(chunk, "stdout");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = boundedAppend(stderr, chunk.toString());
        streamLines(chunk, "stderr");
      });
      if (execOptions?.stdin !== undefined) child.stdin?.end(execOptions.stdin);

      return await new Promise((resolve, reject) => {
        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once("close", (exitCode) => {
          clearTimeout(timeout);
          if (pendingStdout) execOptions?.onLine?.(pendingStdout);
          if (pendingStderr) execOptions?.onLine?.(pendingStderr);
          resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
        });
      });
    },

    async copyIn(hostPath: string, sandboxPath: string): Promise<void> {
      await runSbx(["cp", hostPath, `${name}:${sandboxPath}`]);
    },

    async copyFileOut(sandboxPath: string, hostPath: string): Promise<void> {
      await runSbx(["cp", `${name}:${sandboxPath}`, hostPath]);
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        await runSbx(["rm", "--force", name]);
      } finally {
        await rm(emptyWorkspace, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Scope a provider to one complete Sandcastle operation.
 *
 * Sandcastle 0.12 does not call handle.close() when its isolated Git sync fails
 * after provider creation. Keeping the created handles here gives integration
 * code a public-API-only finally boundary for setup failures as well as normal
 * agent/reviewer completion. A separate provider scope per castle prevents one
 * concurrent issue from cleaning up another issue's VM.
 */
export async function withDockerSbxProvider<T>(
  options: DockerSbxOptions,
  operation: (provider: IsolatedSandboxProvider) => Promise<T>,
): Promise<T> {
  const handles = new Set<IsolatedSandboxHandle>();
  const provider = createIsolatedSandboxProvider({
    name: "docker-sbx",
    env: options.env,
    create: async ({ env }) => {
      const handle = await createDockerSbxHandle(options, env);
      handles.add(handle);
      return handle;
    },
  });

  try {
    return await operation(provider);
  } finally {
    await Promise.allSettled([...handles].map((handle) => handle.close()));
  }
}
