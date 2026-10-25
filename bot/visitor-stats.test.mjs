import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createVisitorStats } from './visitor-stats.mjs';

function fixture(t){
  const db=new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  t.after(()=>db.close());
  let clock=Date.parse('2026-10-25T20:50:00Z'),seq=0;
  const admins=new Set(['999']);
  const make=()=>createVisitorStats({db,now:()=>clock,adminIds:admins});
  let stats=make();
  const msg=(id,text='/start')=>({update_id:++seq,message:{message_id:seq,chat:{id,type:'private'},from:{id,first_name:'Клиент '+id,username:'user'+id},text}});
  return {db,admins,msg,stats:()=>stats,record:u=>stats.record(u),advance:ms=>clock+=ms,restart:()=>stats=make()};
}

test('Unique users, starts and sessions are distinct; repeated events never inflate counters after restart',t=>{
  const f=fixture(t),u=f.msg(101);
  assert.equal(f.record(u),true);f.advance(1000);assert.equal(f.record(u),false);
  f.record(f.msg(101,'/start prices'));f.record(f.msg(202,'Здравствуйте'));
  f.advance(30*60000);f.record(f.msg(101,'/menu'));
  f.restart();assert.equal(f.record(u),false);
  const s=f.stats().summary();
  assert.equal(s.total,2);assert.equal(s.month.users,2);
  assert.equal(s.month.starts,2);assert.equal(s.month.sessions,3);assert.equal(s.month.actions,4);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM bot_stats_updates').get().n,4);
});

test('Moscow midnight separates days; returners and rolling windows use calendar boundaries',t=>{
  const f=fixture(t);f.record(f.msg(101));f.advance(20*60000);f.record(f.msg(101,'Вернулся'));
  f.record(f.msg(202));const s=f.stats().summary();
  assert.equal(s.today.from,'2026-10-26');assert.equal(s.today.users,2);
  assert.equal(s.today.new_users,1);assert.equal(s.today.returning,1);
  assert.equal(s.yesterday.users,1);assert.equal(s.yesterday.new_users,1);
  assert.equal(s.week.new_users,2);assert.equal(s.week.returning,0);
  f.advance(30*86400000);f.record(f.msg(101,'/menu'));
  const later=f.stats().summary();assert.equal(later.month.users,1);
  assert.equal(later.month.new_users,0);assert.equal(later.month.returning,1);
  assert.equal(later.total,2);
});

test('Only actual private actions count; callback panel dates and selected contacts are not visits',t=>{
  const f=fixture(t);
  f.record({message:{chat:{id:101,type:'group'},from:{id:101},text:'/start'}});
  f.record({message:{chat:{id:101,type:'private'},from:{id:202},text:'/start'}});
  f.record({message:{chat:{id:101,type:'private'},from:{id:101,is_bot:true},text:'/start'}});
  assert.equal(f.stats().summary().total,0);
  const u=f.msg(101);u.message.users_shared={users:[{user_id:303}]};f.record(u);
  const cb={callback_query:{id:'tap-1',from:{id:202,first_name:'Сотрудник'},message:{chat:{id:202,type:'private'},date:1,message_id:1},data:'bp:report'}};
  f.record(cb);f.record(cb);
  assert.equal(f.stats().summary().today.users,2);assert.equal(f.stats().summary().today.starts,1);
  assert.equal(f.db.prepare("SELECT 1 FROM bot_visitors WHERE telegram_id='303'").get(),undefined);
});

test('Admin visits are excluded from summary and recent list including after allowlist changes',t=>{
  const f=fixture(t);f.record(f.msg(999));f.record(f.msg(101));
  assert.equal(f.stats().summary().total,1);assert.equal(f.stats().recent()[0].telegram_id,'101');
  f.admins.add('101');assert.equal(f.stats().summary().total,0);assert.deepEqual(f.stats().recent(),[]);
  f.admins.clear();assert.equal(f.stats().summary().total,2);
});

test('Pagination stays stable and message contents or invitation tokens are not stored',t=>{
  const f=fixture(t);
  for(let id=101;id<114;id++){f.advance(1);f.record(f.msg(id,'/start join_private-secret'));}
  const first=f.stats().recent(),second=f.stats().recent(10);
  assert.equal(first.length,11);assert.equal(second.length,3);
  assert.equal(new Set([...first.slice(0,10),...second].map(x=>x.telegram_id)).size,13);
  assert.throws(()=>f.stats().recent(-1));assert.throws(()=>f.stats().recent(NaN));
  for(const table of ['bot_visitors','bot_visit_days','bot_stats_updates']){
    assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM '+table).all()).includes('private-secret'));
  }
});

test('Legacy profile tables do not become invented historical visitors; tracking start persists',t=>{
  const f=fixture(t);
  f.db.exec("CREATE TABLE bot_profiles(telegram_id TEXT); INSERT INTO bot_profiles VALUES('303')");
  const started=f.stats().summary().started_ms;f.advance(86400000);f.restart();
  assert.equal(f.stats().summary().started_ms,started);assert.equal(f.stats().summary().total,0);
  const m={message:{message_id:4,chat:{id:101,type:'private'},from:{id:101},text:'/start@business_pulse_app_bot'}};
  f.record(m);f.record(m);assert.equal(f.stats().summary().today.starts,1);
});
