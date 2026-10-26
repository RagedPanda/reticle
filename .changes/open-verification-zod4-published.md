### Fixed

- **`@reticlehq/core`, `@reticlehq/engine`, `@reticlehq/server` — 3.8.1 could not record a verdict.** Every run 3.8.1 built or read failed with `Invalid element at key "subject": expected a Zod schema`. `open-verification` moved to zod 4 in the repository but kept its version, 1.0.0, so the release skipped it and core 3.8.1 pinned the zod 3 build already on npm. `open-verification` is now 1.1.0, and the publish refuses any package whose dependencies changed under a version already on npm (`scripts/check-unbumped-packages.mjs`).
