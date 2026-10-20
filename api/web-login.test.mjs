import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createWebLogin } from './web-login.mjs';
test('Browser login requires explicit confirmation, secret possession and cannot be consumed twice',()=>{
 const db=new DatabaseSync(':memory:');let now=1000;const login=createWebLogin(db,()=>now);
 const a=login.create(),b=login.create();
 assert.deepEqual(login.poll(a.challenge,a.secret),{pending:true});
 assert.throws(()=>login.poll(a.challenge,b.secret));
 login.approve(a.challenge,'101');
 assert.throws(()=>login.approve(a.challenge,'202'));
 assert.throws(()=>login.poll(a.challenge,b.secret));
 const {token}=login.poll(a.challenge,a.secret);
 assert.equal(login.actor(token),'101');assert.equal(login.actor(b.secret),undefined);
 assert.throws(()=>login.poll(a.challenge,a.secret));
 now+=86400000;assert.equal(login.actor(token),undefined);db.close();
});
test('Expired challenges and malformed identifiers cannot approve or issue sessions',()=>{
 const db=new DatabaseSync(':memory:');let now=1000;const login=createWebLogin(db,()=>now),a=login.create();
 assert.throws(()=>login.approve(a.challenge,'invalid'));
 now+=300000;assert.throws(()=>login.approve(a.challenge,'101'));assert.throws(()=>login.poll(a.challenge,a.secret));
 assert.equal(login.actor('invalid'),null);db.close();
});
