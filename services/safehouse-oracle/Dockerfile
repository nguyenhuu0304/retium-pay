# Retium CLI from the same reviewed SDK revision used by the existing testnet flow.
FROM rust:1.90-bookworm AS cli
RUN apt-get update && apt-get install -y --no-install-recommends git pkg-config libssl-dev ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /build/sdk
RUN git init && git remote add origin https://github.com/Retium-Org/retium-sdk.git && git fetch --depth 1 origin 09f27815236946d67a9be5984504a5bcdf8cb7cd && git checkout --detach FETCH_HEAD
RUN cargo build --release --locked -p retium-sdk --bin retium

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=cli /build/sdk/target/release/retium /usr/local/bin/retium
WORKDIR /app
COPY scripts/ ./scripts/
# Probe is the default; a new service cannot start signing merely by being deployed.
ENV RETIUM_ORACLE_MODE=probe
CMD ["node", "scripts/cloud-entry.mjs"]
