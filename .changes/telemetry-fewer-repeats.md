### Changed

- **`@reticlehq/server` — telemetry no longer repeats the same fact.** The `flow_recorded` setup step goes out once per daemon for each outcome, not at every browser session end. A page that reloads in a loop no longer sends a new event at each reload.
