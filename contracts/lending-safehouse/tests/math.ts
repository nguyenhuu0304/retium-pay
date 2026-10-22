import {u128} from 'as-bignum/assembly';
import {mulDiv} from '../assembly/math';
export function calculate(ap:usize,al:i32,bp:usize,bl:i32,dp:usize,dl:i32,out:usize,ceil:bool):i32{
 const a=u128.fromString(String.UTF8.decodeUnsafe(ap,al)),b=u128.fromString(String.UTF8.decodeUnsafe(bp,bl)),d=u128.fromString(String.UTF8.decodeUnsafe(dp,dl));
 const value=String.UTF8.encode(mulDiv(a,b,d,ceil).toString());memory.copy(out,changetype<usize>(value),value.byteLength);return value.byteLength;
}
