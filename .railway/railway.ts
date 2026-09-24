import { defineRailway, github, project, service } from "railway/iac";

// enchanting-gratitude production: iroh relay + keeper watch peer.
// One repo, two services, each built from its own Dockerfile.
export default defineRailway(() => {
  const relay = service("relay", {
    source: github("vaughanlove/iroh-live-draw", {
      branch: "master",
      rootDirectory: "relay",
    }),
    healthcheck: "/healthz",
  });

  const keeper = service("keeper", {
    source: github("vaughanlove/iroh-live-draw", {
      branch: "master",
    }),
    // Root Dockerfile (Nixpacks drops the binary from the runtime image).
    healthcheck: "/healthz",
    env: {
      // Railway injects PORT; keeper binds it when LISTEN is unset (see main.rs).
      // RELAY_URL + KEEPER_TOKEN are set after the first deploy, once the
      // relay domain exists:
      //   RELAY_URL=https://<relay-domain>
      //   KEEPER_TOKEN=<shared secret, also VITE_KEEPER_TOKEN on Pages>
      KEEPER_DATA: "/data",
      MAX_TOPICS: "100",
    },
  });

  return project("enchanting-gratitude", {
    resources: [relay, keeper],
  });
});
