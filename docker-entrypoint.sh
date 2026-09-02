#!/bin/sh
set -e

# Ensure the data directory is writable by the app user — this covers
# bind-mounted volumes whose host ownership does not match uid 1001.
mkdir -p /data
chown -R app:app /data 2>/dev/null || true

# Drop privileges and run the actual command (CMD: node index.js)
exec su-exec app:app "$@"