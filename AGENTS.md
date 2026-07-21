# AGENTS

This file is the durable collaboration context for this repository. Future tools and agents should read this file first, then read `README.md`, then read `ROADMAP.md`.

## Project

- Public repo: `peteszym/obsidian-git-file-colors`
- Plugin name: `Git File Explorer Colors`
- Plugin ID: `git-file-explorer-colors`
- Scope: desktop-only, read-only, single-repo Git status coloring for Obsidian's File Explorer and editor gutter

## Product Guardrails

- Keep the plugin lightweight and focused on orientation in the File Explorer and editor gutter.
- Do not turn the plugin into a full Git client.
- Preserve the status vocabulary: `new`, `modified`, `deleted`.
- Preserve folder rollup priority: `deleted > modified > new`.
- Deleted files should normally surface as folder signals when the file row no longer exists.
- Preserve editor gutter signals: green additions, yellow modifications, and red deletion triangles.
- Favor subtle, readable colors over loud IDE-style decoration.

## Repo Conventions

- `README.md` is public-facing documentation.
- `ROADMAP.md` is the public-facing current priorities list.
- `main.js` is a release artifact and should not be committed.
- GitHub releases should upload `manifest.json`, `main.js`, and `styles.css`.
- Keep repo names and plugin IDs distinct when needed:
  - GitHub repo: `obsidian-git-file-colors`
  - Plugin ID: `git-file-explorer-colors`

## Development Commands

- `npm install`
- `npm run dev`
- `npm run build`
- `npm run check`
- `npm run test`
- `npm run validate`
- `npm run sync:scratch`

## Release Flow

1. Update `manifest.json`, `package.json`, and `versions.json` together.
2. Run `npm run validate`.
3. Create a GitHub release whose tag matches the plugin version exactly.
4. Upload `manifest.json`, `main.js`, and `styles.css` to that release.
5. Submit the plugin to `obsidianmd/obsidian-releases`.

## Private Working Notes

- Use `.workspace/` for local-only notes, prompts, scratch plans, and tool-specific working files.
- `.workspace/` is intentionally tool-agnostic so it can be used with Codex, Cursor, and other assistants.
- Nothing in `.workspace/` should be required for the public repo to function.
