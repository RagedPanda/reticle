### Fixed

- **`@reticlehq/server` — a replay that never reached its first step synced as a failed run.** "Run again" on a saved flow whose step 1 control was not on the page (for example, a task the fresh page does not have) clicked nothing, but the run read FAIL. Runs and the Inbox then showed a failure for a journey that was never tested. Such a replay is now `unverifiable` with the reason "did not reach step N (…)", and syncs as a skipped flow. The step keeps its index and its drift reason kind. A step that ran and whose expectation did not hold is still a failure.
