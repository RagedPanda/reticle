### Security

- **`@reticlehq/server` — the Harness sent your latest prompt to the platform planner when the project said `"shareRequests": false`.** The Harness plans a drive on the platform, and the newest request in `.reticle/request.json` was one of the goals it sent. It never checked `shareRequests`, so a project that kept requests local still sent each prompt the hook captured. The Harness now sends the request only when the project shares requests and the request was captured as shared, which is the same rule a run follows.
