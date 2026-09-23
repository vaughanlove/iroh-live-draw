#!/bin/sh
# Render the relay config from the environment and run it.
# Required: PORT (set by Railway). No TLS section: the proxy terminates it.
set -eu
PORT="${PORT:-8080}"
cat > /tmp/iroh-relay.toml <<EOF
# generated at container start; see relay/Dockerfile
http_bind_addr = "[::]:${PORT}"
EOF
exec /iroh-relay --config-path /tmp/iroh-relay.toml
