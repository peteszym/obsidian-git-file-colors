#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_ID="git-file-explorer-colors"
SCRATCH_VAULT_DIR="$ROOT_DIR/tmp/scratch-vault"
PLUGIN_DIR="$SCRATCH_VAULT_DIR/.obsidian/plugins/$PLUGIN_ID"
LEGACY_PLUGIN_DIR="$SCRATCH_VAULT_DIR/.obsidian/plugins/obsidian-git-file-colors"

mkdir -p "$PLUGIN_DIR"

cp "$ROOT_DIR/manifest.json" "$PLUGIN_DIR/manifest.json"
cp "$ROOT_DIR/main.js" "$PLUGIN_DIR/main.js"
cp "$ROOT_DIR/styles.css" "$PLUGIN_DIR/styles.css"

echo "Synced plugin files to $PLUGIN_DIR"

if [[ -d "$LEGACY_PLUGIN_DIR" ]]; then
  echo "Note: legacy plugin folder still exists at $LEGACY_PLUGIN_DIR"
fi
