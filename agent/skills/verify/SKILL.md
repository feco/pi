---
name: verify
description: Prove a change works by running every required check and then exercising the real software, including the app run locally, a headless browser for web UIs, and profiling with flame graphs when performance matters. Use after changing code and before calling it done, or when the user asks to verify, test manually, check performance, or confirm a change works.
---

# Verify

Prove the change works in the running software, not just in the tests. A check you did not run is not evidence. Report what you ran and what you saw, and name what you could not check.

Never verify against production. Use local, test, or staging environments, and don't trigger real emails, payments, or other external side effects.

## 1. Find what "verified" means here

Read the repository's instructions (for example `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`) and its automation: CI workflows, task runners (`Makefile`, `package.json` scripts, `justfile`, `pyproject.toml`), and pre-commit hooks. CI is the best record of the required checks. List them before running anything.

Then decide which manual checks the change needs, from what it touches: a user flow, a command's output, an endpoint, data, or a hot path.

**Done when** you have a list of the automated checks and the manual checks this change needs.

## 2. Run the automated checks

Run the checks CI runs, with the same commands, cheapest first: formatting, lint, type checks, unit tests, integration tests, build. Run the full suites, not only the tests near the change.

A failure is a finding. Don't skip a check, mark it as expected to fail, or weaken a test to get green. Fix the failure only if that is part of the current task, then run every check again.

**Done when** every required check passes, or each failure is reported with its output.

## 3. Run the software

Exercise the changed behavior the way a user or caller would, with realistic input, and include an edge case and an error path. Pick the method from the project type:

- **CLI or script:** run the command, then check the output, the exit code, and any files it writes.
- **Library:** call the changed API from a small throwaway script or a REPL, outside the test suite.
- **API or service:** start it locally, call the changed endpoints (for example with `curl`), and check the status codes, the response bodies, and the logs.
- **Web app:** see [Web apps](#web-apps).
- **Data change or migration:** run it on a copy of the data, then compare row counts and sample records before and after. Run the rollback if one exists.
- **Desktop, mobile, or terminal UI:** drive it with the platform's automation tool, or take screenshots and look at them.

Watch the logs while you do this. New warnings, errors, or stack traces count as failures even when the feature appears to work.

**Done when** the changed behavior has run end to end and you have seen the result.

### Web apps

1. Start the dev server in the background and wait until it responds on its port before going on.
2. Drive a headless browser through the changed flow with the browser automation tool that is available (for example Playwright, Puppeteer, or a browser CLI). Navigate, click, type, and submit as a user would.
3. Check what the user sees: assert on visible text and state, then take a screenshot and look at it. Check the layout at a mobile and a desktop viewport when the UI changed.
4. Check what the user doesn't see: browser console errors, failed or unexpected network requests, and server logs.
5. When the change touches UI, run an accessibility check (for example axe) on the changed pages.

## 4. Measure performance when it matters

Measure when the change touches a hot path, a query, a render loop, or the bundle, or when the change or the user makes a performance claim. Otherwise, skip this step and say so.

1. Measure a baseline on the code before the change and the same measurement after, on the same machine, with several runs. Report the median and the spread, not a single run.
2. Profile to see where the time goes, and render a flame graph when the tool supports one. Typical tools are `py-spy` for Python, `perf` or `cargo flamegraph` for native code, `0x` or `clinic` for Node.js, and a browser performance trace or Lighthouse for web pages.
3. Read the flame graph: the widest frames are where the time goes. Check that the change moved the frames it was meant to move and didn't add a new wide one.
4. For web pages, also check the Core Web Vitals and the bundle size against the baseline.

**Done when** you have before and after numbers, and a profile for any slowdown.

## 5. Clean up

Stop the servers and background processes you started. Delete temporary data, screenshots you don't report, and throwaway scripts. Check `git status` for stray files and leftover debug code.

**Done when** the working tree holds only the intended change.

## 6. Report the evidence

For each check, give the command or the action, and the result: passed, failed with its output, or skipped with the reason. Include the paths to screenshots and flame graphs, and the before and after numbers.

List what you could not verify, and why. If a missing tool blocked a check (for example no headless browser or profiler is installed), name the tool, say what it would check, and ask before installing it. Never call a change verified when a required check didn't run.
