# Roadmap

## Current Status

The v1 plugin is implemented and working locally:

- Git status is normalized to `new`, `modified`, and `deleted`
- File rows are colored from direct Git status
- Folder rows roll up descendant status with `deleted > modified > new`
- Refresh runs on vault events, a fallback timer, and a manual command
- Minimal settings exist for file coloring, folder coloring, colors, and refresh interval

## Next Up

- Create the first public commit for this repo
- Publish the repository at `peteszym/obsidian-git-file-colors`
- Create the `1.0.0` GitHub release
- Upload `manifest.json`, `main.js`, and `styles.css` as release assets
- Submit the plugin to the Obsidian Community Plugins directory

## Soon

- Dogfood the plugin in a real vault for a few days
- Watch for performance issues in large folders
- Tighten any remaining edge cases around rename, delete, and external Git refresh behavior

## Later Ideas

- Optional icon tinting if text-only color feels too subtle
- Additional UI polish for different Obsidian themes
- Broader automated coverage around File Explorer DOM matching
- Performance profiling for very large vaults

## Non-Goals For v1

- Staging or committing inside Obsidian
- Diff viewer
- Conflict resolution UI
- Mobile support
- Multi-repo support inside one vault
