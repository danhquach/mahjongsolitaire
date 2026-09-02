# Workflow rules (mandatory)

- **One branch per ticket.** Never commit work directly to `main`. For each GitHub issue, create a branch first: `issue-<n>-<short-slug>` (e.g. `issue-2-core-engine`).
- **Always merge via a GitHub pull request.** Every branch lands on `main` through a PR — never a local `git merge` pushed to `main` (2026-08-30: issues #1–#3/#26 were merged locally without PRs; from now on the PR is the merge record).
- **QA before commit.** Run the full test suites from a clean install (`core`: `npm ci && npm test`; `ui`: `npm ci && npm test`; bench: `node --test bench/test/*.test.mjs`; worker: `node --test worker/test/*.test.mjs`) and verify the ticket's acceptance criteria. All green before any commit.
- **Senior-dev code review before commit.** Run a senior-level code review of the working-tree diff (correctness, tests, spec/roadmap acceptance criteria, conventions). Findings must be resolved or explicitly accepted.
- **MUST wait for approval before commit.** After QA and review pass, present the results and the proposed changes, then STOP and wait for the PM's explicit approval before committing (and before pushing). No exceptions — a green suite is not approval.
- **Branch review before merge.** When pushing a branch, run a code review of the full branch diff (`main..HEAD`) — correctness, tests, and the repo's spec/roadmap acceptance criteria for that ticket.
- **Close the ticket when done.** After the work is merged (or the deliverable is accepted), close the GitHub issue with a closing comment linking the merge commit/PR.
- **Merge only when all green.** Merge to `main` only when: review findings are resolved, all tests/CI pass, and the ticket's acceptance criteria are met. No self-merge over open findings.

# Communication

- Default reply style: brief. Lead with the recommendation, a few bullets max, no walls of text; detail goes in docs, not chat.
- Wait for explicit confirmation before committing/pushing work (see the QA/review/approval gate in Workflow rules).

# Identity

- Commit as `Daniel Quach <danielq.engineer@gmail.com>` (repo-local git config, already set).

# Project docs

- Spec: `mahjong-solitaire-spec.md` · Roadmap: `ROADMAP.md` · Decisions: `docs/decisions/`
- Tickets are GitHub issues on this repo (`gh issue view <n>`).
