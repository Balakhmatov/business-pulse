import {randomUUID} from 'node:crypto';
import {reminderFor} from './billing.mjs';
import {isPlatformAdmin} from './platform-admin.mjs';
import {safeMailAddress} from './smtp-mail.mjs';
const HOUR=3600000;
// One worker may run in several API processes. Claim before sending; successful
// delivery uses the same company/kind receipt as Telegram, so linking never
// produces another copy. SMTP has no idempotency: ambiguous delivery is held
// for investigation, not retried automatically.
export function createTrialEmailReminders({db,mail,now=Date.now,log=console.error}){
 db.prepare("INSERT OR IGNORE INTO billing_email_meta VALUES('enabled_ms',?)").run(now());
 const enabled=db.prepare("SELECT value_ms FROM billing_email_meta WHERE key='enabled_ms'").get().value_ms;
 const ownerEmail=c=>{
  if(!String(c.owner_id).startsWith('web:')||isPlatformAdmin(db,c.owner_id))return null;
  if(db.prepare('SELECT 1 FROM account_links WHERE company_id=?').get(c.id))return null;
  return db.prepare('SELECT email FROM web_accounts WHERE actor_id=?').get(c.owner_id)?.email||null;
 };
 const companies=db.prepare(`SELECT c.* FROM companies c JOIN company_billing b ON b.company_id=c.id
   WHERE b.plan IS NULL AND b.trial_granted_by IS NOT NULL AND b.trial_ends_ms>=?
   AND c.owner_id LIKE 'web:%' AND NOT EXISTS(SELECT 1 FROM company_members m WHERE m.telegram_id=c.owner_id)
   ORDER BY b.trial_ends_ms,c.id`);
 function claim(companyId){
  db.exec('BEGIN IMMEDIATE');
  try{
   const c=db.prepare('SELECT * FROM companies WHERE id=?').get(companyId),to=c&&ownerEmail(c);
   const notice=to&&safeMailAddress(to)&&reminderFor(db,c,now());
   if(!notice){db.exec('COMMIT');return null;}
   const previous=db.prepare('SELECT * FROM billing_email_deliveries WHERE company_id=? AND kind=?').get(c.id,notice.kind);
   if(previous?.status==='sending'&&previous.lease_until_ms<=now()){
    db.prepare("UPDATE billing_email_deliveries SET status='uncertain' WHERE company_id=? AND kind=? AND token=?").run(c.id,notice.kind,previous.token);
    log('Trial email requires review: expired lease company='+c.id+' kind='+notice.kind);
   }
   if(previous&&(previous.status!=='failed'||previous.next_attempt_ms>now()||previous.attempts>=6)){db.exec('COMMIT');return null;}
   const token=randomUUID(),attempts=(previous?.attempts||0)+1;
   db.prepare(`INSERT INTO billing_email_deliveries VALUES(?,?,'sending',?,?,0,?,NULL)
     ON CONFLICT(company_id,kind) DO UPDATE SET status='sending',token=excluded.token,
     attempts=excluded.attempts,next_attempt_ms=0,lease_until_ms=excluded.lease_until_ms`)
     .run(c.id,notice.kind,token,attempts,now()+10*60000);
   const billing=db.prepare('SELECT trial_ends_ms FROM company_billing WHERE company_id=?').get(c.id);
   db.exec('COMMIT');return {c,to,kind:notice.kind,token,attempts,trialEndsMs:billing.trial_ends_ms};
  }catch(e){db.exec('ROLLBACK');throw e;}
 }
 let busy=false;
 async function tick(){
  if(busy||!mail.ready)return {sent:0};busy=true;let sent=0,attempted=0;
  try{
   for(const c of companies.all(Math.max(enabled,now()-24*HOUR))){
    if(attempted>=20)break;
    const job=claim(c.id);if(!job)continue;attempted++;
    try{
     await mail.sendTrialReminder({to:job.to,kind:job.kind,trialEndsMs:job.trialEndsMs,companyName:job.c.name,
       idempotencyKey:'bp-trial-'+job.c.id+'-'+job.kind});
     db.exec('BEGIN IMMEDIATE');
     try{
      const updated=db.prepare("UPDATE billing_email_deliveries SET status='sent',sent_ms=? WHERE company_id=? AND kind=? AND token=? AND status='sending'")
        .run(now(),job.c.id,job.kind,job.token);
      if(updated.changes)db.prepare('INSERT OR IGNORE INTO billing_reminders VALUES(?,?,?)').run(job.c.id,job.kind,now());
      db.exec('COMMIT');sent++;
     }catch(e){db.exec('ROLLBACK');throw e;}
    }catch(error){
     const status=error.deliveryUncertain===false?'failed':'uncertain';
     db.prepare('UPDATE billing_email_deliveries SET status=?,next_attempt_ms=? WHERE company_id=? AND kind=? AND token=?')
       .run(status,now()+Math.min(60,5*2**(job.attempts-1))*60000,job.c.id,job.kind,job.token);
     log('Trial email delivery '+status+' company='+job.c.id+' kind='+job.kind); // No mailbox, company name or provider response in logs.
    }
   }
   return {sent};
  }finally{busy=false;}
 }
 return {tick};
}
