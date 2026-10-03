import { defineRailway, github, project, service } from "railway/iac";

// enchanting-gratitude production: iroh relay only (client-side mesh
// transport for ephemeral traffic + gossip). Durable truth moved to the
// celld fleet (see cells/); the keeper watch peer is retired. No Cloudflare
// in this path: relay + app traffic stay on Railway / exe.dev.
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

  return project("enchanting-gratitude", {
    resources: [relay],
  });
});
