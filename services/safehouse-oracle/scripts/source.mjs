export const ASSET = 'c1d3885930a23a099e28e6f55f8ee8d8908902b57a7ef9d28de6756819d5611c';
export const RPC = 'https://rpc.retium.org';
export const RATE = '1000000000000000000';
export function validateSafehouse(s) {
  if (s?.safehouse !== 'rete_safehouse' || s.rusd_contract_id !== ASSET || s.rusd_deployed !== true)
    throw Error('SAFEHOUSE_IDENTITY_MISMATCH');
  const integer = k => {
    if (typeof s[k] !== 'string' || !/^\d{1,39}$/.test(s[k])) throw Error('INVALID_SAFEHOUSE_AMOUNT');
    return BigInt(s[k]);
  };
  const inventory=integer('inventory_atomic'), locked=integer('locked_atomic'), released=integer('released_atomic'), burned=integer('burned_atomic'), total=integer('total_supply_atomic');
  if (total !== 1000000000n*10n**18n || inventory<=0n || inventory>total || released>total || burned>released || locked<released-burned)
    throw Error('SAFEHOUSE_REFERENCE_UNAVAILABLE');
  // This checks protocol reserve figures, not off-chain fiat reserves.
  return RATE;
}
export async function readJson(path) {
  const r=await fetch(RPC+path,{redirect:'error',cache:'no-store',headers:{Accept:'application/json','Cache-Control':'no-cache'},signal:AbortSignal.timeout(15000)});
  if(!r.ok || !r.headers.get('content-type')?.includes('application/json')) throw Error('SOURCE_HTTP_UNAVAILABLE');
  const date=Date.parse(r.headers.get('date')||'');
  const age=r.headers.get('age');
  if(!Number.isFinite(date)||Math.abs(Date.now()-date)>60000 || (age!==null && (!/^\d+$/.test(age)||Number(age)>30))) throw Error('SOURCE_RESPONSE_NOT_FRESH');
  const raw=await r.text(); if(raw.length>1000000) throw Error('SOURCE_TOO_LARGE');
  return JSON.parse(raw);
}
