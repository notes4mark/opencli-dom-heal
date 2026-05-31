# DOM Heal — Selector Health & Self-Repair for OpenCLI Browser Adapters

> Part of the [OpenCLI](https://github.com/jackwener/OpenCLI) ecosystem — a browser automation framework that lets AI agents control websites through composable adapters. `opencli <site> <command>` is all an agent needs.

**dom-heal** detects DOM breakage in OpenCLI browser adapters before they fail at runtime, diagnoses broken selectors, and suggests fixes — from automated health checks to algorithmic repair scoring.

It answers three questions for every OpenCLI-covered website:

1. **Are our selectors still working?** (`check`, `audit`)
2. **What changed and what's the best replacement?** (`diagnose`)
3. **How do we onboard a site we've never seen before?** (`onboard` + Universal Onboarding Protocol)

Field-tested across Chat AI (doubao, deepseek), social media (xiaohongshu), Q&A (zhihu), and financial platforms (xueqiu).

---

## Covered Sites

| Site | Type | Health | Roles | Selectors | Topology |
|------|------|--------|-------|-----------|----------|
| [doubao](https://www.doubao.com/chat) | Chat AI | degraded | 11 | 61 | 2 states (main + conversation) |
| [deepseek](https://chat.deepseek.com) | Chat AI | critical | 11 | 20 | 2 states (main + conversation) |
| [chatgpt](https://chatgpt.com) | Chat AI | unknown | 8 | 17 | — |
| [claude](https://claude.ai/new) | Chat AI | unknown | 10 | 14 | — |
| [xiaohongshu](https://www.xiaohongshu.com/explore) | Social media | degraded | 9 | 19 | 3 states (feed + search + creator) |
| [zhihu](https://www.zhihu.com) | Q&A / Content | critical | 12 | 25 | 2 states (homepage + article) |
| [boss](https://www.zhipin.com/web/chat/index) | Recruitment | unknown | 4 | 12 | — |

> Health status from last `check`. `unknown` = never live-tested. `critical`/`degraded` includes topology-expected breakage.

**Not covered (API-only):** Sites like xueqiu (雪球) whose adapters use `page.evaluate(fetch(...))` exclusively — no DOM selectors exist to monitor.

Any [OpenCLI](https://github.com/jackwener/OpenCLI) adapter that touches the DOM can be onboarded via the [Universal Onboarding Protocol](https://github.com/notes4mark/opencli-dom-heal) in ~30 minutes.

---

## Quick Start

```bash
# Install
npm install opencli-dom-heal
# or
git clone https://github.com/notes4mark/opencli-dom-heal.git
cd opencli-dom-heal

# 1. Audit all sites (no browser needed)
node cli.mjs audit

# 2. Live health check on one site
node cli.mjs check doubao

# 3. Diagnose a broken role
node cli.mjs diagnose doubao --role send_button

# 4. Save after fixing
node cli.mjs save doubao
```

Or with slash commands (when using Claude Code):
```
/dom-heal audit
/dom-heal check doubao
/dom-heal diagnose doubao --role send_button
/dom-heal save doubao
```

## Prerequisites

- **Chrome** with OpenCLI extension installed
- **`opencli doctor`** all green (bridge + daemon running)
- **Node.js** ≥ 18
- (Optional) `DOM_HEAL_BASELINES` env var for custom baseline directory

```bash
opencli doctor                                          # verify environment
export DOM_HEAL_BASELINES=/path/to/your/.dom-baselines  # custom baselines
```

---

## How It Works

dom-heal is a two-layer system:

```
┌──────────────────────────────────────────────┐
│  JUDGMENT LAYER                              │
│  dom-heal-workflow meta-skill                │
│  ┌─────────────────────────────────────┐     │
│  │ Universal Onboarding (U1→U5)        │     │  "What should I do?"
│  │ Cold-start protocol for new sites   │     │
│  ├─────────────────────────────────────┤     │
│  │ Repair Workflow (Phase 0→6)         │     │
│  │ Diagnosis and fix for known sites   │     │
│  └─────────────────────────────────────┘     │
└──────────────────┬───────────────────────────┘
                   │ guides each step
                   ▼
┌──────────────────────────────────────────────┐
│  EXECUTION LAYER                             │
│  dom-heal skill (8 CLI subcommands)           │
│  check | diagnose | save | audit | show | ... │  "Just do it"
│  node cli.mjs <subcommand> <site>            │
└──────────────────────────────────────────────┘
```

The **execution layer** handles the mechanics: open a browser, inject analysis scripts, diff against baselines, score candidates. The **judgment layer** handles the reasoning: is this a real break or a false alarm? Should we fix the analysis script, the baseline, or the adapter source? Do we even need DOM monitoring for this site?

---

## CLI Commands

### `check <site>` — Live Health Check

Opens browser to the site's default URL, injects an analysis script, compares results against baseline.

```bash
node cli.mjs check doubao
```

**Output:** Per-role health (ok/degraded/broken), specific broken selectors, exit code (0=OK, 1=DEGRADED, 2=CRITICAL).

**What can go wrong:**

| Symptom | Cause | Fix |
|---------|-------|-----|
| ALL roles BROKEN | Wrong page (about:blank, login wall) | `opencli browser <s> open "<url>"` |
| Some roles BROKEN | Real DOM change | Enter repair workflow |
| Command fails | Bridge down | `opencli doctor` |

### `diagnose <site> [--role <name>]` — Score Replacement Candidates

Three-step pipeline: capture DOM snapshot → diff against baseline → score every selector on the page as a potential replacement.

```bash
node cli.mjs diagnose doubao --role send_button
```

Each candidate gets a composite score across specificity, uniqueness, text match, historical use, and hash penalty (see [Scoring Algorithm](#scoring-algorithm)).

**Critical caveat:** The algorithm scores what the analysis script *captured*. If the script ran on the wrong page state, didn't trigger conditional rendering, or captured mid-stream, the scores are meaningless. **DOM evidence from manual inspection trumps algorithmic scores. Always.**

### `audit` — Batch Health Report (Offline)

No browser needed. Reads selector status from baselines and registry.

```bash
node cli.mjs audit
```

Use this daily to know which adapters need attention.

### `save <site>` — Persist Current State

Saves a timestamped DOM snapshot (max 10), updates baseline selector statuses, and updates the registry entry.

```bash
node cli.mjs save <site>
```

**Watch out:** `save` may strip custom baseline fields like `page_topology`. After saving, always run `node cli.mjs test` and `git diff` on the baseline directory to check what changed.

### `show <site>` — Display Full Baseline

```bash
node cli.mjs show doubao
```

Shows every role, every selector (with priority, stability, status), and active `analysis_hints`. Use before editing a baseline.

### `changes <site>` — Detect DOM Drift

```bash
node cli.mjs changes doubao
```

Diffs the current live page against the last saved snapshot. Shows appeared, disappeared, and count-changed selectors.

### `onboard <site>` — Extract Selectors from Adapter Source

```bash
node cli.mjs onboard <site>
```

Scans adapter source files for `querySelector`/`querySelectorAll` calls and extracts candidate selectors. **This is a starting point, not a complete solution** — for API-driven adapters, source scanning finds very little. The Universal Onboarding Protocol (below) combines source extraction with live-page inspection for a complete baseline.

### `test` — Run Test Suite

```bash
node cli.mjs test           # 187 tests, single run
node cli.mjs test --watch   # watch mode
```

---

## Core Concepts

### Roles and Selectors

A **role** is a functional element on the page (e.g., "send button", "search input", "message container"). Each role has a ranked list of **selectors** (P1 = primary, P2 = fallback, P3 = generic).

```json
{
  "send_button": {
    "category": "button",
    "description": "Send message button in chat composer",
    "selectors": [
      { "css": "[data-testid=\"send-button\"]", "type": "data-testid", "priority": 1, "stability": "high", "status": "ok" },
      { "css": "button.send-btn", "type": "class-exact", "priority": 2, "stability": "medium", "status": "degraded" }
    ]
  }
}
```

**Selector types** (in order of stability):

| Type | Stability | Example |
|------|-----------|---------|
| `data-testid` | high | `[data-testid="send-button"]` |
| `id` | medium-high | `#composer` |
| `attribute` | medium | `[role="button"]`, `[aria-label="Send"]` |
| `class-exact` | medium | `.send-btn` |
| `structural` | high | `section:has(a[href*="/search/"])` |
| `descendant` | medium | `.footer .title span` |
| `class-substring` | low-medium | `[class*="search"]` |
| `tag` | low | `textarea` |
| `text` | low | Text content match (fallback for hashed classes) |

### Selector Status Lifecycle

```
discovered → status: "ok" ─────────────┐
                  │                      │
                  │ DOM change           │ fix verified
                  ▼                      │
            status: "broken" ───────────┘
                  │
                  │ permanently removed from site
                  ▼
            archive / demote to P3
```

Every status change gets a dated `history` entry explaining why.

### Page Topology

Most websites have multiple page states, and selectors only exist on some of them. If you don't track this, `check` will report false BROKEN alarms.

| Site type | Typical states |
|-----------|---------------|
| Chat AI | Homepage (chat list), Conversation detail, Settings |
| Social media | Feed, Post detail, Publish/Creator center |
| Content / Q&A | Homepage, Article/Answer detail, Search results |
| E-commerce | Homepage, Product detail, Cart, Checkout |
| Recruitment | Job list, Chat list, Chat detail |

A selector that only exists on a *different* page than the default URL is **topology-dependent** — it will always show BROKEN on the default page, and that's expected. The baseline documents this in the role description and history notes.

### Two-Tier Coverage

| Tier | Scope | Analysis script | When to use |
|------|-------|----------------|-------------|
| **Baseline-level** | ~150 OpenCLI adapters | Auto-generated from `analysis_hints` | Simple pages, static content, single-page-state sites |
| **Hand-tuned** | High-traffic + complex sites | Custom `analysis-<site>.js` + orchestration in `analyze.mjs` | Chat AI, multi-page topology, conditional rendering, streaming content |

Hand-tuned scripts handle four patterns that auto-generated scripts can't:
- **Pattern A: Pre-population** — trigger conditional rendering before inspection
- **Pattern B: Multi-pass analysis** — capture selectors across page states, merge results
- **Pattern C: Text-based matching** — for elements whose CSS classes rotate (CSS modules)
- **Pattern D: Empty-state fallback** — handle fresh accounts with no history

---

## Universal Onboarding Protocol (U1 → U5)

For adding DOM health monitoring to any OpenCLI-covered site. Estimated time: 30-45 minutes.

### U1. Triage — Classify Without a Browser (5 min)

**Goal:** Does this adapter even touch the DOM?

```bash
grep -rl "querySelector\|\.locator\|getElementById" \
  ~/.npm-global/lib/node_modules/@jackwener/opencli/clis/<site>/*.js \
  | grep -v test
```

| DOM files | Archetype | DOM surface | Action |
|-----------|-----------|------------|--------|
| 0 | **API-only** | 0 selectors | **STOP.** Skip dom-heal. Adapter uses `fetch()` exclusively. |
| 1–2 | **DOM-light** | 5–20 selectors | Continue. Small, focused baseline. |
| 3–5 | **DOM-medium** | 15–40 selectors | Continue. May need hand-tuning. |
| 6+ | **DOM-heavy** | 30–60 selectors | Continue. Likely needs hand-tuned script. |

> This is where xueqiu (雪球) terminated: 17 source files, 0 DOM-touching files → API-only, no DOM monitoring needed.

### U2. Reconnaissance — Live Page Discovery (10 min, browser)

**Goal:** Map what the page actually offers, independently of what the adapter uses.

Open the browser, check for login walls / CAPTCHA, then run the universal discovery eval — a single `opencli browser eval` payload that captures: class prefix distribution, `data-*` attribute inventory, all inputs and buttons (with text, aria-labels, visibility), semantic class hits, and scroll containers.

> This is the phase that caught xiaohongshu's 4 made-up selectors — class names like `.note-title` and `.author-name` that were guessed during initial baseline creation but never actually existed on the page.

### U3. Topology — Map Page States (5–10 min, browser)

**Goal:** Prevent false BROKEN alarms by understanding which selectors live on which pages.

Navigate to 2–3 distinct page states. For each, check which candidate selectors exist. Build a state × selector matrix.

| Pattern | Meaning |
|---------|---------|
| Exists on ALL states | Universal role, always checkable |
| Exists on SOME states | Topology-dependent, mark in baseline |
| Exists on NONE | Either wrong URL or anti-bot blocking |

### U4. Baseline — Build `selector-roles.json` (10–15 min, no browser)

Two sources combined:
1. **Core roles** from adapter source (U1) — what the adapter uses, what breaks it
2. **Monitor roles** from live discovery (U2) — what the page offers, what detects redesign

Write `analysis_hints` based on U2/U3 findings to make the auto-generated analysis script effective.

### U5. Verify — Topology-Aware Interpretation (5–10 min, browser)

Run `check`, then for each BROKEN role ask: **"Should this selector exist on the default URL?"**

- **YES** → Real breakage. Enter Repair Workflow.
- **NO** → Topology false alarm. Document it, accept it.

Four termination conditions:
- **API-only** → "This site doesn't need DOM heal"
- **All OK** → "Baseline created, health is good"
- **Topology false alarms only** → "Baseline created, some roles are page-specific"
- **Real breakages** → "Baseline created, now enter Repair Workflow Phase 2"

---

## Repair Workflow (Phase 0 → 6)

For already-onboarded sites showing CRITICAL or DEGRADED health.

### Phase 0: Browser Session Checklist
`opencli doctor` must be green. Browser must be on the right page. Don't skip this — "all roles BROKEN" is usually a wrong-page problem, not a real DOM change.

### Phase 1: Run Health Check
```bash
node cli.mjs check <site>
```
All OK → done. Some BROKEN → Phase 1.5. All BROKEN → wrong page, go back to Phase 0.

### Phase 1.5: Topology Mapping
For each broken role, ask: "Would this exist on the current page state?" Chat AI sites have at least 2 states; social media often has 3+. If a broken role only exists on a different state, the fix is multi-pass analysis, not a selector change.

### Phase 2: 8 Diagnostic Questions (Manual DOM Inspection)
1. **2a.** Does the element exist at all? (`querySelectorAll` count)
2. **2b.** Is it conditionally rendered? (needs interaction to appear)
3. **2c.** Has the element type changed? (`<button>` → `<div role="button">`)
4. **2d.** Have CSS classes rotated? (class prefix frequency analysis)
5. **2e.** Is there a new stable attribute? (`data-testid`, `data-target-id`)
6. **2f.** Does it only exist on a different page/view?
7. **2g.** Is content streamed/loaded asynchronously?
8. **2h.** Is account state affecting visibility? (fresh vs. active account)

### Phase 3: Algorithmic Diagnosis
```bash
node cli.mjs diagnose <site> --role <role>
```

**Scores lie when:** the element is conditionally rendered, on a different page state, has CSS modules, can only be matched by text, or is streamed asynchronously. Trust Phase 2 DOM evidence over scores.

### Phase 4: Fix (Three Layers, Narrowest Blast Radius First)

| Layer | What | Blast radius | Example |
|-------|------|-------------|---------|
| **L1** | Analysis script | Lowest — only changes inspection | Pre-populate textarea before checking send button |
| **L2** | Baseline JSON | Medium — changes health tracking | Mark old class broken, add new class ok |
| **L3** | Adapter source | Highest — affects all users | Change Playwright `page.locator()` selector |

**A broken health check ≠ a broken adapter.** Always verify the adapter actually fails at runtime before touching Layer 3.

### Phase 5: Verify
```bash
node cli.mjs check <site>    # Health improved?
node cli.mjs audit           # No regressions?
node cli.mjs test            # Tests pass?
```

### Phase 6: Document
```bash
node cli.mjs save <site>
```
Then: update registry notes, sync baselines, check `git diff` for unexpected changes.

---

## Case Studies

### Doubao (豆包) — Conditional Rendering

**Symptom:** `send_button` BROKEN in every health check.

**Root cause:** The send button only renders after text is typed in the composer. The analysis script never typed anything, so the button never appeared. The selector was fine — the *inspection method* was wrong.

**Fix:** Layer 1 — added a pre-population IIFE that types "health-check" into the textarea before running role checks (Pattern A).

**Also discovered:** `[data-target-id="message-box-target-id"]` as a new stable attribute for `message_item` (Phase 2e).

### DeepSeek — CSS Module Rotation + Multi-Page Topology

**Symptom:** 4 roles BROKEN/DEGRADED in one check.

**Root causes (multiple):**
- CSS module hash rotation: `.ds-markdown--think` → `.ds-think-content`, `.ds-thinking-header` removed, `.prose` removed
- `model_radio` only exists on the main page, not inside a conversation
- Streaming responses cause intermittent `thinking_header` failures
- Fresh account has no conversation history to navigate into

**Fix:** Layer 1 — implemented multi-pass analysis (Pattern B): capture main-page selectors first, auto-navigate into conversation, capture conversation selectors, merge results. Added text-based pattern matching for rotated classes (Pattern C). Added empty-state fallback that creates a new conversation (Pattern D).

**Key insight:** `opencli browser eval` supports async functions, but JSDOM does not. Keep analysis scripts synchronous; put all async navigation/polling in `analyze.mjs`.

### Zhihu (知乎) — API-Driven Adapter + Anti-Bot

**Symptom:** `onboard` extracted only 6 selectors from source code.

**Root cause:** Zhihu's adapter is API-driven — 15 of 16 source files use `page.evaluate(fetch(...))` to call internal APIs, never touching `document.querySelector`. Only `download.js` uses DOM selectors (5 for article title/author/time/content).

**Fix:** Combined source extraction (6 selectors, core roles) with live-page inspection (25+ selectors, monitor roles). This "source + live" approach became the standard onboarding method.

**Also discovered:** Anti-bot protection blocks lazy-loaded content on article detail pages — those selectors can only be verified manually. Marked as topology-dependent. The `save` command strips custom fields like `page_topology` — re-add after save, verify with `node cli.mjs test`.

### Xiaohongshu (小红书) — Made-Up Selectors

**Symptom:** During U2 live verification, 5 selectors in the existing baseline returned 0 matches.

**Root cause:** The original baseline (created without live testing) contained 4 entirely guessed class names — `.note-title`, `.author-name`, `.nick-name`, `.like-count` — that never existed on the actual page. A fifth selector (`a[href*="/note/"]`) matched a dead link pattern.

**Fix:** Removed all 5 dead selectors. Live-verified the remaining 19 across 3 page states (explore feed, search results, creator center). Documented 3-state topology. The 2 publish roles are topology-dependent (creator center only) — marked broken, expected.

**Key insight:** U2 live verification is not optional. Even for sites with pre-existing baselines, never trust a baseline that hasn't been live-verified.

### Xueqiu (雪球) — API-Only (STOP)

**Symptom:** U1 triage found 0 DOM-touching files across 17 adapter source files.

**Root cause:** Every xueqiu adapter command uses `page.evaluate()` with internal `fetch()` calls to xueqiu's backend APIs. There are no CSS selectors to monitor.

**Result:** Terminated at U1. This validated the protocol's first STOP condition — not every site needs DOM heal.

---

## Scoring Algorithm

When `diagnose` runs, every candidate selector on the page is scored across six factors:

| Factor | Weight | Logic |
|--------|--------|-------|
| Specificity | 0–10 | `data-testid` (10) > `id` (8) > `aria` (6) > semantic class (4) > generic tag (1) > hashed (0) |
| Uniqueness | -2–+3 | Exactly 1 match (+3), 2–3 (+1), >10 (-2) |
| Text match | 0–5 | Button/placeholder text matches expected role pattern |
| Historical | 0–2 | Selector was previously used for this role |
| Hashed penalty | -3–0 | Penalty for CSS module hashed class names |
| Visibility | gate | Invisible elements (`offsetParent === null`) are disqualified |

---

## Architecture

```
opencli-dom-heal/
  SKILL.md                       # Skill definition for Claude Code
  README.md                      # This file
  cli.mjs                        # CLI entry point (8 subcommands)
  vitest.config.js               # Test runner config
  lib/
    analyze.mjs                  # Live/JSDOM DOM analysis engine + orchestration
    heal.mjs                     # Candidate scoring and repair suggestions
    compare.mjs                  # Baseline vs. live diff engine
    snapshots.mjs                # Snapshot lifecycle and change detection
    scorer.mjs                   # Multi-factor selector ranking
    generate-analysis.mjs        # Auto-generate analysis JS from v2 baseline + hints
    migrate.mjs                  # v1 → v2 baseline migration + validation
    analysis-doubao.js           # Hand-tuned: pre-population for conditional rendering
    analysis-deepseek.js         # Hand-tuned: text-based matching for CSS modules
    health-check.js              # Lightweight health check
  baselines/
    registry.json                # Global site registry (health, stats, metadata)
    doubao/selector-roles.json   # 11 roles, 61 selectors
    deepseek/selector-roles.json # 11 roles, 20 selectors
    chatgpt/selector-roles.json
    claude/selector-roles.json
    xiaohongshu/selector-roles.json  # 9 roles, 19 selectors, 3-state topology
    zhihu/selector-roles.json    # 12 roles, 25 selectors, API-driven adapter
    boss/selector-roles.json
  tests/                         # 187 tests across 7 files
```

### Analysis Script Pipeline

```
analysis_hints (in baseline JSON)
        │
        ▼
generate-analysis.mjs    ───→  auto-generated JS (baseline-level coverage)
        │
        │  OR (for complex sites)
        ▼
analysis-<site>.js       ───→  hand-tuned JS (Patterns A/B/C/D)
        │
        ▼
analyze.mjs              ───→  orchestration: navigation, multi-pass, merging
        │
        ▼
opencli browser eval     ───→  injected into live Chrome
```

---

## Pitfalls (Field-Tested)

1. **about:blank false alarm** — All roles BROKEN. Check `opencli browser <s> state` first.
2. **Conditional rendering masked as breakage** — Fix the analysis script, not the selector.
3. **`:has-text()` in analysis scripts** — `document.querySelectorAll("button:has-text('Send')")` throws SyntaxError. Use `el.innerText` matching.
4. **Escaped quotes in template literals** — `\'` in backtick strings is a literal backslash, not an escape.
5. **JSON corruption from manual edits** — Validate with `JSON.parse()` after editing baselines.
6. **Element type changes** — `<button>` → `<div role="button">`. Update both baseline and adapter.
7. **Adapter source edited when analysis script suffices** — Broken check ≠ broken adapter. Start at Layer 1.
8. **Forgot to save** — Fixes applied but `save` never run. Registry shows stale health.
9. **JSDOM doesn't support async** — Keep analysis scripts synchronous. Async logic in `analyze.mjs`.
10. **Right domain, wrong SPA route** — Session on correct site but wrong internal page. Check URL path.
11. **Fresh account empty state** — Navigation polls for links that don't exist. Always handle both paths.
12. **Streaming content race condition** — Analysis captures partial DOM. Accept `degraded` for streamed elements.
13. **`onboard` extracts too few selectors** — API-driven adapters need live inspection to supplement source scanning.
14. **`save` strips custom fields** — `page_topology`, `_meta` blocks may be removed. Re-add after save.
15. **v2 validation requires `"site"` field** — `save` may strip it. Add `"site": "<name>"` back, run `node cli.mjs test`.
16. **Anti-bot blocks detail-page content** — Some selectors can't be verified by automation. Mark as topology-dependent.

---

## Integration with opencli-autofix

When the `opencli-autofix` skill encounters a SELECTOR error on a registered site:

1. Check `baselines/<site>/selector-roles.json` exists
2. Run `/dom-heal diagnose <site> --role <broken-role>`
3. Apply the top candidate from the heal output
4. After verifying the fix, run `/dom-heal save <site>`

---

## Custom Baselines

To maintain separate baselines for another project:

```bash
export DOM_HEAL_BASELINES=/path/to/your/.dom-baselines
```

Directory structure:
```
.dom-baselines/
  registry.json
  doubao/selector-roles.json
  doubao/snapshots/2026-05-30T080000Z.json
  deepseek/selector-roles.json
  ...
```

---

## License

Part of the [OpenCLI](https://github.com/jackwener/OpenCLI) ecosystem.
