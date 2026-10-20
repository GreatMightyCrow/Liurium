# Liurium — Project Rules

Liurium is an open-source, local-first desktop workspace for developers on Windows 11: Markdown knowledge, projects, tasks, dashboard, search, graph navigation, and controlled coding-agent integration.

Priorities: data ownership, reliability and recoverability, security and transparent permissions, maintainable architecture, accessibility, small verifiable steps.

## Hard rules

- **No AI attribution anywhere.** Never add `Co-Authored-By` trailers, "Generated with Claude Code" lines, or similar to commits, PRs, or files.
- **No generic AI-template design.** See `Vault/Architecture/Design System.md`. No gradients, glass, glow, emoji icons, default component-library look.
- **English only** for docs, code, comments, commits, and UI text.
- **Documentation and memory live in `Vault/`** (Obsidian vault). Do not create a `docs/` folder. `Vault/` is git-ignored and must never be committed or pushed; public root docs must not link into it. Root keeps only README, CLAUDE.md, LICENSE, SECURITY, CONTRIBUTING, CHANGELOG.

## Memory

Claude's persistent memory is the Obsidian vault, not the built-in memory folder. Index (auto-loaded):

@Vault/Memory/Memory.md

Save new preferences, corrections, and working agreements as notes in `Vault/Memory/` and list them in `Memory.md`. Log each working session in `Vault/Memory/Sessions/YYYY-MM-DD.md`. Never store secrets or private data there.

## Read first

At the start of a session, read:

- `Vault/Plan/Progress.md` — current milestone, active ticket, risks
- `Vault/Tickets/Tickets.md` — workflow and index
- The active ticket in `Vault/Tickets/<milestone>/`
- `Vault/Architecture/Decisions/Decision Log.md` and relevant ADRs
- `Vault/Plan/Master Plan.md` when scope questions arise

Then inspect Git status and the relevant code, run baseline checks if feasible, and report findings before changing anything.

## Ticket workflow

- One ticket at a time. Statuses: `TODO`, `IN_PROGRESS`, `BLOCKED`, `DONE`. Sizes: `S`, `M`, `L`.
- For each ticket: verify dependencies, read acceptance criteria and security notes, inspect code, implement the smallest complete solution, add tests, run checks, review the diff, update the ticket and `Vault/Plan/Progress.md`.
- `DONE` only when acceptance criteria are verified by checks that actually ran. If a check cannot run, say so and leave the ticket open if that check is required.
- After a ticket: report and wait for approval. Never start the next ticket automatically.
- Major architecture changes, risky filesystem changes, and security decisions need a written plan and explicit approval first.

## Architecture

Decided (see ADRs): Tauri 2, Rust core, React + TypeScript + Vite, pnpm, CSS Modules + CSS custom properties, SQLite (app database in app data dir, project database in `<project>/.liurium/`), Markdown files as note source of truth, Vitest + React Testing Library, Rust tests, GitHub Actions, GPL-3.0.

- Keep UI, view logic, IPC client, commands, domain logic, and storage separate (`Vault/Architecture/Architecture Overview.md`).
- Only `src/lib/ipc` calls Tauri `invoke`. No SQL or generic file access from the frontend.
- Every schema change is a migration with tests.
- Indexes and caches must be rebuildable from source files.
- Design tokens live in one place. No raw colors, spacing, or radii elsewhere.

## Security and data integrity

- No telemetry or cloud uploads by default. No secrets in code or repository.
- Validate paths and inputs in Rust. Prevent traversal; handle symlinks, junctions, and Windows path rules explicitly.
- No shell execution from untrusted input. Treat Markdown, file names, imported content, the project database, and agent output as untrusted.
- Minimal Tauri capabilities; every permission justified in `Vault/Security/Security Model.md`.
- Never silently overwrite or delete user data. Atomic writes. Detect external changes before saving.
- No note content or secrets in logs.

## Code quality

- Check real dependency versions and official docs before using an API. Never invent APIs, CLI options, test results, or build outcomes.
- Avoid unnecessary dependencies; justify new major ones. Every dependency must be GPL-3.0 compatible.
- Do not suppress TypeScript, Rust, lint, or test errors to get a green build. No `any`, `unsafe`, or broad permissions as shortcuts.
- Keep changes inside the active ticket's scope.

## Reporting format

After each ticket: ticket ID and outcome, summary, files changed, checks actually run, results and failures, security and data-integrity notes, remaining limitations, recommended next ticket. Separate verified facts from assumptions.
