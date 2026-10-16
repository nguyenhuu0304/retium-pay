# External components

- The Web Wallet Connect SDK is loaded from https://wallet.retium.org/connect/sdk/retium-sdk-1.3.0.js with a pinned integrity hash. It is not bundled here.
- The public Retium RPC defaults to https://rpc.retium.org.
- `public/contracts/meme_token.wasm` is the Whisk fungible-token template used by the testnet deployment tool. It is not an original Retium Pay contract.
  - SHA-256: 14d5b587d090135f20c043e0ec0a40969b498321a5f9040f79b282ee53585122
  - BLAKE3: ee4dde4aa3942ca550e72cb260ed89118e7fe4d49ea77f67131a9594f2ca1779
- npm dependencies retain their respective licenses; versions are recorded in package-lock.json.

External project names and marks belong to their owners. Retium Pay does not claim affiliation or ownership of the network, trading contracts, SDK or third-party template.
