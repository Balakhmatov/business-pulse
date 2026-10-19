// Run as root on the VPS. Copies only payment credentials; never imports CityAI configuration wholesale.
import fs from 'node:fs';
import { parseEnv } from 'node:util';
import { execFileSync } from 'node:child_process';
const source=parseEnv(fs.readFileSync('/var/byvshaya/shared/cityai.env','utf8'));
const names=['YOOKASSA_SHOP_ID','YOOKASSA_SECRET_KEY'];
if(names.some(name=>!source[name]?.trim()||/[\r\n\0]/.test(source[name])))throw Error('CityAI payment credentials are missing or malformed');
const target='/etc/business-pulse/yookassa.env';
fs.writeFileSync(target,names.map(name=>name+'='+JSON.stringify(source[name].trim())).join('\n')+'\n',{mode:0o600});
fs.chmodSync(target,0o600);
const dir='/etc/systemd/system/business-pulse-api.service.d';
fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(dir+'/yookassa.conf','[Service]\nEnvironmentFile=/etc/business-pulse/yookassa.env\n');
execFileSync('systemctl',['daemon-reload']);
execFileSync('systemctl',['restart','business-pulse-api']);
console.log('Business Pulse payment credentials configured; only Business Pulse API restarted.');
