---
name: awesome-lists
description: Publish our open source repo in GitHub awesome lists. Search for relevant lists, evaluate them, craft entries matching each list's format, and submit PRs/issues.
---

# Publish to GitHub Awesome Lists

Get our repo listed in popular GitHub awesome lists to drive organic discovery.

## Step 1: Craft the entry message

Before searching for lists, decide what to say. Read our README.md carefully — match its tone exactly (lowercase, direct, Karpathy-style, no marketing language).

Write three versions of the entry description:
- **Long** (~2 sentences) — for lists that allow detailed entries
- **Medium** (~1 sentence) — for standard lists
- **Short** (under 15 words) — for tight table formats

Rules:
- No "your" — it's a marketing trap
- No adjectives like "powerful", "seamless", "cutting-edge", "revolutionary"
- Lead with what it looks like to use (e.g. "WhatsApp-like interface") — concrete references everyone understands
- Highlight the three differentiators: chat-style multi-agent UI, autopilot routing while afk, mobile remote
- State what it does, not what it "enables" or "empowers"

Show the drafts to the user for approval before proceeding.

## Step 2: Search for awesome lists

Use the internal search tool to find candidate lists:

```bash
(cd /Users/rusty/Projects/temp/gpt-oss-20b-MXFP4-Q8 && npm run search:cli -- '{"queries":[
  "awesome AI coding agents CLI tools github list site:github.com",
  "awesome AI development tools terminal agents github site:github.com",
  "awesome list claude code codex gemini CLI agents site:github.com",
  "awesome open source AI tools agents frameworks github site:github.com",
  "awesome AI code assistants IDE tools github list site:github.com",
  "awesome terminal tools developer productivity AI github site:github.com",
  "awesome AI agents autonomous coding tools curated list site:github.com"
]}')
```

You can send up to 7 queries at once. Results arrive as JSON with `results[].items[].link` and `.title`.

Extract unique GitHub repo URLs from results.

## Step 3: Evaluate candidates

For each repo found, get the star count:

```bash
gh api "repos/OWNER/REPO" --jq '.stargazers_count'
```

Run this in a batch for all candidates. Sort by stars descending.

**Drop immediately:**
- Archived repos
- Repos requiring paid products only
- Repos that are skill/SKILL.md lists (not tool lists) — unless we have a matching skill to submit
- Repos where we don't meet minimum star/age requirements

**Check our repo stats too:**
```bash
gh api repos/rustykuntz/clideck --jq '{stars: .stargazers_count, created: .created_at}'
```

Compare against each list's requirements (some need 20+ stars, 90+ days, 100+ stars, etc).

## Step 4: Read contributing rules for each target

For every list we plan to submit to, fetch and read:
1. `CONTRIBUTING.md` (try main branch, then master)
2. `.github/PULL_REQUEST_TEMPLATE.md`
3. The README itself — check the entry format by looking at 2-3 existing entries near where ours would go

**Pay attention to:**
- Submission method: PR vs issue form vs Google Form (some ban PRs — e.g. awesome-claude-code uses issue forms only, PRs = ban)
- **CLI vs web-only**: some repos (e.g. hesreallyhim/awesome-claude-code) explicitly ban `gh` CLI submissions and require the GitHub web UI form. Check issue templates for "does not allow resource submissions via the `gh` CLI" language. These must be submitted by the user manually — prepare the form field values and hand them over.
- Entry format: plain markdown list, table rows, HTML details blocks — match exactly
- Ordering: alphabetical vs bottom-of-section
- Required elements: stars badges, specific badge styles, checklist items
- Star/age minimums
- PR title format (some require exact patterns like "Add APP_NAME")
- Whether they use data files (YAML/JSON) instead of README edits
- Auto-reject rules: some repos auto-close PRs from new repos with low stars/short history (e.g. kyrolabs/awesome-agents). Don't submit if we clearly don't meet the bar — it looks bad.

**Build a table for the user** summarizing each target: repo, stars, section, format, submission method, blockers.

## Step 5: Fork and submit

For each target repo:

```bash
# Fork
gh repo fork OWNER/REPO --clone=false

# Sync fork
gh repo sync rustykuntz/FORK

# Create branch
SHA=$(gh api repos/rustykuntz/FORK/git/ref/heads/main --jq '.object.sha')
gh api repos/rustykuntz/FORK/git/refs -f ref=refs/heads/add-clideck -f sha="$SHA"

# Get file content and SHA
gh api -X GET repos/rustykuntz/FORK/contents/README.md --field ref=add-clideck --jq '.sha'
```

To edit and upload via API (avoids cloning):

1. Download the file content
2. Insert our entry at the correct position (use python3 for multiline insertions — awk/sed break on complex entries)
3. Base64 encode the updated content
4. Push via Contents API:

```bash
gh api repos/rustykuntz/FORK/contents/README.md \
  -X PUT \
  -f message="Add clideck to SECTION_NAME" \
  -f content="$ENCODED" \
  -f sha="$FILE_SHA" \
  -f branch=add-clideck
```

5. **Always verify** the edit before creating the PR:
```bash
gh api -X GET repos/rustykuntz/FORK/contents/README.md --field ref=add-clideck --jq '.content' | base64 -d | grep -B2 -A2 "clideck"
```

6. Create PR matching the repo's requirements:
```bash
gh pr create --repo OWNER/REPO \
  --head rustykuntz:add-clideck \
  --title "TITLE MATCHING THEIR FORMAT" \
  --body "BODY WITH THEIR CHECKLIST/TEMPLATE"
```

For issue-based submissions (like awesome-claude-code):
```bash
gh issue create --repo OWNER/REPO --title "TITLE" --body "BODY"
```

## Step 6: Track results

Print a final summary table with all submissions: repo, stars, type (PR/issue), link, and any blockers.

Note any lists that are parked (we don't meet requirements yet) with the specific threshold we need to hit and when to retry.
