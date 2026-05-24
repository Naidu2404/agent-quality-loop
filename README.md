# agent-quality-loop

An MCP server that guides AI agents (Cursor, Claude, etc.) to produce clean, policy-compliant code.

After an agent writes or edits code, it calls this MCP to get structured feedback — ESLint violations, TypeScript errors, Prettier issues, and repo-specific custom rules — all normalized into a stable JSON shape the agent can act on immediately.

---

## How it works

```
Agent writes code
      ↓
review_changed_files (MCP tool)
      ↓
Runs: ESLint + TypeScript + Prettier + Custom rules
      ↓
Returns: structured issues (path, line, severity, ruleId, message, fixHint)
      ↓
passesPolicy=false? → explain_blockers → agent fixes
      ↓
re-run review_changed_files
      ↓
passesPolicy=true → human manual check → git push
```

---

## Installation

### Global (recommended — works in any project)

```bash
npm install -g agent-quality-loop
```

### Or use without installing (npx)

No install needed — just reference it in your MCP config and `npx` handles the rest.

---

## Add to your MCP config

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "quality-loop": {
      "command": "npx",
      "args": ["-y", "agent-quality-loop"]
    }
  }
}
```

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "quality-loop": {
      "command": "npx",
      "args": ["-y", "agent-quality-loop"]
    }
  }
}
```

If you installed globally:

```json
{
  "mcpServers": {
    "quality-loop": {
      "command": "agent-quality-loop"
    }
  }
}
```

---

## Tools exposed

### `review_changed_files`

Review a specific set of files — or auto-detect git-changed files — against all enabled checks.

**Input:**
```json
{
  "files": ["src/components/MyComponent.vue", "src/utils/format.ts"],
  "cwd": "/absolute/path/to/your/repo"
}
```

- `files` — optional. If omitted, auto-detects staged + unstaged + untracked git changes.
- `cwd` — optional. Defaults to the agent's working directory.

**Output (ReviewResult):**
```json
{
  "totalIssues": 3,
  "blockingCount": 1,
  "advisoryCount": 2,
  "passesPolicy": false,
  "checksRun": ["eslint", "typescript", "customRules"],
  "checksSkipped": [{ "check": "prettier", "reason": "Prettier binary not found" }],
  "issues": [
    {
      "path": "src/utils/format.ts",
      "line": 12,
      "column": 5,
      "severity": "error",
      "category": "types",
      "ruleId": "TS2322",
      "message": "Type 'string' is not assignable to type 'number'.",
      "fixHint": "Check the type annotation and either fix the value being assigned or widen the type."
    }
  ],
  "summary": "## Quality Loop Review\n..."
}
```

---

### `review_workspace_policy`

Scan the entire workspace (all source files) against the quality policy.

**Input:**
```json
{
  "cwd": "/absolute/path/to/your/repo",
  "include": ["src/**/*.ts", "lib/**/*.ts"],
  "exclude": ["**/*.test.ts"]
}
```

Returns the same `ReviewResult` shape as `review_changed_files`.

---

### `explain_blockers`

Takes a `ReviewResult` and returns a structured, agent-actionable explanation of all blocking issues — grouped by rule, with concrete fix instructions and an ordered action plan.

**Input:**
```json
{
  "reviewResult": { ... },
  "severities": ["error"]
}
```

**Output:**
```json
{
  "totalGroups": 2,
  "totalIssues": 4,
  "isClean": false,
  "blockers": [
    {
      "id": "TS2322",
      "count": 2,
      "example": "src/utils/format.ts:12",
      "explanation": "A value is being assigned to an incompatible type...",
      "fix": "Check the type annotation and either fix the value or widen the type.",
      "issues": [...]
    }
  ],
  "actionPlan": [
    "Fix `TS2322` (2x): src/utils/format.ts:12, src/api/client.ts:44 — Check the type annotation..."
  ],
  "summary": "## Blocker Explanation\n..."
}
```

---

## Repo-specific configuration

Drop a `.quality-loop.json` in your repo root to customize checks and add project-specific rules:

```json
{
  "checks": {
    "eslint":      { "enabled": true },
    "typescript":  { "enabled": true },
    "prettier":    { "enabled": false }
  },
  "blockingseverities": ["error"],
  "maxIterations": 3,
  "notes": "All exported functions must have JSDoc. No inline styles in Vue components.",
  "customRules": [
    {
      "id": "no-any-type",
      "description": "Avoid TypeScript any",
      "severity": "warning",
      "pattern": ":\\s*any[;,\\s\\)]",
      "message": "Avoid using 'any' — use a specific type or 'unknown'.",
      "fixHint": "Replace with a specific type.",
      "glob": "**/*.{ts,tsx,vue}"
    }
  ]
}
```

### Config fields

| Field | Type | Default | Description |
|---|---|---|---|
| `checks.eslint.enabled` | boolean | auto-detected | Enable/disable ESLint |
| `checks.typescript.enabled` | boolean | auto-detected | Enable/disable TypeScript type-check |
| `checks.prettier.enabled` | boolean | auto-detected | Enable/disable Prettier format check |
| `blockingseverities` | string[] | `["error"]` | Severities that must be zero for `passesPolicy=true` |
| `maxIterations` | number | `3` | Max fix iterations recommended to the agent |
| `notes` | string | — | Free-text repo notes passed to the agent as context |
| `customRules` | CustomRule[] | stack defaults | Project-specific pattern rules |

### Custom rule fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✅ | Stable rule ID |
| `description` | string | ✅ | What this rule enforces |
| `severity` | `error\|warning\|info` | ✅ | Severity level |
| `pattern` | string | — | Regex to match in file content |
| `glob` | string | — | File glob this rule applies to |
| `message` | string | ✅ | Message shown when rule fires |
| `fixHint` | string | — | One-line fix guidance for the agent |

---

## Tech stack auto-detection

If no `.quality-loop.json` exists, the server auto-detects your stack and enables sensible defaults:

| Stack | Detection signal | Default rules |
|---|---|---|
| Vue / Nuxt | `vue` in deps | v-html warning, script setup hint |
| React / Next.js | `react` in deps | index-key warning, next/image hint |
| Angular | `@angular/core` in deps | Universal rules |
| Java | `pom.xml` / `build.gradle` | System.out warning, printStackTrace warning |
| Python | `requirements.txt` / `pyproject.toml` | bare-except warning, print() info |
| Go | `go.mod` | ignored-error warning |
| Node / Generic | `package.json` | Universal rules only |

All stacks get the universal rules: no debug console statements, no hardcoded secrets (blocking), and TODO/FIXME tracking hints.

---

## Recommended agent workflow (Cursor / Claude Code)

Add these instructions to your agent's system prompt or `CLAUDE.md`:

```
After writing or editing any code:
1. Call review_changed_files with the files you just touched (or omit files to auto-detect)
2. If passesPolicy is false, call explain_blockers with the reviewResult
3. Apply all fixes from the actionPlan
4. Repeat until passesPolicy is true (max 3 iterations)
5. Only then consider the task complete — the human will do a final diff review before pushing
```

---

## Publishing to npm

```bash
npm run build
npm publish --access public
```

---

## License

MIT
