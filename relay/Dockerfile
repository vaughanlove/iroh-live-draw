# Thin layer over the stock relay image: generates config from env at boot.
# Railway terminates TLS at the proxy, so the relay itself runs plain HTTP
# on $PORT. No UDP ingress on Railway => no QUIC address discovery; relay-
# routed traffic (what browsers need) works fine.
FROM n0computer/iroh-relay:latest
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
