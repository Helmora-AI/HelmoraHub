# Controlled cloudflared Startup Update

**Date:** 2026-07-15
**Status:** Approved design
**Surface:** HelmoraHub Pterodactyl startup

## Objective

Keep the Hub-managed `cloudflared` binary current during controlled
Pterodactyl restarts without turning a transient update failure into a Hub
outage.

## Design

`scripts/ptero-startup.sh` checks for the Hub-managed binary at
`$DATA_DIR/bin/cloudflared` after the runtime data directory exists and before
the production build starts.

- If the binary is absent, startup skips the update. The existing tunnel
  runtime downloads Cloudflare's latest GitHub binary when it first needs one.
- If the binary exists, startup logs its current version and invokes
  `cloudflared update` with a 120-second bound when the system `timeout` command
  is available.
- A successful update logs the resulting version.
- An update failure or timeout emits a warning and startup continues with the
  existing validated binary.
- `CLOUDFLARED_AUTO_UPDATE=0` or `false` disables the startup update. It is
  enabled by default for the Hub-managed GitHub binary.

The tunnel process retains `--no-autoupdate`. Updates therefore happen only at
the explicit restart boundary, before the connector begins serving traffic.

## Package-managed Binaries

The startup updater does not run `apt`, `yum`, or another privileged package
manager and does not modify a `cloudflared` found only on `PATH`. Cloudflare
requires package-managed installations to be updated through their original
package manager. Helmora's managed binary is downloaded directly from the
official GitHub release URL and supports `cloudflared update`.

## Failure and Security Boundaries

- The updater never receives the tunnel token.
- Update output may be logged, but credentials and environment values are not.
- Network unavailability, GitHub unavailability, read-only storage, and updater
  errors are non-fatal.
- The existing binary remains the rollback path when an update cannot complete.
- Startup continues to validate and launch the tunnel through the existing
  runtime manager.

## Verification

- A shell-level regression test proves an existing managed binary receives the
  `update` command.
- Tests prove the opt-out and missing-binary paths do not invoke an update.
- Tests prove an updater failure does not terminate startup.
- `bash -n scripts/ptero-startup.sh`, the focused startup tests, Hub typecheck,
  and production build must pass.

## Documentation

The Pterodactyl deployment guide documents the default controlled update, the
opt-out variable, and why package-managed binaries are excluded.

## Official Sources

- <https://developers.cloudflare.com/tunnel/downloads/update-cloudflared/>
- <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/tunnel-useful-commands/>
