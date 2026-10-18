# Undertale Web

A browser host for your own installed Undertale game data, using the open-source Butterscotch GameMaker runner compiled to WebAssembly.

Work in progress. The goal is full original-game playability, persistent browser saves, and an observable keyboard interface for AI agents. No Undertale assets or game code are distributed by this repository.

## Development

Windows is the primary development environment. Runtime integration, local importer, and exact launch instructions are being added. See [project status](planning/STATUS.md) for verified progress and limitations.

## Boundaries

- Original installation is read-only.
- Game assets and extracted game content remain local and excluded from Git.
- Browser gameplay uses the original bytecode through a compatible runner; this is not a recreation of a few scenes.
- Full-route completion and parity must be demonstrated before being claimed.
- Authored JavaScript uses both requested `@notmike101/eslint-config-js` and `@notmike101/eslint-config-jsdoc` configurations, with zero warnings required.
