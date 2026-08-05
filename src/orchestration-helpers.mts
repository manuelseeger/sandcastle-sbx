import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sandbox } from "@ai-hero/sandcastle";
import type { IssueReference, OpenIssue } from "./issue-graph.mts";

type OpenIssuesPage = {
  data: {
    repository: {
      issues: {
        nodes: Array<{
          id: string;
          number: number;
          title: string;
          labels: { nodes: Array<{ name: string }> };
          parent: IssueReference | null;
          blockedBy: { nodes: IssueReference[] };
        }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    };
  };
};

type PullRequest = {
  number: number;
  state: string;
  isDraft: boolean;
  mergedAt: string | null;
};

export type RootBranch = {
  issueNumber: number;
  branch: string;
  pullRequestNumber: number;
  isDraft: boolean;
};

type GithubCommitIdentity = {
  name: string;
  email: string;
};

const openIssuesQuery = `
  query OpenIssues($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      issues(first: 100, after: $after, states: OPEN, orderBy: { field: CREATED_AT, direction: ASC }) {
        nodes {
          id
          number
          title
          labels(first: 100) { nodes { name } }
          parent { id number }
          blockedBy(first: 100) { nodes { id number } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

function command(commandName: string, args: string[], allowFailure = false): string {
  try {
    return execFileSync(commandName, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (allowFailure) return "";
    const details = error as { stderr?: Buffer; message: string };
    throw new Error(`${commandName} ${args.join(" ")} failed: ${details.stderr?.toString().trim() || details.message}`);
  }
}

function git(args: string[], allowFailure = false): string {
  return command("git", args, allowFailure);
}

function gh(args: string[], allowFailure = false): string {
  return command("gh", args, allowFailure);
}

function refExists(ref: string): boolean {
  return Boolean(git(["show-ref", "--verify", ref], true));
}

function getGithubCommitIdentity(): GithubCommitIdentity {
  const user = JSON.parse(gh(["api", "user"])) as { id?: unknown; login?: unknown; name?: unknown };
  if (!Number.isSafeInteger(user.id) || typeof user.login !== "string" || !user.login) {
    throw new Error("could not resolve GitHub commit identity");
  }

  return {
    name: typeof user.name === "string" && user.name ? user.name : user.login,
    email: `${user.id}+${user.login}@users.noreply.github.com`,
  };
}

function initializeBranch(branch: string, issueNumber: number): void {
  const identity = getGithubCommitIdentity();
  const worktree = mkdtempSync(join(tmpdir(), `sandcastle-root-${issueNumber}-`));
  try {
    git(["worktree", "add", "--force", worktree, branch]);
    git([
      "-C", worktree,
      "-c", `user.name=${identity.name}`,
      "-c", `user.email=${identity.email}`,
      "commit", "--allow-empty", "-m", `chore: initialize Sandcastle work for #${issueNumber}`,
    ]);
  } finally {
    git(["worktree", "remove", "--force", worktree], true);
    rmSync(worktree, { recursive: true, force: true });
  }
}

export function getGithubRepository(): string {
  const repository = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error("could not resolve GitHub repository");
  return repository;
}

export function getOpenIssues(githubRepository: string): OpenIssue[] {
  const [owner, name] = githubRepository.split("/");
  const issues: OpenIssue[] = [];
  let after: string | undefined;

  do {
    const args = ["api", "graphql", "-f", `query=${openIssuesQuery}`, "-F", `owner=${owner}`, "-F", `name=${name}`];
    if (after) args.push("-F", `after=${after}`);
    const page = JSON.parse(gh(args)) as OpenIssuesPage;
    const result = page.data.repository.issues;
    issues.push(...result.nodes.map((issue) => ({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      labels: issue.labels.nodes.map((label) => label.name),
      parent: issue.parent,
      blockedBy: issue.blockedBy.nodes,
    })));
    after = result.pageInfo.hasNextPage ? result.pageInfo.endCursor ?? undefined : undefined;
  } while (after);

  return issues;
}

export function createSbxOptions(
  githubRepository: string,
  projectRoot: string,
  scope: string,
  agent = "claude",
) {
  const identity = getGithubCommitIdentity();
  return {
    agent,
    template: agent === "codex" ? "docker-sbx-codex:dev" : "docker-sbx:dev",
    namePrefix: `mes-bio-${scope}`,
    projectRoot,
    env: {
      GH_REPO: githubRepository,
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    },
  };
}

export function ensureRootBranch(issueNumber: number, title: string): RootBranch {
  const branch = `sandcastle/issue-${issueNumber}`;
  const baseBranch = gh(["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]);
  git(["fetch", "origin", baseBranch]);
  git(["fetch", "origin", branch], true);

  if (!refExists(`refs/heads/${branch}`)) {
    if (refExists(`refs/remotes/origin/${branch}`)) git(["branch", "--track", branch, `origin/${branch}`]);
    else git(["branch", "--no-track", branch, `origin/${baseBranch}`]);
  }

  const existing = JSON.parse(gh([
    "pr", "list", "--head", branch, "--state", "all", "--limit", "1",
    "--json", "number,state,isDraft,mergedAt",
  ])) as PullRequest[];
  let pullRequest = existing[0];
  if (pullRequest?.mergedAt || pullRequest?.state === "CLOSED") {
    throw new Error(`root branch ${branch} belongs to closed PR #${pullRequest.number}`);
  }

  if (!pullRequest && git(["rev-parse", branch]) === git(["rev-parse", `origin/${baseBranch}`])) {
    initializeBranch(branch, issueNumber);
  }

  git(["push", "--set-upstream", "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
  if (!pullRequest) {
    gh([
      "pr", "create", "--draft", "--base", baseBranch, "--head", branch,
      "--title", `#${issueNumber}: ${title}`, "--body", `Sandcastle is implementing this issue.\n\nCloses #${issueNumber}`,
    ]);
    pullRequest = (JSON.parse(gh([
      "pr", "list", "--head", branch, "--state", "open", "--limit", "1",
      "--json", "number,state,isDraft,mergedAt",
    ])) as PullRequest[])[0];
  }
  if (!pullRequest) throw new Error(`could not create draft PR for #${issueNumber}`);

  return {
    issueNumber,
    branch,
    pullRequestNumber: pullRequest.number,
    isDraft: pullRequest.isDraft,
  };
}

export function ensureWorkBranch(issueNumber: number, rootBranch: string): string {
  const branch = `sandcastle/work/issue-${issueNumber}`;
  if (!refExists(`refs/heads/${branch}`)) git(["branch", "--no-track", branch, rootBranch]);
  return branch;
}

export function pickerBranch(rootIssueNumber: number): string {
  return `sandcastle/picker/issue-${rootIssueNumber}`;
}

export function deleteLocalBranch(branch: string): void {
  git(["branch", "--delete", "--force", branch], true);
}

export function issueIdArguments(issues: OpenIssue[]): string {
  return issues.map((issue) => {
    if (!/^[A-Za-z0-9_]+$/.test(issue.id)) throw new Error(`invalid GitHub issue id: ${issue.id}`);
    return `-F ids[]=${issue.id}`;
  }).join(" ");
}

export function selectedIssueNumber(stdout: string, offeredIssues: OpenIssue[]): number {
  const selections = [...stdout.matchAll(/<issue>(\d+)<\/issue>/g)].map((match) => Number(match[1]));
  if (selections.length !== 1) throw new Error("picker must emit exactly one <issue>NUMBER</issue> marker");
  const selection = selections[0]!;
  if (!offeredIssues.some((issue) => issue.number === selection)) {
    throw new Error(`picker selected issue #${selection}, which was not offered`);
  }
  return selection;
}

export function branchCommit(branch: string): string {
  const commit = git(["rev-parse", "--verify", `${branch}^{commit}`]);
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error(`invalid commit for ${branch}`);
  return commit;
}

export async function prepareSandboxRef(sandbox: Sandbox, ref: string, commit: string): Promise<void> {
  if (!/^refs\/sandcastle\/[a-z-]+$/.test(ref) || !/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error("invalid sandbox ref or commit");
  }
  const result = await sandbox.exec(`git update-ref ${ref} ${commit}`);
  if (result.exitCode !== 0) throw new Error(`could not prepare ${ref}: ${result.stderr.trim() || result.stdout.trim()}`);
}

export async function reviewerMerged(sandbox: Sandbox, rootBranch: string, implementationRef: string): Promise<boolean> {
  const status = await sandbox.exec("git status --porcelain");
  const branch = await sandbox.exec("git branch --show-current");
  const ancestry = await sandbox.exec(`git merge-base --is-ancestor ${implementationRef} HEAD`);
  const sandboxTree = await sandbox.exec("git rev-parse HEAD^{tree}");
  const hostTree = git(["rev-parse", `${rootBranch}^{tree}`], true);

  return status.exitCode === 0 && !status.stdout.trim()
    && branch.exitCode === 0 && branch.stdout.trim() === rootBranch
    && ancestry.exitCode === 0
    && sandboxTree.exitCode === 0
    && sandboxTree.stdout.trim() === hostTree;
}

export function resetBranch(branch: string, commit: string): void {
  git(["update-ref", `refs/heads/${branch}`, commit]);
}

export function pushBranch(branch: string): void {
  git(["push", "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
}

export function closeIssue(issueNumber: number, pullRequestNumber: number): void {
  gh(["issue", "close", String(issueNumber), "--comment", `Completed by Sandcastle in root PR #${pullRequestNumber}.`]);
}

export function readyPullRequest(pullRequestNumber: number): void {
  const isDraft = gh(["pr", "view", String(pullRequestNumber), "--json", "isDraft", "--jq", ".isDraft"]);
  if (isDraft === "true") gh(["pr", "ready", String(pullRequestNumber)]);
}
