# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Tauri 2 application scaffold with React and TypeScript.
- Security baseline: no Tauri permissions, strict Content Security Policy, frozen JavaScript prototypes, developer tools only in debug builds.
- Lint, format, typecheck, and test tooling, run together with `pnpm check`.
- Continuous integration on Windows.
- Design tokens and CSS foundation: dark color palette, spacing, radius, shadow, and motion scales, with tests for color contrast and for raw values outside the tokens.
- Bundled fonts Atkinson Hyperlegible Next (interface) and Atkinson Hyperlegible Mono (code), and a type scale.
