### Fixed

- **`@reticlehq/server` — a leased session was warned that its runs went to `~/.reticle/unmatched/` even when the lease claimed a project root.** The warning named a folder the run never used and sent the agent to fix a problem that did not exist. A claimed root now suppresses the unmatched warning. Closes [#1773](https://github.com/reticlehq/reticle/issues/1773).
