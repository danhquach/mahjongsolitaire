# Workflow rules (mandatory)

- **One branch per ticket.** Never commit work directly to `main`. For each GitHub issue, create a branch first: `issue-<n>-<short-slug>` (e.g. `issue-2-core-engine`).
- **Branch review before merge.** When pushing a branch, run a code review of the full branch diff (`main..HEAD`) — correctness, tests, and the repo's spec/roadmap acceptance criteria for that ticket.
- **Close the ticket when done.** After the work is merged (or the deliverable is accepted), close the GitHub issue with a closing comment linking the merge commit/PR.
- **Merge only when all green.** Merge to `main` only when: review findings are resolved, all tests/CI pass, and the ticket's acceptance criteria are met. No self-merge over open findings.

# Communication

- Default reply style: brief. Lead with the recommendation, a few bullets max, no walls of text; detail goes in docs, not chat.
- Wait for explicit confirmation before committing/pushing work.

# Identity

- Commit as `Daniel Quach <danielq.engineer@gmail.com>` (repo-local git config, already set).

# Project docs

- Spec: `mahjong-solitaire-spec.md` · Roadmap: `ROADMAP.md` · Decisions: `docs/decisions/`
- Tickets are GitHub issues on this repo (`gh issue view <n>`).
