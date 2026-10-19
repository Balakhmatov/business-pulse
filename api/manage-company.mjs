import { companyAdmin } from './company-admin.mjs';

// Run on the VPS as the operator; no HTTP endpoint and no Telegram token required.
try{
  const [command,ownerId,value]=process.argv.slice(2);
  if(!['list','set','members','addmember','removemember'].includes(command))throw Error('Использование: node api/manage-company.mjs list [Telegram_ID] | set ID clinic | members ID | addmember ID_руководителя ID_сотрудника | removemember ID_руководителя ID_сотрудника');
  console.log(JSON.stringify(companyAdmin({action:command,ownerId,industry:value,memberId:value}),null,2));
}catch(error){console.error(error.message);process.exitCode=1;}
