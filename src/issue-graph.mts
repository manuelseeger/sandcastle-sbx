export type IssueReference = {
  id: string;
  number: number;
};

export type OpenIssue = IssueReference & {
  title: string;
  labels: string[];
  parent: IssueReference | null;
  blockedBy: IssueReference[];
};

export type IssueTree = {
  root: OpenIssue;
  issues: OpenIssue[];
  readyIssues: OpenIssue[];
};

export type IssueForest = {
  roots: IssueTree[];
  errors: string[];
};

export function buildIssueForest(issues: OpenIssue[]): IssueForest {
  const issuesById = new Map(issues.map((issue) => [issue.id, issue]));
  const dependencies = new Map(issues.map((issue) => [issue.id, new Set<string>()]));
  const dependents = new Map(issues.map((issue) => [issue.id, new Set<string>()]));

  const addDependency = (issueId: string, dependencyId: string) => {
    if (!issuesById.has(dependencyId)) return;
    dependencies.get(issueId)!.add(dependencyId);
    dependents.get(dependencyId)!.add(issueId);
  };

  for (const issue of issues) {
    if (issue.parent && issuesById.has(issue.parent.id)) addDependency(issue.parent.id, issue.id);
    for (const blocker of issue.blockedBy) addDependency(issue.id, blocker.id);
  }

  const adjacent = new Map(issues.map((issue) => [issue.id, new Set<string>()]));
  for (const [issueId, dependencyIds] of dependencies) {
    for (const dependencyId of dependencyIds) {
      adjacent.get(issueId)!.add(dependencyId);
      adjacent.get(dependencyId)!.add(issueId);
    }
  }

  const components: string[][] = [];
  const visited = new Set<string>();
  for (const issue of issues) {
    if (visited.has(issue.id)) continue;
    const component: string[] = [];
    const pending = [issue.id];
    visited.add(issue.id);
    while (pending.length) {
      const issueId = pending.pop()!;
      component.push(issueId);
      for (const adjacentId of adjacent.get(issueId)!) {
        if (visited.has(adjacentId)) continue;
        visited.add(adjacentId);
        pending.push(adjacentId);
      }
    }
    components.push(component);
  }

  const hasCycle = (component: string[]): boolean => {
    const complete = new Set<string>();
    const active = new Set<string>();
    const visit = (issueId: string): boolean => {
      if (active.has(issueId)) return true;
      if (complete.has(issueId)) return false;
      active.add(issueId);
      for (const dependencyId of dependencies.get(issueId)!) {
        if (visit(dependencyId)) return true;
      }
      active.delete(issueId);
      complete.add(issueId);
      return false;
    };
    return component.some(visit);
  };

  const roots: IssueTree[] = [];
  const errors: string[] = [];
  for (const component of components) {
    const componentIssues = component
      .map((issueId) => issuesById.get(issueId)!)
      .sort((left, right) => left.number - right.number);
    const issueList = componentIssues.map((issue) => `#${issue.number}`).join(", ");

    if (hasCycle(component)) {
      errors.push(`${issueList}: dependency cycle`);
      continue;
    }

    const rootIds = component.filter((issueId) => dependents.get(issueId)!.size === 0);
    if (rootIds.length !== 1) {
      errors.push(`${issueList}: component has ${rootIds.length} roots`);
      continue;
    }

    roots.push({
      root: issuesById.get(rootIds[0]!)!,
      issues: componentIssues,
      readyIssues: componentIssues.filter((issue) => dependencies.get(issue.id)!.size === 0),
    });
  }

  roots.sort((left, right) => left.root.number - right.root.number);
  return { roots, errors };
}
