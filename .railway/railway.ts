import { defineRailway, github, preserve, project, service } from "railway/iac";

// enchanting-gratitude production: iroh relay + keeper watch peer.
// One repo, two services, each built from its own Dockerfile.
export default defineRailway(() => {
  const relay = service("relay", {
    source: github("vaughanlove/iroh-live-draw", {
      branch: "master",
      rootDirectory: "relay",
    }),
    healthcheck: "/healthz",
    // Free plan mandates serverless (sleep on idle); unset fails deploys.
    deploy: { sleepApplication: true },
  });

  const keeper = service("keeper", {
    source: github("vaughanlove/iroh-live-draw", {
      branch: "master",
    }),
    // Root Dockerfile (Nixpacks drops the binary from the runtime image).
    healthcheck: "/healthz",
    // Free plan mandates serverless (sleep on idle); unset fails deploys.
    deploy: { sleepApplication: true },
    env: {
      // Railway injects PORT; keeper binds it when LISTEN is unset (see main.rs).
      RELAY_URL: "https://relay-production-61c3.up.railway.app",
      // Shared secret, also VITE_KEEPER_TOKEN on Pages. Value lives only in
      // Railway — never committed.
      KEEPER_TOKEN: preserve(),
      KEEPER_DATA: "/data",
      MAX_TOPICS: "100",
    },
  });

  return project("enchanting-gratitude", {
    resources: [relay, keeper],
  });
});
