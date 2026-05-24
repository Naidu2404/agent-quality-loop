import type { Issue, ReviewResult, Severity } from "../types.js";

export interface ExplainBlockersInput {
  /** The review result from reviewChangedFiles or reviewWorkspacePolicy */
  reviewResult: ReviewResult;
  /**
   * Severities to explain. Defaults to ["error"] (blockers only).
   * Pass ["error","warning"] to also explain advisories.
   */
  severities?: Severity[];
}

export interface BlockerExplanation {
  /** Stable ID for this blocker group */
  id: string;
  /** How many issues this group covers */
  count: number;
  /** Example file + line */
  example: string;
  /** Plain-English explanation of the problem */
  explanation: string;
  /** Concrete fix guidance */
  fix: string;
  /** All issues in this group */
  issues: Issue[];
}

export interface ExplainBlockersResult {
  /** Total blocker groups */
  totalGroups: number;
  /** Total individual issues explained */
  totalIssues: number;
  /** Whether all blockers are addressed */
  isClean: boolean;
  blockers: BlockerExplanation[];
  /** Concise action list the agent should execute */
  actionPlan: string[];
  /** Full summary text */
  summary: string;
}

/**
 * Takes a ReviewResult and produces an agent-friendly explanation of all blocking issues,
 * grouped by ruleId, with clear action steps.
 */
export function explainBlockers(input: ExplainBlockersInput): ExplainBlockersResult {
  const { reviewResult } = input;
  const targetSeverities: Severity[] = input.severities ?? ["error"];

  const blockingIssues = reviewResult.issues.filter((i) =>
    targetSeverities.includes(i.severity)
  );

  if (blockingIssues.length === 0) {
    return {
      totalGroups: 0,
      totalIssues: 0,
      isClean: true,
      blockers: [],
      actionPlan: ["No blocking issues found. Code is ready for the next step."],
      summary: "✅ No blockers to explain. The review passed.",
    };
  }

  // Group by ruleId
  const grouped = new Map<string, Issue[]>();
  for (const issue of blockingIssues) {
    if (!grouped.has(issue.ruleId)) grouped.set(issue.ruleId, []);
    grouped.get(issue.ruleId)!.push(issue);
  }

  const blockers: BlockerExplanation[] = [];
  const actionPlan: string[] = [];

  for (const [ruleId, issues] of grouped.entries()) {
    const first = issues[0];
    const explanation = getExplanation(ruleId, first);
    const fix = first.fixHint ?? getDefaultFix(ruleId, first);
    const example = `${first.path}:${first.line}`;

    blockers.push({
      id: ruleId,
      count: issues.length,
      example,
      explanation,
      fix,
      issues,
    });

    const locs = issues
      .slice(0, 3)
      .map((i) => `${i.path}:${i.line}`)
      .join(", ");
    const more = issues.length > 3 ? ` (+${issues.length - 3} more)` : "";
    actionPlan.push(`Fix \`${ruleId}\` (${issues.length}x): ${locs}${more} — ${fix}`);
  }

  const summary = buildExplanationSummary(blockers, actionPlan, reviewResult);

  return {
    totalGroups: blockers.length,
    totalIssues: blockingIssues.length,
    isClean: false,
    blockers,
    actionPlan,
    summary,
  };
}

function getExplanation(ruleId: string, issue: Issue): string {
  const explanations: Record<string, string> = {
    // TypeScript
    TS2322: "A value is being assigned to an incompatible type. TypeScript's type system detected a mismatch between what the variable expects and what it's receiving.",
    TS2345: "A function is being called with an argument whose type doesn't match the parameter's declared type.",
    TS2339: "You're trying to access a property that doesn't exist on the type. This often means a typo or a missing interface definition.",
    TS2304: "A name (variable, type, or function) is being used but TypeScript cannot find its declaration or import.",
    TS2307: "An import cannot be resolved. The module path is wrong or the package is not installed.",
    TS7006: "A function parameter has no explicit type annotation, so TypeScript infers 'any', which defeats type safety.",
    // Security
    "no-hardcoded-secrets": "A string that looks like a secret, password, or API key is hardcoded in source code. This is a critical security risk — secrets in code get committed to git history.",
    // ESLint common
    "no-unused-vars": "A variable is declared but never used. This is dead code that increases cognitive load and can hide bugs.",
    "no-undef": "A variable is used without being declared or imported. This will cause a ReferenceError at runtime.",
    "no-console": "A console statement was found. Debug logging should not be committed.",
  };

  return (
    explanations[ruleId] ??
    `Rule \`${ruleId}\` was violated: ${issue.message}`
  );
}

function getDefaultFix(ruleId: string, issue: Issue): string {
  const fixes: Record<string, string> = {
    TS2322: "Check the type annotation and either fix the value being assigned or widen the type.",
    TS2345: "Ensure the argument matches the parameter type. Add a type cast only if you're certain it's safe.",
    TS2339: "Add the property to the interface/type definition, or check for a typo in the property name.",
    TS2304: "Import the missing name from the correct module, or declare it if it should be local.",
    TS2307: "Check the module path. Run `npm install` if the package is missing.",
    TS7006: `Add a type annotation, e.g. \`${issue.message.match(/Parameter '(.+?)'/)?.[1] ?? "param"}: YourType\``,
    "no-hardcoded-secrets": "Move the value to an environment variable and reference it via process.env.SECRET_NAME.",
    "no-unused-vars": "Remove the unused variable, or prefix it with _ if it's an intentional placeholder.",
    "prettier/prettier": `Run: npx prettier --write "${issue.path}"`,
  };

  return fixes[ruleId] ?? "Review the rule documentation and update the code accordingly.";
}

function buildExplanationSummary(
  blockers: BlockerExplanation[],
  actionPlan: string[],
  reviewResult: ReviewResult
): string {
  const lines: string[] = [];
  lines.push("## Blocker Explanation");
  lines.push(
    `**${reviewResult.blockingCount} blocking issue(s)** across ${blockers.length} rule(s) must be resolved.`
  );
  lines.push("");

  for (const blocker of blockers) {
    lines.push(`### \`${blocker.id}\` — ${blocker.count} occurrence(s)`);
    lines.push(`**What:** ${blocker.explanation}`);
    lines.push(`**Fix:** ${blocker.fix}`);
    lines.push(`**Example:** \`${blocker.example}\``);
    if (blocker.issues.length > 1) {
      const allLocs = blocker.issues.map((i) => `\`${i.path}:${i.line}\``).join(", ");
      lines.push(`**All locations:** ${allLocs}`);
    }
    lines.push("");
  }

  lines.push("### Action plan for the agent");
  actionPlan.forEach((step, i) => {
    lines.push(`${i + 1}. ${step}`);
  });

  lines.push("");
  lines.push(
    "_After applying fixes, call `review_changed_files` again to confirm the issues are resolved._"
  );

  return lines.join("\n");
}
