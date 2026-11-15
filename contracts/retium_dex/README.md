# Retium DEX (Rust/WASM)

This is the first Rust implementation of the DEX contract expected by Retium Pay.

## Methods exposed

- `list_pools([cursor])`
- `get_pool(token_id)`
- `get_lp_balance(token_id, wallet)`
- `swap(token_id, amount, direction, min_out, deadline_ms)`
- `create_pool(token_id, rtm_amount, token_amount)`
- `add_liquidity(token_id, rtm_amount, max_token, min_lp, deadline_ms)`
- `remove_liquidity(token_id, lp_shares, min_rtm, min_token, deadline_ms)`
- `lock_liquidity(token_id, total_locked_lp, until_ms)`

Token inputs use RCP-1 `transfer_from`; RTM input is attached to the signed call. Token payouts use RCP-1 `transfer`; RTM payouts come from the DEX contract's own balance.

## Build and test

From the repository root:

```powershell
cargo test --manifest-path contracts/retium_dex/Cargo.toml
cargo build --release --target wasm32-unknown-unknown --manifest-path contracts/retium_dex/Cargo.toml
```

Then inspect the exact artifact with:

```powershell
retium deploy target/wasm32-unknown-unknown/release/retium_dex.wasm --dry-run
```

Do not deploy or enable the DApp until tests pass, the dry-run passes, and the contract has been reviewed against the current token implementation and Retium RPC behavior.

## Important implementation notes

- Swap fee is 0.3%, matching the current Retium Pay quote model.
- The contract uses chain block time for deadlines and LP locks. Expired finite locks no longer block withdrawals; permanent locks remain locked.
- Every cross-contract token transfer checks for an error reply and traps on refusal so the whole transaction rolls back.
- The first 1,000 LP units are permanently excluded from user balances as minimum liquidity.
- No initializer is required: the DEX has no privileged owner-only actions, avoiding a public first-caller initialization race.
- This code has passed local Cargo test/build once, but the latest review changes still need a fresh local test/build and a Retium dry-run. Treat it as review code, not deployable production code.
