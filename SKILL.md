---
name: dom-heal
description: DOM health maintenance for OpenCLI browser adapters. Use this skill when the user types /dom-heal or asks to check/diagnose/audit adapter selector health. Provides simple subcommands for proactive health checks, broken selector repair, baseline snapshots, change tracking, and new adapter onboarding. Covers doubao, deepseek, chatgpt, claude, xiaohongshu, and boss adapters.
allowed-tools: Bash(node:*), Bash(opencli:*), Bash(npx:*), Read, Edit, Write
---

# DOM Heal — Selector Health & Self-Repair

The user interacts via slash commands. Each maps to a `cli.mjs` subcommand that handles the full pipeline automatically — browser session, URL, flags, and output formatting.

## Self-contained structure

This skill is a complete, self-contained package. Everything needed is inside the skill directory:

```
opencli-dom-heal/
  SKILL.md              # This file
  cli.mjs               # Entry point (all 8 subcommands)
  vitest.config.js      # Test runner config
  lib/                  # Engine modules (analyze, heal, compare, scorer, etc.)
  baselines/            # Pre-built selector baselines for 6 sites
  tests/                # Full test suite (187 tests)
```

The CLI automatically finds baselines at `./baselines/`. To use custom baselines, set:

```bash
export DOM_HEAL_BASELINES=/path/to/custom/baselines
```

## Subcommand reference

| Slash command | What it does |
|---|---|
| `/dom-heal check <site>` | Opens browser, runs health check vs baseline |
| `/dom-heal diagnose <site> [--role]` | analyze → compare → heal pipeline, outputs ranked replacement candidates |
| `/dom-heal save <site>` | Snapshot + update baseline selector status + update registry |
| `/dom-heal changes <site>` | Diff current page vs last saved snapshot |
| `/dom-heal audit` | Batch health report across all registry sites |
| `/dom-heal show <site>` | Display baseline roles, all selectors with status, active hints |
| `/dom-heal onboard <site>` | Extract selectors from adapter source, guide baseline creation |
| `/dom-heal test [--watch]` | Run the dom-heal test suite |

The CLI entry point: `node cli.mjs <subcommand> <site> [options]`

## How to handle each subcommand

### `/dom-heal check <site>`

Run exactly:
```bash
node cli.mjs check <site>
```

The CLI auto-opens the browser to the right URL (from registry `default_url`), runs `analyze.mjs --compare`, and prints a health report.

If it fails:
- `opencli doctor` not green → tell the user to start Chrome with the extension
- "Could not open browser session" → tell the user to run `opencli doctor`
- All roles BROKEN → browser is on the wrong page (e.g. login wall); tell the user to log in manually

### `/dom-heal diagnose <site> [--role <name>]`

Run exactly:
```bash
node cli.mjs diagnose <site> --role <role>   # if role specified
node cli.mjs diagnose <site>                  # all broken roles
```

This is a 3-step pipeline:
1. Save DOM analysis to `/tmp/dom-heal-<site>-snapshot.json`
2. Compare against baseline
3. Run `heal.mjs` to score replacement candidates

Report the top candidate with its score breakdown to the user. If the user confirms, apply the fix to the adapter source.

### `/dom-heal save <site>`

Run exactly:
```bash
node cli.mjs save <site>
```

After a successful adapter repair, persist the new state. The CLI runs `--compare --save --update` and shows the updated registry entry.

### `/dom-heal changes <site>`

Run exactly:
```bash
node cli.mjs changes <site>
```

Shows appeared/disappeared/count-changed selectors since the last saved snapshot.

### `/dom-heal audit`

Run exactly:
```bash
node cli.mjs audit
```

No browser needed — reads selector status from baselines and registry. Produces a table of all sites with health status. Highlight any CRITICAL or DEGRADED sites.

### `/dom-heal show <site>`

Run exactly:
```bash
node cli.mjs show <site>
```

Displays the full baseline: every role with every selector (priority, stability, status), plus active analysis hints. Use this before editing a baseline to understand the current state.

### `/dom-heal onboard <site>`

Run exactly:
```bash
node cli.mjs onboard <site>
```

Extracts all CSS selectors from the adapter source files. Then guide the user (or do it yourself):
1. Categorize selectors into functional roles
2. Create `baselines/<site>/selector-roles.json` with v2 schema
3. Add `analysis_hints` block
4. Run `validateV2()` to check the baseline
5. Add the site to `baselines/registry.json`
6. Run `/dom-heal show <site>` to verify

Use `node cli.mjs show doubao` for a reference of how a complete baseline looks.

### `/dom-heal test [--watch]`

Run exactly:
```bash
node cli.mjs test          # single run
node cli.mjs test --watch  # watch mode
```

Runs `npx vitest run` from the skill directory. Report failures clearly.

## Sites in registry

| Site | URL | Type |
|------|-----|------|
| doubao | https://www.doubao.com/chat | Chat AI |
| deepseek | https://chat.deepseek.com | Chat AI |
| chatgpt | https://chatgpt.com | Chat AI |
| claude | https://claude.ai/new | Chat AI |
| xiaohongshu | https://www.xiaohongshu.com/explore | Social media |
| boss | https://www.zhipin.com/web/chat/index | Recruitment |

## Custom baselines

To use your own baselines instead of the bundled ones, set the `DOM_HEAL_BASELINES` environment variable:

```bash
export DOM_HEAL_BASELINES=/path/to/your/.dom-baselines
```

The directory must contain `registry.json` and per-site `selector-roles.json` files. The bundled baselines serve as a starting point; set this variable to point to your project's `.dom-baselines/` directory when using the skill outside its own repo.

## Integration with autofix

When the `opencli-autofix` skill encounters a SELECTOR error on a site that is in the registry:

1. Check `baselines/<site>/selector-roles.json` exists
2. Run `/dom-heal diagnose <site> --role <broken-role>`
3. Apply the top candidate from the heal output
4. After verifying the fix, run `/dom-heal save <site>`

## Architecture

```
opencli-dom-heal/
  cli.mjs                 → Subcommand dispatcher (this skill's entry point)
  vitest.config.js        → Standalone test runner config
  lib/
    analyze.mjs           → Live/JSDOM DOM analysis
    heal.mjs              → Candidate scoring and repair suggestions
    compare.mjs           → Baseline vs live diff engine
    snapshots.mjs         → Snapshot lifecycle and change detection
    scorer.mjs            → Multi-factor selector ranking
    generate-analysis.mjs → Generic analysis script generator (v2 baseline → JS)
    migrate.mjs           → v1 → v2 baseline migration
    analysis-doubao.js    → Hand-tuned doubao analysis script
    analysis-deepseek.js  → Hand-tuned deepseek analysis script
    health-check.js       → Lightweight health check
  baselines/<site>/
    selector-roles.json   → Functional roles → ranked selectors (v2 schema)
    snapshots/            → Timestamped analysis history (max 10)
    registry.json         → Global site registry
  tests/                  → 187 tests across 7 files
```

## Scoring factors (for heal.mjs)

| Factor | Weight | Logic |
|--------|--------|-------|
| Specificity | 0-10 | data-testid (10) > id (8) > aria (6) > semantic class (4) > generic (1) > hashed (0) |
| Uniqueness | -2 to +3 | Exactly 1 match (+3), 2-3 (+1), >10 (-2) |
| Text match | 0-5 | Button/placeholder text matches expected role pattern |
| Historical | 0-2 | Selector was previously used for this role |
| Hashed penalty | -3 to 0 | Penalty for CSS module hashed classes |
| Visibility | gate | Invisible elements are disqualified |
