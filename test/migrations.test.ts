import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { schema } from '../src/schema.js';
import { Store } from '../src/db.js';
import { migrations } from '../src/migrations.js';
import { id,hash,now } from '../src/auth.js';

test('v0.1 data survives concurrent API/worker migrations from three processes',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'second-ink-v1-'));
  const filePath=path.join(directory,'second-ink.sqlite'),legacy=new DatabaseSync(filePath);
  const user=id(),org=id(),caseId=id(),attachment=id(),document=id(),command=id(),run=id(),at=now();
  for(const statement of schema)legacy.exec(statement);
  legacy.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(1,at);
  legacy.prepare('INSERT INTO users VALUES (?,?,?,?)').run(user,'legacy_user','legacy-password-hash',at);
  legacy.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash('legacy-session'),user,'2099-01-01T00:00:00.000Z');
  legacy.prepare('INSERT INTO organizations VALUES (?,?,?)').run(org,'原组织',at);
  legacy.prepare('INSERT INTO memberships VALUES (?,?,?)').run(org,user,'ADMIN');
  legacy.prepare('INSERT INTO cases(id,org_id,created_by,title,scenario,business_date,status,revision,data_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(caseId,org,user,'原事项','WEEKLY_REPORT','2026-11-17','PUBLISHED',4,'{}',at,at);
  legacy.prepare('INSERT INTO attachments VALUES (?,?,?,?,?,?,?,?,?)').run(attachment,caseId,'original.txt',attachment+'.txt',hash('原始内容'),12,'MATERIAL','{"text":"原始内容","records":[],"warnings":[]}',at);
  legacy.prepare('INSERT INTO documents VALUES (?,?,?,?,?)').run(document,caseId,1,'历史文档',at);
  const blocks=JSON.stringify([{id:id(),type:'paragraph',text:'历史正文'}]);
  legacy.prepare('INSERT INTO document_versions VALUES (?,?,?,?,?,?,?,?,?)').run(document,1,null,blocks,hash(blocks),user,null,null,at);
  legacy.prepare('INSERT INTO commands VALUES (?,?,?,?,?,?)').run(command,caseId,user,'digest','{"status":"PUBLISHED","legacy":true}',at);
  legacy.prepare('INSERT INTO runs(id,case_id,requested_by,status,input_revision,input_json,steps_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(run,caseId,user,'WAITING_FOR_REVIEW',1,'{}','[]',at,at);
  legacy.close();
  await mkdir(path.join(directory,'attachments'));await writeFile(path.join(directory,'attachments',attachment+'.txt'),'原始内容');
  const childPath=fileURLToPath(new URL('./migration-child.js',import.meta.url));
  try{
    const outputs=await Promise.all([1,2,3].map(()=>new Promise<string>((resolve,reject)=>{
      const child=spawn(process.execPath,[childPath,directory],{stdio:['ignore','pipe','pipe']});let output='';
      child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
      child.on('error',reject);child.on('exit',code=>code===0?resolve(output):reject(new Error(output)));
    })));
    assert.ok(outputs.every(output=>output.includes('migrated')));
    const config={dataDir:directory,databaseUrl:'',host:'127.0.0.1',port:3080,embeddedWorker:false,frontendOrigin:'',sessionHours:1};
    const connections=await Promise.all([new Store(config).open(),new Store(config).open()]);
    try{
      const db=connections[0]!;
      assert.deepEqual((await db.all('SELECT version FROM schema_migrations ORDER BY version')).map(r=>r.version),[1,2,3,4]);
      assert.equal((await db.get('SELECT password_hash FROM users WHERE id=?',[user]))!.password_hash,'legacy-password-hash');
      assert.equal((await db.get('SELECT token_hash FROM sessions WHERE user_id=?',[user]))!.token_hash,hash('legacy-session'));
      assert.equal((await db.get('SELECT content_json FROM document_versions WHERE document_id=?',[document]))!.content_json,blocks);
      assert.equal(JSON.parse((await db.get('SELECT receipt_json FROM commands WHERE id=?',[command]))!.receipt_json).legacy,true);
      assert.equal((await db.get('SELECT status FROM runs WHERE id=?',[run]))!.status,'WAITING_FOR_REVIEW');
      assert.equal(await readFile(path.join(directory,'attachments',attachment+'.txt'),'utf8'),'原始内容');
    }finally{await Promise.all(connections.map(db=>db.close()));}
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('v0.3 TEAM migration backfills root budget and head without rewriting frozen inputs or checkpoints',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'second-ink-v3-'));
  const legacy=new DatabaseSync(path.join(directory,'second-ink.sqlite'));
  const user=id(),org=id(),caseId=id(),run=id(),checkpoint=id(),at=now();
  try{
    for(const sql of [...schema,...migrations.filter(m=>m.version<=3).flatMap(m=>m.statements)])legacy.exec(sql);
    for(const version of [1,2,3])legacy.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(version,at);
    legacy.prepare('INSERT INTO users VALUES (?,?,?,?)').run(user,'legacy_team_user','password',at);
    legacy.prepare('INSERT INTO organizations VALUES (?,?,?)').run(org,'历史组织',at);
    legacy.prepare('INSERT INTO memberships VALUES (?,?,?)').run(org,user,'ADMIN');
    legacy.prepare('INSERT INTO cases(id,org_id,created_by,title,scenario,business_date,status,revision,data_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(caseId,org,user,'历史 TEAM','WEEKLY_REPORT','2026-11-18','OPEN',2,'{}',at,at);
    const input=JSON.stringify({mode:'TEAM',caseId,revision:2,team:{teamId:id(),version:1,digest:'legacy-team-digest',definition:{maxModelCalls:4,nodes:[]}},attachments:[],rules:[]});
    const snapshot=JSON.stringify({runId:run,inputDigest:hash(input),evidenceDigest:'legacy',completedSteps:[],documentVersions:[],caseRevision:2});
    legacy.prepare('INSERT INTO runs(id,case_id,requested_by,status,input_revision,input_json,steps_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(run,caseId,user,'PAUSED',2,input,'[]',at,at);
    legacy.prepare('INSERT INTO run_controls(run_id,revision,epoch,paused_nodes_json,model_calls,created_at) VALUES (?,?,?,?,?,?)').run(run,3,2,'["report"]',2,at);
    legacy.prepare('INSERT INTO run_checkpoints(id,run_id,epoch,event_seq,snapshot_json,digest,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)').run(checkpoint,run,2,1,snapshot,hash(snapshot),user,at);
    legacy.close();
    const config={dataDir:directory,databaseUrl:'',host:'127.0.0.1',port:3080,embeddedWorker:false,frontendOrigin:'',sessionHours:1};
    const db=await new Store(config).open();try{
      assert.equal((await db.get('SELECT input_json FROM runs WHERE id=?',[run]))!.input_json,input);
      assert.equal((await db.get('SELECT snapshot_json FROM run_checkpoints WHERE id=?',[checkpoint]))!.snapshot_json,snapshot);
      assert.equal((await db.get('SELECT digest FROM run_checkpoints WHERE id=?',[checkpoint]))!.digest,hash(snapshot));
      const lineage=(await db.get('SELECT * FROM run_lineage WHERE run_id=?',[run]))!;assert.equal(lineage.root_run_id,run);assert.equal(lineage.parent_run_id,null);
      assert.equal((await db.get('SELECT run_id FROM case_heads WHERE case_id=?',[caseId]))!.run_id,run);
      assert.equal((await db.get('SELECT used_calls FROM root_budgets WHERE root_run_id=?',[run]))!.used_calls,2);
      assert.equal((await db.get('SELECT status FROM runs WHERE id=?',[run]))!.status,'PAUSED');
    }finally{await db.close();}
    const reopened=await new Store(config).open();try{assert.equal(Number((await reopened.get('SELECT COUNT(*) AS n FROM run_lineage'))!.n),1);assert.equal((await reopened.get('SELECT used_calls FROM root_budgets WHERE root_run_id=?',[run]))!.used_calls,2);}finally{await reopened.close();}
  }finally{try{legacy.close();}catch{}await rm(directory,{recursive:true,force:true});}
});
