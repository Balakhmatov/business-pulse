import { companyAdmin } from './company-admin.mjs';

// Run on the VPS as the operator; no HTTP endpoint and no Telegram token required.
try{
  const [command,ownerId,industry]=process.argv.slice(2);
  if(!['list','set'].includes(command))throw Error('Использование: node api/manage-company.mjs list [Telegram_ID] | set Telegram_ID clinic');
  console.log(JSON.stringify(companyAdmin({action:command,ownerId,industry}),null,2));
}catch(error){console.error(error.message);process.exitCode=1;}
