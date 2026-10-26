import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { ensureCompanyBilling, startCompanyTrial } from './billing.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const tokenShape = /^[a-f0-9]{48}$/;
const normalizeEmail = value => {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length < 6 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw Object.assign(Error('Укажите корректный email.'), { status: 400 });
  }
  return email;
};
const checkPassword = password => {
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
    throw Object.assign(Error('Пароль должен содержать от 10 до 128 символов.'), { status: 400 });
  }
};
const digestPassword = (password, salt) => scryptSync(password, Buffer.from(salt, 'hex'), 64).toString('hex');
const deny = () => Object.assign(Error('Неверный email или пароль.'), { status: 401 });

// No self-registration: each invitation is created by the operator on the VPS.
// Email is the login name; ownership is authorized by possession of the invitation,
// not by email verification. An SMTP-based recovery flow can be added later.
export function createWebsiteAccounts(db, now = Date.now) {
  db.exec(`CREATE TABLE IF NOT EXISTS web_accounts (
      email TEXT PRIMARY KEY, actor_id TEXT NOT NULL UNIQUE REFERENCES users(telegram_id),
      password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS web_invitations (
      code_hash TEXT PRIMARY KEY, company_name TEXT NOT NULL,
      expires_ms INTEGER NOT NULL, used_ms INTEGER);
    CREATE TABLE IF NOT EXISTS web_sessions (
      token_hash TEXT PRIMARY KEY, actor_id TEXT NOT NULL, expires_ms INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS ix_web_sessions_actor ON web_sessions(actor_id);`);
  const attempts = new Map();

  function newSession(actor) {
    const token = randomBytes(24).toString('hex');
    db.prepare('DELETE FROM web_sessions WHERE expires_ms <= ?').run(now());
    db.prepare('INSERT INTO web_sessions(token_hash,actor_id,expires_ms) VALUES(?,?,?)')
      .run(hash(token), actor, now() + 30 * 86400000);
    return token;
  }
  function createInvite(companyName) {
    const name = typeof companyName === 'string' ? companyName.trim() : '';
    if (name.length < 2 || name.length > 120) throw Error('Укажите название компании (2–120 символов).');
    const code = randomBytes(24).toString('hex');
    db.prepare('DELETE FROM web_invitations WHERE expires_ms <= ? OR used_ms IS NOT NULL').run(now());
    db.prepare('INSERT INTO web_invitations(code_hash,company_name,expires_ms,used_ms) VALUES(?,?,?,NULL)')
      .run(hash(code), name, now() + 7 * 86400000);
    return { code, expires_ms: now() + 7 * 86400000 };
  }
  function register({ email: rawEmail, password, invite } = {}) {
    const email = normalizeEmail(rawEmail);
    checkPassword(password);
    if (typeof invite !== 'string' || !tokenShape.test(invite)) {
      throw Object.assign(Error('Недействительный код приглашения.'), { status: 400 });
    }
    const codeHash = hash(invite), salt = randomBytes(16).toString('hex');
    const passwordHash = digestPassword(password, salt);
    db.exec('BEGIN IMMEDIATE');
    try {
      const invitation = db.prepare('SELECT * FROM web_invitations WHERE code_hash=? AND expires_ms>? AND used_ms IS NULL')
        .get(codeHash, now());
      if (!invitation) throw Object.assign(Error('Приглашение использовано или срок его действия истёк.'), { status: 400 });
      if (db.prepare('SELECT 1 FROM web_accounts WHERE email=?').get(email)) {
        throw Object.assign(Error('Такой email уже зарегистрирован. Выполните вход.'), { status: 409 });
      }
      const actor = 'web:' + randomUUID(), companyId = randomUUID();
      db.prepare('INSERT INTO users(telegram_id) VALUES(?)').run(actor);
      db.prepare('INSERT INTO companies(id,owner_id,name,industry) VALUES(?,?,?,?)')
        .run(companyId, actor, invitation.company_name, 'other');
      db.prepare('INSERT INTO web_accounts(email,actor_id,password_salt,password_hash,created_ms) VALUES(?,?,?,?,?)')
        .run(email, actor, salt, passwordHash, now());
      db.prepare('UPDATE web_invitations SET used_ms=? WHERE code_hash=? AND used_ms IS NULL').run(now(), codeHash);
      const company = { id: companyId, owner_id: actor };
      ensureCompanyBilling(db, company);
      startCompanyTrial(db, company, 'website-invite', now(), new Set(['website-invite']));
      const token = newSession(actor);
      db.exec('COMMIT');
      return { token };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function login({ email: rawEmail, password } = {}) {
    const email = normalizeEmail(rawEmail);
    if (typeof password !== 'string' || password.length > 128) throw deny();
    const at = now(), recent = attempts.get(email);
    if (recent && recent.until > at && recent.count >= 10) {
      throw Object.assign(Error('Слишком много попыток. Повторите вход через 15 минут.'), { status: 429 });
    }
    const record = db.prepare('SELECT * FROM web_accounts WHERE email=?').get(email);
    // Even unknown emails undergo the same deliberately slow password check.
    const fallbackSalt = '00000000000000000000000000000000';
    const computed = Buffer.from(digestPassword(password, record?.password_salt || fallbackSalt), 'hex');
    const expected = Buffer.from(record?.password_hash || '0'.repeat(128), 'hex');
    const ok = Boolean(record) && timingSafeEqual(computed, expected);
    if (!ok) {
      const count = recent && recent.until > at ? recent.count + 1 : 1;
      attempts.set(email, { count, until: at + 15 * 60000 });
      if (attempts.size > 10000) attempts.clear();
      throw deny();
    }
    attempts.delete(email);
    return { token: newSession(record.actor_id) };
  }
  function actor(token) {
    if (typeof token !== 'string' || !tokenShape.test(token)) return null;
    const row = db.prepare(`SELECT a.actor_id FROM web_sessions s JOIN web_accounts a ON a.actor_id=s.actor_id
      WHERE s.token_hash=? AND s.expires_ms>?`).get(hash(token), now());
    return row?.actor_id || null;
  }
  function logout(token) {
    const id = actor(token);
    if (id) db.prepare('DELETE FROM web_sessions WHERE token_hash=? AND actor_id=?').run(hash(token), id);
  }
  return { createInvite, register, login, actor, logout };
}
