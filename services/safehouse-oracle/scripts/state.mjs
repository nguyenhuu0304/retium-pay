import fs from 'node:fs';
import path from 'node:path';
export function fileStore(file){
  return {async load(){return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};},async save(s){
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const temp=file+'.tmp';const fd=fs.openSync(temp,'w',0o600);
    try{fs.writeFileSync(fd,JSON.stringify(s));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temp,file);
    // Persist directory rename on Linux; Windows may not allow directory descriptors.
    if(process.platform!=='win32'){const d=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}
  }};
}
export function acquireLock(file){
  fs.mkdirSync(path.dirname(file),{recursive:true});let fd;
  try{fd=fs.openSync(file,'wx',0o600);}catch{throw Error('PUBLISHER_LOCK_EXISTS');}
  fs.writeFileSync(fd,String(process.pid));fs.fsyncSync(fd);
  return ()=>{try{fs.closeSync(fd);fs.unlinkSync(file);}catch{/* operator can inspect stale locks */}};
}
