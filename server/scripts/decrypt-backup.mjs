// Recovery utility. It only decrypts a backup; it never restores or alters a DB.
import {createDecipheriv} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
const [source,keyPath,destination]=process.argv.slice(2);
if(!source||!keyPath||!destination)throw new Error('Usage: node decrypt-backup.mjs <backup> <key-file> <new-output-file>');
const data=await readFile(source),key=await readFile(keyPath);
if(data.subarray(0,5).toString()!=='YLBK1'||data.length<33||key.length!==32)throw new Error('Invalid backup');
const decipher=createDecipheriv('aes-256-gcm',key,data.subarray(5,17));decipher.setAuthTag(data.subarray(-16));
const plaintext=Buffer.concat([decipher.update(data.subarray(17,-16)),decipher.final()]);
await writeFile(destination,plaintext,{flag:'wx',mode:0o600});
console.info('Backup authenticated and decrypted. No database restore was performed.');
