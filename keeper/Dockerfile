# Keep the runtime small; build the keeper binary in a separate stage.
# (The whole workspace must be present for Cargo to resolve it, but only
# the keeper binary gets built and shipped.)
FROM rust:1-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY shared ./shared
COPY browser-wasm ./browser-wasm
COPY keeper ./keeper
RUN cargo build --release -p keeper

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/target/release/keeper /keeper
WORKDIR /data
ENV LISTEN=0.0.0.0:8081 KEEPER_DATA=/data
EXPOSE 8081
ENTRYPOINT ["/keeper"]
