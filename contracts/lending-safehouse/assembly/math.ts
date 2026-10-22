import { u128, u256 } from "as-bignum/assembly";
export const ZERO = u128.Zero;
export const ONE = u128.One;
export const UNIT = u128.fromString("1000000000000000000");
export const CAP = u128.fromString("1000000000000000000000000000"); // one billion tokens at 18 decimals
export function add(a:u128,b:u128):u128 { const c=a+b; if(c<a) unreachable(); return c; }
export function sub(a:u128,b:u128):u128 { if(b>a) unreachable(); return a-b; }
export function strict(s:string):u128 {
  if(s.length==0||s.length>39) unreachable();
  let n=ZERO;
  for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);if(c<48||c>57)unreachable();const d=u128.fromU32(c-48);if(n>(u128.Max-d)/u128.fromU32(10))unreachable();n=n*u128.fromU32(10)+d;}
  return n;
}
// Full 128x128 product, 256-step division. Never truncate an intermediate product.
export function mulDiv(a:u128,b:u128,d:u128,ceil:bool=false):u128 {
  if(d==ZERO)unreachable();
  const product=u256.fromU128(a)*u256.fromU128(b), divisor=u256.fromU128(d);
  let rem=u256.Zero,lo:u64=0,hi:u64=0;
  for(let i:i32=255;i>=0;i--){
    rem=rem+rem;
    const limb=i<64?product.lo1:i<128?product.lo2:i<192?product.hi1:product.hi2;
    if(((limb>>(<u64>(i&63)))&1)!=0)rem=rem+u256.One;
    if(rem>=divisor){rem=rem-divisor;if(i>=128)unreachable();if(i<64)lo|=(<u64>1)<<i;else hi|=(<u64>1)<<(i-64);}
  }
  const q=new u128(lo,hi);
  return ceil&&rem!=u256.Zero?add(q,ONE):q;
}
export function min(a:u128,b:u128):u128{return a<b?a:b;}
