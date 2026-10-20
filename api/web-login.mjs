import { randomBytes,createHash } from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
const valid=value=>typeof value==='string'&&/^[a-f0-9]{48}$/.test(value);
export function createWebLogin(db,now=Date.now){
  db.exec('CREATE TABLE IF NOT EXISTS web_logins (challenge TEXT PRIMARY KEY,secret_hash TEXT NOT NULL,expires_ms INTEGER NOT NULL,actor_id TEXT);CREATE TABLE IF NOT EXISTS web_sessions (token_hash TEXT PRIMARY KEY,actor_id TEXT NOT NULL,expires_ms INTEGER NOT NULL);');
  return {
    create(){
      const at=now();db.prepare('DELETE FROM web_logins WHERE expires_ms<=?').run(at);db.prepare('DELETE FROM web_sessions WHERE expires_ms<=?').run(at);
      if(db.prepare('SELECT COUNT(*) AS n FROM web_logins').get().n>=1000)throw Error('Попробуйте войти чуть позже.');
      const challenge=randomBytes(24).toString('hex'),secret=randomBytes(24).toString('hex');
      db.prepare('INSERT INTO web_logins VALUES(?,?,?,NULL)').run(challenge,hash(secret),at+5*60000);
      return {challenge,secret};
    },
    approve(challenge,actor){
      if(!valid(challenge)||!/^[1-9]\d{0,15}$/.test(String(actor)))throw Error('Ссылка входа недействительна.');
      const r=db.prepare('UPDATE web_logins SET actor_id=? WHERE challenge=? AND expires_ms>? AND actor_id IS NULL').run(String(actor),challenge,now());
      if(r.changes!==1)throw Error('Ссылка входа устарела. Начните вход на сайте заново.');
    },
    poll(challenge,secret){
      if(!valid(challenge)||!valid(secret))throw Error('Вход недействителен.');
      db.exec('BEGIN IMMEDIATE');
      try{
        const row=db.prepare('SELECT * FROM web_logins WHERE challenge=? AND secret_hash=? AND expires_ms>?').get(challenge,hash(secret),now());
        if(!row)throw Error('Время входа истекло. Начните заново.');
        if(!row.actor_id){db.exec('COMMIT');return {pending:true};}
        const token=randomBytes(24).toString('hex');
        db.prepare('INSERT INTO web_sessions VALUES(?,?,?)').run(hash(token),row.actor_id,now()+86400000);
        db.prepare('DELETE FROM web_logins WHERE challenge=?').run(challenge);db.exec('COMMIT');return {token};
      }catch(e){db.exec('ROLLBACK');throw e;}
    },
    actor(token){return valid(token)?db.prepare('SELECT actor_id FROM web_sessions WHERE token_hash=? AND expires_ms>?').get(hash(token),now())?.actor_id:null;}
  };
}
