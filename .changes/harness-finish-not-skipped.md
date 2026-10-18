### Fixed

- **`@reticlehq/server` — a Harness drive no longer calls its goal met because the page shows the goal's end text.** When the page showed the quoted end after a check held, the drive stopped on its own before the model's `finish`. That skipped the platform's last check on the drive's own writes. On a broken checkout the page said "charged $133.60" while the order went out at full price, and the drive reported the goal met. The drive now tells the model to finish and keeps the verdict that finish gives. The step budget bounds a model that does not finish.
