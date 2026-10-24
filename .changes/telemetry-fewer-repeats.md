### Changed

- **`@reticlehq/server` — telemetry no longer repeats the same fact.** The `flow_recorded` setup step goes out once per daemon for each outcome, not at every browser session end. The HUD reports a page view and a sign-in ask once per daemon, not once per tab, and the Agent Log that the HUD opens by itself is not a view. A page that reloads in a loop no longer sends a new event at each reload.
