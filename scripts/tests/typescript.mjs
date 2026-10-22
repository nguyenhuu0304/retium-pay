import {registerHooks} from 'node:module';
import {createRequire} from 'node:module';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const nextServerUrl=pathToFileURL(require.resolve("next/server")).href;
registerHooks({resolve(s,c,next){
  if(s==='next/server')return {url:nextServerUrl,shortCircuit:true};
  if(s.startsWith('.')&&c.parentURL?.startsWith('file:')){const p=fileURLToPath(new URL(s,c.parentURL));if(existsSync(p+'.ts'))return {url:pathToFileURL(p+'.ts').href,shortCircuit:true};}
  return next(s,c);
},load(url,c,next){if(url.endsWith('.ts'))return {source:ts.transpileModule(readFileSync(fileURLToPath(url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.ESNext}}).outputText,format:'module',shortCircuit:true};return next(url,c);}});
