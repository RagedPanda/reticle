### Fixed

- **`@reticlehq/server` — a prompt that started with a tag, such as `<Button> must be disabled`, was not captured.** The prompt hook skipped every prompt that started with a tag, to skip the prompts an agent harness writes for itself. A front-end request often starts with a component name in a tag, so those requests were lost. The hook now skips only the harness's own tags, such as `<system-reminder>`, `<task-notification>` and `<command-name>`.
