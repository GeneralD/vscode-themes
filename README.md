# VSCode Themes

A collection of custom VSCode color themes.

## Themes

| Theme | Description |
|-------|-------------|
| **Cyberpunk Neon** | Neon pink, cyan, and purple cyberpunk-inspired dark theme |
| **KOKO 幸祜** | Elegant rose pink and lavender dark theme with a translucent feel |

## Setup

```bash
pnpm install
```

Requires the `code` CLI: In VSCode, press `Cmd+Shift+P` → "Shell Command: Install 'code' command in PATH"

## Commands

```bash
# Build all themes (merge + package)
pnpm build

# Build + install to VSCode
pnpm install-themes
```

## Adding a New Theme

Use the `/vscode-theme` skill in Claude Code to generate a new theme, then register it in `pnpm-workspace.yaml`.
