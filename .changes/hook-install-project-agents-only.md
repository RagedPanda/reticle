### Fixed

- **`@reticlehq/server` — `reticle hook install` wrote hook configs for agents the project does not use.** It counted an agent as used when its folder was in your home directory, so a repository with only `.claude/` also got `.codex/hooks.json`, `.gemini/settings.json`, `.cursor/hooks.json`, `.factory/hooks.json` and `.github/hooks/reticle-prompt-capture.json`. Those files are committed, and they make each teammate's prompts run `npx`. `hook install` and `hook status` now read only the project's own folders, and the Claude Code CLI.
