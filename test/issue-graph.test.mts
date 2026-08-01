import assert from "node:assert/strict";
import test from "node:test";
import { buildIssueForest, type OpenIssue } from "../src/issue-graph.mts";

const issue = (number: number, options: Partial<OpenIssue> = {}): OpenIssue => ({
  id: `issue-${number}`,
  number,
  title: `Issue ${number}`,
  labels: [],
  parent: null,
  blockedBy: [],
  ...options,
});

test("buildIssueForest returns ready leaves under each root", () => {
  const root = issue(1);
  const child = issue(2, { parent: root });
  const blocker = issue(3);
  root.blockedBy = [blocker];

  const forest = buildIssueForest([root, child, blocker]);

  assert.deepEqual(forest.errors, []);
  assert.equal(forest.roots.length, 1);
  assert.equal(forest.roots[0]?.root.number, 1);
  assert.deepEqual(forest.roots[0]?.readyIssues.map(({ number }) => number), [2, 3]);
});

test("buildIssueForest skips a component with a shared dependency", () => {
  const blocker = issue(3);
  const forest = buildIssueForest([
    issue(1, { blockedBy: [blocker] }),
    issue(2, { blockedBy: [blocker] }),
    blocker,
  ]);

  assert.deepEqual(forest.roots, []);
  assert.match(forest.errors[0] ?? "", /shared dependency #3/);
});

test("buildIssueForest skips a dependency cycle", () => {
  const first = issue(1);
  const second = issue(2);
  first.blockedBy = [second];
  second.blockedBy = [first];

  const forest = buildIssueForest([first, second]);

  assert.deepEqual(forest.roots, []);
  assert.match(forest.errors[0] ?? "", /dependency cycle/);
});
