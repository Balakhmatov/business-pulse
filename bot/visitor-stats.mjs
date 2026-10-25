// Visits are observable private-chat actions, not silent chat opens.
// Keep aggregates and event IDs only; never retain message text or start payloads.
const SESSION_MS=30*60*1000;
const clean=value=>String(value||'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,100);
const dayFormat=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'});
const dayAt=ms=>{
  const p=Object.fromEntries(dayFormat.formatToParts(new Date(ms)).map(x=>[x.type,x.value]));
  return p.year+'-'+p.month+'-'+p.day;
};
const shift=(day,n)=>new Date(Date.parse(day+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);

export function createVisitorStats({db,now=Date.now,adminIds=new Set()}){
  db.exec('CREATE TABLE IF NOT EXISTS bot_stats_meta (id INTEGER PRIMARY KEY CHECK(id=1),started_ms INTEGER NOT NULL);'+
    'CREATE TABLE IF NOT EXISTS bot_visitors (telegram_id TEXT PRIMARY KEY,display_name TEXT NOT NULL,username TEXT NOT NULL,first_ms INTEGER NOT NULL,last_ms INTEGER NOT NULL,first_day TEXT NOT NULL);'+
    'CREATE TABLE IF NOT EXISTS bot_visit_days (telegram_id TEXT NOT NULL REFERENCES bot_visitors(telegram_id),day TEXT NOT NULL,actions INTEGER NOT NULL,starts INTEGER NOT NULL,sessions INTEGER NOT NULL,PRIMARY KEY(telegram_id,day));'+
    'CREATE INDEX IF NOT EXISTS ix_bot_visits_day ON bot_visit_days(day);'+
    'CREATE INDEX IF NOT EXISTS ix_bot_visitors_recent ON bot_visitors(last_ms);'+
    'CREATE TABLE IF NOT EXISTS bot_stats_updates (event_key TEXT PRIMARY KEY);');
  db.prepare('INSERT OR IGNORE INTO bot_stats_meta VALUES(1,?)').run(now());

  function record(update){
    const callback=update.callback_query,message=callback?.message||update.message;
    const user=callback?.from||message?.from;
    if(message?.chat?.type!=='private'||user?.is_bot||!Number.isSafeInteger(user?.id)||user.id<1||String(user.id)!==String(message.chat.id))return false;
    const actor=String(user.id),at=now(),day=dayAt(at);
    const key=Number.isSafeInteger(update.update_id)&&update.update_id>=0?'u:'+update.update_id:
      callback?.id?'c:'+callback.id:Number.isSafeInteger(message.message_id)?'m:'+actor+':'+message.message_id:null;
    const start=!callback&&/^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(String(message.text||'').trim())?1:0;
    db.exec('BEGIN IMMEDIATE');
    try{
      if(key&&!db.prepare('INSERT OR IGNORE INTO bot_stats_updates VALUES(?)').run(key).changes){db.exec('COMMIT');return false;}
      const old=db.prepare('SELECT last_ms FROM bot_visitors WHERE telegram_id=?').get(actor);
      const session=!old||at-old.last_ms>=SESSION_MS?1:0;
      db.prepare('INSERT INTO bot_visitors VALUES(?,?,?,?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET display_name=excluded.display_name,username=excluded.username,last_ms=MAX(last_ms,excluded.last_ms)')
        .run(actor,clean([user.first_name,user.last_name].filter(Boolean).join(' '))||'Пользователь',clean(user.username),at,at,day);
      db.prepare('INSERT INTO bot_visit_days VALUES(?,?,?,?,?) ON CONFLICT(telegram_id,day) DO UPDATE SET actions=actions+excluded.actions,starts=starts+excluded.starts,sessions=sessions+excluded.sessions')
        .run(actor,day,1,start,session);
      db.exec('COMMIT');return true;
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  function filter(){
    const ids=[...adminIds].map(String);
    return {sql:ids.length?'v.telegram_id NOT IN ('+ids.map(()=>'?').join(',')+')':'1=1',ids};
  }
  function summary(){
    const today=dayAt(now()),{sql,ids}=filter();
    const periods=[['today',today,today],['yesterday',shift(today,-1),shift(today,-1)],['week',shift(today,-6),today],['month',shift(today,-29),today]];
    const result={started_ms:db.prepare('SELECT started_ms FROM bot_stats_meta WHERE id=1').get().started_ms,
      total:db.prepare('SELECT COUNT(*) AS n FROM bot_visitors v WHERE '+sql).get(...ids).n,today};
    for(const [label,from,to] of periods){
      const row=db.prepare('SELECT COUNT(DISTINCT d.telegram_id) AS users,COALESCE(SUM(d.actions),0) AS actions,COALESCE(SUM(d.starts),0) AS starts,COALESCE(SUM(d.sessions),0) AS sessions,COUNT(DISTINCT CASE WHEN v.first_day<? THEN d.telegram_id END) AS returning_users FROM bot_visit_days d JOIN bot_visitors v ON v.telegram_id=d.telegram_id WHERE d.day>=? AND d.day<=? AND '+sql).get(from,from,to,...ids);
      const fresh=db.prepare('SELECT COUNT(*) AS n FROM bot_visitors v WHERE v.first_day>=? AND v.first_day<=? AND '+sql).get(from,to,...ids).n;
      result[label]={...row,returning:row.returning_users,new_users:fresh,from,to};
    }
    return result;
  }
  function recent(offset=0){
    if(!Number.isSafeInteger(offset)||offset<0)throw Error('Откройте статистику заново.');
    const {sql,ids}=filter();
    return db.prepare('SELECT v.*,COALESCE(SUM(d.sessions),0) AS sessions,COUNT(d.day) AS active_days FROM bot_visitors v LEFT JOIN bot_visit_days d ON d.telegram_id=v.telegram_id WHERE '+sql+' GROUP BY v.telegram_id ORDER BY v.last_ms DESC,v.telegram_id LIMIT 11 OFFSET ?').all(...ids,offset);
  }
  return {record,summary,recent};
}
