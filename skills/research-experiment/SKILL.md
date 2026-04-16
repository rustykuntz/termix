---
name: research-experiment
description: Coordinate autonomous research experiments across multiple coding agents using isolated git worktrees. Use when a user wants the main agent to define a goal, constraints, acceptance criteria, and experiment boundaries, then dispatch Codex/Claude/Gemini or other agents to independently search for solutions without touching production code.
---

# Research Experiment

Use this skill to run parallel, autonomous experiments safely.

There are two roles:

- Main Agent: owns the research brief, workspace setup, researcher prompts, verification, and merge decision.
- Experiment Agent: owns independent exploration inside one assigned worktree and must not redefine the experiment.

If the user says "you are the main agent", follow the Main Agent Role. If the user says "you are an experiment agent" or "researcher agent", follow the Experiment Agent Role.

## Main Agent Role

The main agent defines the experiment and coordinates researchers. It must not let each researcher invent different goals or acceptance criteria.

## Main Agent Workflow

1. Convert the user request into an experiment brief:
   - Goal: the outcome to achieve.
   - Acceptance criteria: exact tests, benchmarks, or review gates.
   - Hard constraints: what must not change.
   - Quality bar: what counts as meaningful progress versus noise.
   - Shared resources: ports, GPUs, model caches, services, datasets, credentials, or external APIs.
   - Stop conditions: when researchers may quit.

2. Identify the production repository root:
   - Use `git rev-parse --show-toplevel` when inside a git repo.
   - If the project has nested repos, identify which repo owns the files under experiment.
   - Do not assume the current working directory is the repo root.

3. Create per-researcher worktrees inside the project folder, not beside it:
   - Prefer a project-local directory such as `<project>/.research-worktrees/<slug>-<n>`.
   - Keep worktree directories inside the main project folder so agents do not need extra filesystem permissions.
   - Do not create sibling worktrees such as `../project_research_1` unless the user explicitly asks.
   - Never point a researcher at the production checkout for edits.
   - Use unique branches, for example `research/<slug>-1`, `research/<slug>-2`.

4. Give every researcher the same goal and rules:
   - Do not assign fixed technical roles unless the user explicitly asks.
   - Let each researcher decide the approach and iterate independently.
   - Include the exact worktree path, branch, allowed edit scope, forbidden files, verification commands, and report format.
   - Save the canonical brief to the experiment folder before dispatching researchers.

5. Verify centrally:
   - Researchers may run local checks in their worktree, but the main agent owns authoritative acceptance verification.
   - If benchmarks contend for scarce resources, run final benchmarks sequentially from the main agent.
   - Merge nothing unless it passes acceptance criteria and clears the quality bar.

## Experiment Folder

The main agent should create one experiment folder under the main project, for example:

```text
.research-worktrees/<experiment-slug>/
```

Inside it, create:

- `EXPERIMENT.md`: the canonical brief, baseline, quality gate, constraints, assignments, commands, and report format.
- `<slug>-experiment-1/`: worktree for researcher 1.
- `<slug>-experiment-2/`: worktree for researcher 2.
- `<slug>-experiment-3/`: worktree for researcher 3.
- `<slug>-experiment-1/LOG.md`: progress log for researcher 1.
- `<slug>-experiment-2/LOG.md`: progress log for researcher 2.
- `<slug>-experiment-3/LOG.md`: progress log for researcher 3.

Researcher prompts should tell agents to read `EXPERIMENT.md` first and then follow only their assigned workspace, branch, log file, and resource values.

The main agent may check each researcher log during the experiment to monitor progress without interrupting researchers. Researcher agents should append concise entries after each meaningful experiment loop:

- Hypothesis tried.
- Files changed.
- Command run.
- Result versus same-session baseline.
- Keep/reject decision.
- Current blocker, if any.

## Worktree Setup

Use project-local worktrees. The worktree directory must live under the main project folder:

```bash
mkdir -p .research-worktrees
mkdir -p .research-worktrees/<experiment-slug>
git worktree add .research-worktrees/<experiment-slug>/<slug>-experiment-1 -b research/<slug>-1
git worktree add .research-worktrees/<experiment-slug>/<slug>-experiment-2 -b research/<slug>-2
git worktree add .research-worktrees/<experiment-slug>/<slug>-experiment-3 -b research/<slug>-3
```

If a branch already exists, choose a new suffix. Do not delete or overwrite existing worktrees unless the user explicitly asks.

When the target files live in a nested repo, run the worktree commands from that nested repo root but still put the worktree folders under the main project folder. Example:

```bash
cd path/to/nested/repo
mkdir -p /absolute/path/to/main-project/.research-worktrees
mkdir -p /absolute/path/to/main-project/.research-worktrees/<experiment-slug>
git worktree add /absolute/path/to/main-project/.research-worktrees/<experiment-slug>/<slug>-experiment-1 -b research/<slug>-1
```

## Baseline And Quality Gate

Before changing code, each researcher must run the exact benchmark or check command once from their assigned worktree and record it as their same-session baseline.

Compare final results against:

- The user/main-agent supplied baseline.
- The researcher’s same-session baseline.

The main agent/user defines the quality gate for each experiment. Examples:

- Test suite must pass.
- Benchmark score must not regress.
- ASR must recover at least N words from generated TTS.
- Human listening check required.

Do not invent or weaken the quality gate. If the gate is unclear, ask the main agent before accepting a result.

## Experiment Agent Role

The experiment agent executes the fixed brief from the main agent. It uses this skill for discipline and workflow only.

Follow only your assigned researcher section from the experiment brief. Do not edit outside your assigned worktree.
Create any temporary files, profiling scripts, generated outputs, scratch notes, and helper artifacts inside your assigned worktree. Do not use `/tmp`, `/var/tmp`, home-directory scratch folders, or sibling project folders unless the brief explicitly allows it.

The experiment agent must not redefine:

- Goal.
- Constraints.
- Quality gate.
- Benchmark commands.
- Acceptance criteria.
- Assigned workspace or branch.

If any of those are missing or ambiguous, ask the main agent for clarification before accepting a result. Do not make up a weaker gate.

## Experiment Agent Autonomy

DO NOT STOP EXPERIMENTING UNLESS YOU ACHIEVED THE GOALS OR ABSOLUTELY NECESSARY.

- Do NOT ask the user if you should continue.
- The user may be away from the computer and expects the experiment to continue until you achieve the experiment goals, so keep working until the task is naturally complete.
- You are autonomous. If you are unsure how to proceed, re-read the skill, goals, context, think differently, try different innovative approaches, and continue.
- Stop only if something out of your control blocks you from continuing. Otherwise continue experimenting until goals are achieved or the useful paths are exhausted.

## Researcher Prompt Template

Include this block, or an equivalent adapted version, in every researcher prompt:

```text
You are an autonomous research agent for this experiment.

Goal:
<goal>

Experiment rules and boundaries:
<rules>

Assigned workspace:
<absolute path to your worktree>

Canonical experiment brief:
<absolute path to EXPERIMENT.md>

Assigned experiment log:
<absolute path to your LOG.md>

You must work only inside your assigned worktree unless the brief explicitly allows another path. Do not edit, overwrite, or revert files in the production checkout. Do not change benchmark scoring, test fixtures, or acceptance criteria unless the brief explicitly asks for that.
Read the canonical experiment brief before making changes. Follow only your assigned researcher section. Do not redefine the goal, constraints, quality gate, benchmark commands, acceptance criteria, workspace, branch, port, log path, or resource assignments. Do not edit outside your assigned worktree.
If you need temp folders, profiling scripts, scratch files, benchmark outputs, or helper artifacts, create them inside your assigned worktree. Do not use `/tmp`, `/var/tmp`, home-directory scratch folders, or sibling project folders unless the brief explicitly allows it.

DO NOT STOP EXPERIMENTING UNLESS YOU ACHIEVED THE GOALS OR ABSOLUTELY NECESSARY.
- Do NOT ask the user if you should continue.
- The user may be away from the computer and expects the experiment to continue until you achieve the experiment goals, so keep working until the task is naturally complete.
- You are autonomous. If you are unsure how to proceed, re-read the skill, goals, context, think differently, try different innovative approaches, and continue.
- Stop only if something out of your control blocks you from continuing. Otherwise continue experimenting until goals are achieved or useful paths are exhausted.

Loop:
1. Inspect the code and constraints.
2. Form hypotheses.
3. Try a small, explainable experiment.
4. Run relevant verification.
5. Keep, revise, or reject the attempt.
6. Repeat until the goal is achieved, useful paths are exhausted, or an external blocker prevents progress.

Report format:
- Worktree path and branch.
- Changed files.
- Commands run and exact relevant output.
- Results against acceptance criteria.
- Failed attempts and why they were rejected.
- Whether you recommend merging the patch.
- Any cleanup needed: running servers, ports, PIDs, temp files.

Also append concise progress entries to your assigned experiment log after each meaningful experiment loop.
```

## Shared Resource Rules

For resources that can contaminate results or conflict across agents:

- Assign unique ports, output directories, cache directories, and branch names.
- Do not run final GPU/MPS benchmarks concurrently across researchers.
- Prefer researcher-local smoke tests and main-agent final benchmarks.
- Require researchers to stop servers they started, or report any still-running process clearly.

## Merge Rules

The main agent must review researcher diffs before applying them to production.

Reject or keep separate any patch that:

- Touches production checkout files.
- Changes tests, benchmarks, fixtures, sample inputs, or scoring without permission.
- Passes only because the acceptance criteria were weakened.
- Produces only noisy or marginal improvement below the declared quality bar.
- Leaves unexplained background processes or shared state.

If a researcher accidentally edits the production checkout, preserve pre-existing user changes and move or recreate the experiment in an isolated worktree before continuing.
