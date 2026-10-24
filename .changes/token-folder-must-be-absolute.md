### Fixed

- **`@reticlehq/server`, `@reticlehq/vite-plugin`, `@reticlehq/next` — a pairing token folder that is not an absolute path is no longer used.** A relative folder is made inside the folder the process runs in, which is often the project. A Windows-style path such as `C:\Users\me\.reticle`, read by a POSIX Node (WSL, a container), is relative there. Reticle now refuses such a folder and names `RETICLE_PAIRING_TOKEN_DIR` in the message. The build plugins start the dev server without a token in that case.
