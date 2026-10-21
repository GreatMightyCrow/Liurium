# Contributing to Liurium

Liurium is pre-alpha. Before starting larger work, open an issue so we can agree on the approach first. To report a security problem, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Development setup

Liurium targets Windows 11. You need:

| Tool                                                      | Notes                                                                       |
| --------------------------------------------------------- | --------------------------------------------------------------------------- |
| Microsoft C++ Build Tools, "Desktop development with C++" | Linker and Windows SDK for Rust. The Visual Studio IDE is not required.     |
| Rust via [rustup](https://rustup.rs)                      | The version is pinned in `rust-toolchain.toml`; rustup installs it for you. |
| WebView2 runtime                                          | Preinstalled on Windows 11.                                                 |
| Node.js 24 LTS                                            |                                                                             |
| pnpm, the version from `packageManager` in `package.json` | `npm install --global pnpm@12.14.0`                                         |
| Git                                                       |                                                                             |

Then, from the repository root:

```powershell
pnpm install     # install dependencies
pnpm tauri dev   # run the app with hot reload
pnpm check       # run all checks
```

## Checks

`pnpm check` runs these in order and stops at the first failure. CI runs the same steps on Windows, plus a release build.

| Command             | Checks                                                        |
| ------------------- | ------------------------------------------------------------- |
| `pnpm lint`         | ESLint with type-aware TypeScript rules and React hooks rules |
| `pnpm format:check` | Prettier formatting (`pnpm format` fixes it)                  |
| `pnpm typecheck`    | TypeScript                                                    |
| `pnpm test`         | Vitest with React Testing Library                             |
| `pnpm check:rust`   | `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` |

Do not disable a lint rule or test to get a green build. If a rule really has to be disabled, add a comment explaining why.

## Changes

- Keep pull requests small and focused on one thing. Open them against `dev`; `main` only receives tested merges from `dev`.
- Add or update tests for behavior you change.
- Write code, comments, documentation, commit messages, and UI text in English.
- New dependencies need a reason and a license compatible with GPL-3.0-only.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) in the imperative: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `ci:`.

### Security-sensitive changes

The app starts from least privilege: the webview has no Tauri permissions and a strict Content Security Policy. A pull request that adds a permission, a plugin, or a CSP exception must explain why the feature needs it. `src-tauri/tests/security_baseline.rs` fails until the new permission is added to its reviewed list.

## License

Liurium is licensed under GPL-3.0-only. By contributing, you agree that your contribution is licensed under the same terms.
