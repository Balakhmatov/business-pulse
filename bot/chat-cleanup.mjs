import { randomBytes } from 'node:crypto';

const MESSAGE_AGE=48*60*60*1000;
export function createChatCleanup({db,api,now=Date.now}){
  db.exec('CREATE TABLE IF NOT EXISTS bot_chat_messages (chat_id TEXT NOT NULL,message_id INTEGER NOT NULL,sent_ms INTEGER NOT NULL,keep INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(chat_id,message_id));'+
    'CREATE UNIQUE INDEX IF NOT EXISTS ix_bot_chat_welcome ON bot_chat_messages(chat_id) WHERE keep=1;'+
    'CREATE TABLE IF NOT EXISTS bot_chat_clear_confirmations (chat_id TEXT PRIMARY KEY,token TEXT NOT NULL,expires_ms INTEGER NOT NULL);');
  function remember(chatId,messageId,date){
    if(!/^[1-9]\d{0,15}$/.test(String(chatId))||!Number.isSafeInteger(messageId)||messageId<1)return;
    const sent=Number.isFinite(date)?date*1000:now();
    db.prepare('INSERT OR IGNORE INTO bot_chat_messages(chat_id,message_id,sent_ms) VALUES(?,?,?)').run(String(chatId),messageId,sent);
  }
  function welcome(chatId){return db.prepare('SELECT message_id FROM bot_chat_messages WHERE chat_id=? AND keep=1').get(String(chatId))?.message_id;}
  function keepWelcome(chatId,messageId){
    if(!welcome(chatId))db.prepare('UPDATE bot_chat_messages SET keep=1 WHERE chat_id=? AND message_id=?').run(String(chatId),messageId);
  }
  function forgetWelcome(chatId){db.prepare('DELETE FROM bot_chat_messages WHERE chat_id=? AND keep=1').run(String(chatId));}
  function confirm(chatId){
    const token=randomBytes(12).toString('hex');
    db.prepare('INSERT INTO bot_chat_clear_confirmations VALUES(?,?,?) ON CONFLICT(chat_id) DO UPDATE SET token=excluded.token,expires_ms=excluded.expires_ms').run(String(chatId),token,now()+5*60000);
    return token;
  }
  function cancel(chatId){db.prepare('DELETE FROM bot_chat_clear_confirmations WHERE chat_id=?').run(String(chatId));}
  async function clear(chatId,token){
    chatId=String(chatId);
    const confirmation=db.prepare('SELECT token,expires_ms FROM bot_chat_clear_confirmations WHERE chat_id=?').get(chatId);
    if(!confirmation||confirmation.token!==token||confirmation.expires_ms<=now())throw Error('Подтверждение устарело. Нажмите «Очистить чат» ещё раз.');
    cancel(chatId); // consume before the first network request; repeated clicks cannot clear new messages
    const rows=db.prepare('SELECT message_id FROM bot_chat_messages WHERE chat_id=? AND keep=0 AND sent_ms>? ORDER BY message_id DESC').all(chatId,now()-MESSAGE_AGE);
    let retained=0;
    const forget=id=>db.prepare('DELETE FROM bot_chat_messages WHERE chat_id=? AND message_id=? AND keep=0').run(chatId,id);
    for(let i=0;i<rows.length;i+=100){
      const ids=rows.slice(i,i+100).map(x=>x.message_id);
      try{
        await api('deleteMessages',{chat_id:chatId,message_ids:ids});
        for(const id of ids)forget(id);
      }catch(error){
        // A non-deletable service/dice message must not prevent clearing others.
        if(!/can't be deleted|cannot be deleted|message to delete not found/i.test(error.message))throw error;
        for(const id of ids){
          try{await api('deleteMessage',{chat_id:chatId,message_id:id});forget(id);}
          catch(single){
            if(/message to delete not found/i.test(single.message))forget(id);
            else if(/can't be deleted|cannot be deleted/i.test(single.message))retained++;
            else throw single;
          }
        }
      }
    }
    // Keep the welcome reference, but do not retain metadata for expired messages indefinitely.
    db.prepare('DELETE FROM bot_chat_messages WHERE chat_id=? AND keep=0 AND sent_ms<=?').run(chatId,now()-MESSAGE_AGE);
    return {retained};
  }
  return {remember,welcome,keepWelcome,forgetWelcome,confirm,cancel,clear};
}
