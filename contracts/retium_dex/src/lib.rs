#![cfg_attr(target_arch = "wasm32", no_std)]
extern crate alloc;

use alloc::{format, string::{String, ToString}, vec::Vec};
use retium_contract::{call, entrypoint, env, error, events, fail, ok, storage, Call, Reply};

entrypoint!(handle);
retium_contract::rcp_metadata!(
    r#"{"rcp_type":"dex","traits":["automated_market_maker","constant_product"],"capabilities":["swap","create_pool","add_liquidity","remove_liquidity","lp_positions","lp_lock"],"lockable_fields":[],"evolves_from":"","weight":5,"version":"v1.0.0"}"#
);

const POOL_PREFIX: &str = "pool:";
const LP_PREFIX: &str = "lp:";
const LOCK_PREFIX: &str = "lock:";
const FEE_NUM: u128 = 997;
const FEE_DEN: u128 = 1000;
const MINIMUM_LIQUIDITY: u128 = 1000;

#[derive(Clone)]
struct Pool {
    token: String,
    reserve_rtm: u128,
    reserve_token: u128,
    lp_supply: u128,
}

pub fn handle(c: Call) -> Reply {
    match c.action() {
        "init" => init(&c),
        "list_pools" => list_pools(&c),
        "get_pool" => get_pool(&c),
        "get_lp_balance" => get_lp_balance(&c),
        "swap" => swap(&c),
        "create_pool" => create_pool(&c),
        "add_liquidity" => add_liquidity(&c),
        "remove_liquidity" => remove_liquidity(&c),
        "lock_liquidity" => lock_liquidity(&c),
        other => error(&format!("unknown DEX method: {other}")),
    }
}

fn init(c: &Call) -> Reply {
    if !storage::get_or("owner", "")?.is_empty() {
        return error("DEX already initialized");
    }
    storage::set("owner", c.caller())?;
    storage::set_u128("pool_count", 0)?;
    events::emit_fields("dex_initialized", &[("owner", c.caller())])?;
    ok(c.caller())
}

fn valid_id(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn valid_wallet(value: &str) -> bool {
    value.len() == 72 && value.starts_with("rete") &&
        value[4..].bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn parse_u128(value: &str, label: &str) -> Result<u128, String> {
    if value.is_empty() || value.len() > 39 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("{label} must be a positive whole number"));
    }
    let n = value.parse::<u128>().map_err(|_| format!("{label} is too large"))?;
    if n == 0 { return Err(format!("{label} must be greater than zero")); }
    Ok(n)
}

fn pool_key(token: &str) -> String { format!("{POOL_PREFIX}{token}") }
fn lp_key(token: &str, wallet: &str) -> String { format!("{LP_PREFIX}{token}:{wallet}") }
fn lock_key(token: &str, wallet: &str) -> String { format!("{LOCK_PREFIX}{token}:{wallet}") }

fn read_pool(token: &str) -> Result<Option<Pool>, String> {
    let raw = storage::get(&pool_key(token))?;
    match raw {
        None => Ok(None),
        Some(raw) => {
            let fields: Vec<&str> = raw.split('|').collect();
            if fields.len() != 3 { return Err("corrupt pool state".into()); }
            let reserve_rtm = fields[0].parse().map_err(|_| "corrupt RTM reserve")?;
            let reserve_token = fields[1].parse().map_err(|_| "corrupt token reserve")?;
            let lp_supply = fields[2].parse().map_err(|_| "corrupt LP supply")?;
            Ok(Some(Pool { token: token.into(), reserve_rtm, reserve_token, lp_supply }))
        }
    }
}

fn save_pool(p: &Pool) -> Result<(), String> {
    storage::set(&pool_key(&p.token), &format!("{}|{}|{}", p.reserve_rtm, p.reserve_token, p.lp_supply))
}

fn sqrt(n: u128) -> u128 {
    if n < 2 { return n; }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x { x = y; y = (x + n / x) / 2; }
    x
}

fn mul_div(a: u128, b: u128, d: u128) -> Result<u128, String> {
    if d == 0 { return Err("division by zero".into()); }
    a.checked_mul(b).ok_or_else(|| "amount multiplication overflow".to_string()).map(|v| v / d)
}

fn ceil_div(a: u128, b: u128) -> Result<u128, String> {
    if b == 0 { return Err("division by zero".into()); }
    Ok(a / b + u128::from(a % b != 0))
}

fn ensure_deadline(raw: &str) -> Result<(), String> {
    let deadline = raw.parse::<i64>().map_err(|_| "invalid deadline")?;
    let now = env::block_time_ms();
    if deadline < now || deadline > now.saturating_add(20 * 60 * 1000) {
        return Err("transaction deadline expired or exceeds 20 minutes".into());
    }
    Ok(())
}

fn token_transfer_from(token: &str, from: &str, to: &str, amount: u128) {
    let reply = call::contract(token, "transfer_from", &[from, to, &amount.to_string()])
        .unwrap_or_else(|_| fail("token transfer_from call failed"));
    if call::is_error_reply(&reply) { fail("token transfer_from was refused"); }
}

fn token_transfer(token: &str, to: &str, amount: u128) {
    let reply = call::contract(token, "transfer", &[to, &amount.to_string()])
        .unwrap_or_else(|_| fail("token transfer call failed"));
    if call::is_error_reply(&reply) { fail("token transfer was refused"); }
}

fn list_pools(c: &Call) -> Reply {
    let cursor = match c.args().first() {
        Some(v) => v.parse::<usize>().map_err(|_| "invalid cursor")?,
        None => 0,
    };
    let keys = storage::keys_with_prefix(POOL_PREFIX)?;
    let mut rows: Vec<String> = Vec::new();
    let mut seen = 0usize;
    let mut next = String::from("null");
    for key in keys.iter() {
        if seen < cursor { seen += 1; continue; }
        if rows.len() == 100 { next = seen.to_string(); break; }
        let token = &key[POOL_PREFIX.len()..];
        if let Some(p) = read_pool(token)? {
            rows.push(format!(
                "{{\"token_b\":{},\"reserve_rtm\":\"{}\",\"reserve_token\":\"{}\",\"lp_supply\":\"{}\"}}",
                events::json_string(&p.token), p.reserve_rtm, p.reserve_token, p.lp_supply
            ));
            seen += 1;
        }
    }
    ok(&format!("{{\"pools\":[{}],\"next\":{}}}", rows.join(","), next))
}

fn get_pool(c: &Call) -> Reply {
    let token = c.arg(0)?;
    if !valid_id(token) { return error("invalid token contract id"); }
    let p = match read_pool(token)? { Some(p) => p, None => return error("Pool not found") };
    ok(&format!(
        "{{\"token_b\":{},\"reserve_rtm\":\"{}\",\"reserve_token\":\"{}\",\"lp_supply\":\"{}\"}}",
        events::json_string(&p.token), p.reserve_rtm, p.reserve_token, p.lp_supply
    ))
}

fn get_lp_balance(c: &Call) -> Reply {
    let token = c.arg(0)?;
    let wallet = c.arg(1)?;
    if !valid_id(token) || !valid_wallet(wallet) { return error("invalid token or wallet"); }
    let lp = storage::get_u128(&lp_key(token, wallet))?;
    let locked = storage::get_u128(&lock_key(token, wallet))?;
    let until = storage::get_or(&format!("until:{token}:{wallet}"), "0")?;
    ok(&format!("{{\"lp_balance\":\"{lp}\",\"locked\":\"{locked}\",\"until_ms\":{until}}}"))
}

fn swap(c: &Call) -> Reply {
    let token = c.arg(0)?;
    let amount = parse_u128(c.arg(1)?, "amount")?;
    let direction = c.arg(2)?;
    let min_out = parse_u128(c.arg(3)?, "minimum output")?;
    ensure_deadline(c.arg(4)?).map_err(|e| e.to_string())?;
    if !valid_id(token) { return error("invalid token contract id"); }
    let mut p = match read_pool(token)? { Some(p) => p, None => return error("Pool not found") };
    let (reserve_in, reserve_out, input_is_rtm) = match direction {
        "RTM_TO_TOKEN" => (p.reserve_rtm, p.reserve_token, true),
        "TOKEN_TO_RTM" => (p.reserve_token, p.reserve_rtm, false),
        _ => return error("invalid swap direction"),
    };
    let amount_fee = amount.checked_mul(FEE_NUM).ok_or("amount overflow")?;
    let out = mul_div(amount_fee, reserve_out, reserve_in.checked_mul(FEE_DEN).ok_or("reserve overflow")?.checked_add(amount_fee).ok_or("reserve overflow")?)?;
    if out == 0 || out < min_out || out >= reserve_out { return error("slippage exceeded or insufficient liquidity"); }
    if input_is_rtm {
        if c.value() != amount { return error("attached RTM must equal swap input"); }
        p.reserve_rtm = p.reserve_rtm.checked_add(amount).ok_or("reserve overflow")?;
        p.reserve_token = p.reserve_token.checked_sub(out).ok_or("reserve underflow")?;
        save_pool(&p)?;
        let reply = call::contract(token, "transfer", &[c.caller(), &out.to_string()])?;
        if call::is_error_reply(&reply) { fail("token payout refused"); }
    } else {
        if c.value() != 0 { return error("do not attach RTM to token-to-RTM swap"); }
        token_transfer_from(token, c.caller(), &env::contract_id()?, amount);
        p.reserve_token = p.reserve_token.checked_add(amount).ok_or("reserve overflow")?;
        p.reserve_rtm = p.reserve_rtm.checked_sub(out).ok_or("reserve underflow")?;
        save_pool(&p)?;
        let reply = call::send_rtm(c.caller(), out)?;
        if call::is_error_reply(&reply) { fail("RTM payout refused"); }
    }
    events::emit_fields("swap", &[("trader", c.caller()), ("token", token), ("direction", direction), ("input", &amount.to_string()), ("output", &out.to_string())])?;
    ok(&out.to_string())
}

fn create_pool(c: &Call) -> Reply {
    let token = c.arg(0)?;
    let amount_rtm = parse_u128(c.arg(1)?, "RTM amount")?;
    let amount_token = parse_u128(c.arg(2)?, "token amount")?;
    if !valid_id(token) { return error("invalid token contract id"); }
    if c.value() != amount_rtm { return error("attached RTM must equal initial RTM deposit"); }
    if read_pool(token)?.is_some() { return error("pool already exists"); }
    let product = amount_rtm.checked_mul(amount_token).ok_or("initial liquidity overflow")?;
    let root = sqrt(product);
    let minted = root.checked_sub(MINIMUM_LIQUIDITY).ok_or("initial liquidity is too small")?;
    if minted == 0 { return error("initial liquidity is too small"); }
    token_transfer_from(token, c.caller(), &env::contract_id()?, amount_token);
    let p = Pool { token: token.into(), reserve_rtm: amount_rtm, reserve_token: amount_token, lp_supply: root };
    save_pool(&p)?;
    storage::set_u128(&lp_key(token, c.caller()), minted)?;
    storage::set_u128(&format!("{LP_PREFIX}{token}:locked_permanently"), MINIMUM_LIQUIDITY)?;
    storage::add_u128("pool_count", 1)?;
    events::emit_fields("pool_created", &[("creator", c.caller()), ("token", token), ("rtm", &amount_rtm.to_string()), ("token_amount", &amount_token.to_string()), ("lp_minted", &minted.to_string())])?;
    ok(&minted.to_string())
}

fn add_liquidity(c: &Call) -> Reply {
    let token = c.arg(0)?;
    let amount_rtm = parse_u128(c.arg(1)?, "RTM amount")?;
    let max_token = parse_u128(c.arg(2)?, "maximum token amount")?;
    let min_lp = parse_u128(c.arg(3)?, "minimum LP shares")?;
    ensure_deadline(c.arg(4)?).map_err(|e| e.to_string())?;
    if !valid_id(token) { return error("invalid token contract id"); }
    if c.value() != amount_rtm { return error("attached RTM must equal liquidity deposit"); }
    let mut p = match read_pool(token)? { Some(p) => p, None => return error("Pool not found") };
    if p.reserve_rtm == 0 || p.reserve_token == 0 || p.lp_supply == 0 { return error("invalid pool reserves"); }
    let token_amount = ceil_div(amount_rtm.checked_mul(p.reserve_token).ok_or("amount overflow")?, p.reserve_rtm)?;
    if token_amount > max_token { return error("token maximum exceeded"); }
    let lp_a = mul_div(amount_rtm, p.lp_supply, p.reserve_rtm)?;
    let lp_b = mul_div(token_amount, p.lp_supply, p.reserve_token)?;
    let minted = core::cmp::min(lp_a, lp_b);
    if minted == 0 || minted < min_lp { return error("minimum LP shares not met"); }
    token_transfer_from(token, c.caller(), &env::contract_id()?, token_amount);
    p.reserve_rtm = p.reserve_rtm.checked_add(amount_rtm).ok_or("reserve overflow")?;
    p.reserve_token = p.reserve_token.checked_add(token_amount).ok_or("reserve overflow")?;
    p.lp_supply = p.lp_supply.checked_add(minted).ok_or("LP supply overflow")?;
    save_pool(&p)?;
    storage::add_u128(&lp_key(token, c.caller()), minted)?;
    events::emit_fields("liquidity_added", &[("provider", c.caller()), ("token", token), ("rtm", &amount_rtm.to_string()), ("token_amount", &token_amount.to_string()), ("lp_minted", &minted.to_string())])?;
    ok(&minted.to_string())
}

fn remove_liquidity(c: &Call) -> Reply {
    let token = c.arg(0)?;
    let shares = parse_u128(c.arg(1)?, "LP shares")?;
    let min_rtm = parse_u128(c.arg(2)?, "minimum RTM")?;
    let min_token = parse_u128(c.arg(3)?, "minimum token")?;
    ensure_deadline(c.arg(4)?).map_err(|e| e.to_string())?;
    if !valid_id(token) { return error("invalid token contract id"); }
    if c.value() != 0 { return error("do not attach RTM to liquidity removal"); }
    let mut p = match read_pool(token)? { Some(p) => p, None => return error("Pool not found") };
    let key = lp_key(token, c.caller());
    let balance = storage::get_u128(&key)?;
    let locked = storage::get_u128(&lock_key(token, c.caller()))?;
    if shares > balance.saturating_sub(locked) { return error("not enough unlocked LP shares"); }
    let out_rtm = mul_div(p.reserve_rtm, shares, p.lp_supply)?;
    let out_token = mul_div(p.reserve_token, shares, p.lp_supply)?;
    if out_rtm < min_rtm || out_token < min_token || out_rtm == 0 || out_token == 0 { return error("minimum withdrawal not met"); }
    storage::sub_u128(&key, shares)?;
    p.reserve_rtm = p.reserve_rtm.checked_sub(out_rtm).ok_or("reserve underflow")?;
    p.reserve_token = p.reserve_token.checked_sub(out_token).ok_or("reserve underflow")?;
    p.lp_supply = p.lp_supply.checked_sub(shares).ok_or("LP supply underflow")?;
    save_pool(&p)?;
    let token_reply = call::contract(token, "transfer", &[c.caller(), &out_token.to_string()])?;
    if call::is_error_reply(&token_reply) { fail("token payout refused"); }
    let rtm_reply = call::send_rtm(c.caller(), out_rtm)?;
    if call::is_error_reply(&rtm_reply) { fail("RTM payout refused"); }
    events::emit_fields("liquidity_removed", &[("provider", c.caller()), ("token", token), ("lp_burned", &shares.to_string()), ("rtm", &out_rtm.to_string()), ("token_amount", &out_token.to_string())])?;
    ok(&format!("{out_rtm}|{out_token}"))
}

fn lock_liquidity(c: &Call) -> Reply {
    let token = c.arg(0)?;
    let total = parse_u128(c.arg(1)?, "locked LP total")?;
    let until_raw = c.arg(2)?;
    if !valid_id(token) || read_pool(token)?.is_none() { return error("pool not found"); }
    if c.value() != 0 { return error("do not attach RTM to LP lock"); }
    let until = until_raw.parse::<i64>().map_err(|_| "invalid lock timestamp")?;
    let now = env::block_time_ms();
    if until != -1 && (until <= now || until > now.saturating_add(3650_i64 * 86_400_000)) {
        return error("lock must be between now and ten years, or -1 for permanent");
    }
    let balance = storage::get_u128(&lp_key(token, c.caller()))?;
    let old_locked = storage::get_u128(&lock_key(token, c.caller()))?;
    let old_until = storage::get_or(&format!("until:{token}:{}", c.caller()), "0")?.parse::<i64>().map_err(|_| "corrupt lock state")?;
    if total < old_locked || total > balance { return error("locked LP total must be between existing lock and LP balance"); }
    if old_locked > 0 && (old_until == -1 || (until != -1 && until < old_until)) {
        return error("an active LP lock cannot be shortened");
    }
    storage::set_u128(&lock_key(token, c.caller()), total)?;
    storage::set(&format!("until:{token}:{}", c.caller()), &until.to_string())?;
    events::emit_fields("liquidity_locked", &[("owner", c.caller()), ("token", token), ("locked", &total.to_string()), ("until_ms", &until.to_string())])?;
    ok(&format!("{total}|{until}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_product_quote_matches_the_frontend_fee_model() {
        let input = 100u128;
        let reserve_in = 1_000u128;
        let reserve_out = 2_000u128;
        let amount_with_fee = input * FEE_NUM;
        let out = amount_with_fee * reserve_out / (reserve_in * FEE_DEN + amount_with_fee);
        assert_eq!(out, 181);
    }

    #[test]
    fn square_root_is_floor_and_handles_edges() {
        assert_eq!(sqrt(0), 0);
        assert_eq!(sqrt(1), 1);
        assert_eq!(sqrt(15), 3);
        assert_eq!(sqrt(16), 4);
        assert_eq!(sqrt(17), 4);
    }

    #[test]
    fn ceil_div_never_rounds_token_deposit_down() {
        assert_eq!(ceil_div(10, 3).unwrap(), 4);
        assert_eq!(ceil_div(9, 3).unwrap(), 3);
    }

    #[test]
    fn checked_mul_div_rejects_overflow_and_zero_denominator() {
        assert!(mul_div(u128::MAX, 2, 1).is_err());
        assert!(mul_div(10, 10, 0).is_err());
        assert_eq!(mul_div(100, 25, 10).unwrap(), 250);
    }
}
