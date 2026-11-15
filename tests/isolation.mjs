// Offline-only test preload. Fail closed, even if product code catches an I/O error.
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports,registerHooks} from 'node:module';
let attempts=0;
const deny=label=>function(){attempts++;throw new Error(`ISOLATION: forbidden ${label}`);};
globalThis.fetch=deny('live fetch');
net.Socket.prototype.connect=deny('socket connect');
net.Server.prototype.listen=deny('listen');
tls.connect=deny('TLS connect');
http.request=deny('HTTP request');http.get=deny('HTTP get');
https.request=deny('HTTPS request');https.get=deny('HTTPS get');
dgram.Socket.prototype.bind=deny('UDP bind');dgram.Socket.prototype.send=deny('UDP send');
for(const key of ['exec','execSync','execFile','execFileSync','spawn','spawnSync','fork'])childProcess[key]=deny(`child_process.${key}`);
registerHooks({resolve(specifier,context,next){
 if(/(?:^|\/)server\.mjs$|(?:^|\/)model-preload\.mjs$|(?:^|\/)sites-env\.mjs$/.test(specifier)){attempts++;throw Error('ISOLATION: forbidden runtime entry');}
 return next(specifier,context);
}});
syncBuiltinESMExports();
process.on('exit',()=>{console.log(`ISOLATION forbidden_io_attempts=${attempts}`);if(attempts)process.exitCode=99;});
