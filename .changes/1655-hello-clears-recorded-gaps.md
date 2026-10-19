### Fixed

- **`@reticlehq/server` — `reticle doctor` kept "no store" and "no signal" after the app registered them.** A gap that a verdict recorded before the app registered its store stayed for the life of the daemon, because a reload keeps the session id. The capability stayed "missing" and the Harness stayed locked. A fresh HELLO from the page now drops the gaps recorded before it. A repeat HELLO on the same connection now also updates the channels the page announces, so a store that registers late makes app state seen. Closes [#1655](https://github.com/reticlehq/reticle/issues/1655).
