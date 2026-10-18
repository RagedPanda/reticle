### Fixed

- **`@reticlehq/server` — the agent now reads what the Harness failed, word for word.** The platform failed the broken checkout with "POST /api/orders sent promoCode missing, the claim says SAVE20; totalCents 16700, the claim says 13360", and the dashboard showed it. The agent's `reticle_verify { action: "explore" }` answer said only "NOT PROVED", because a plan run's driver account was left out. The answer now carries each such line in `findings` and in `summary`, and the fix request quotes them.
