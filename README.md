# promtable-uptime

Public $0 uptime probe for https://promtable.com (every 15 min). Opens an `outage` issue on failure and closes it on recovery.
Source of truth: `scripts/uptime-check.mjs` and `ops/uptime-sidecar.yml` in the private promtable repo.
