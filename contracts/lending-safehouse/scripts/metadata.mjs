import fs from 'node:fs';
const path=new URL('../assembly/index.ts',import.meta.url);
const metadata={rcp_type:'retiumpay_lending_test',traits:['testnet','lending','safehouse_reference_feed'],capabilities:['execute'],lockable_fields:[],evolves_from:'',weight:5,version:'v0.2.0'};
const bytes=[...Buffer.from('RCP_METADATA:'+JSON.stringify(metadata)+'\0')];
fs.writeFileSync(path,fs.readFileSync(path,'utf8').replace(/\/\/ METADATA_START[\s\S]*?\/\/ METADATA_END/,'// METADATA_START\nexport const RCP_METADATA:usize=memory.data<u8>(['+bytes.join(',')+']);\n// METADATA_END'));
