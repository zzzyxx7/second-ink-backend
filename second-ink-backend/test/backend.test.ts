import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { setup,completeWeekly } from './helpers.js';
import { Store } from '../src/db.js';

test('registration, hashed passwords, login, logout, and origin guard',async()=>{
  const c=await setup();try {
    const user=await c.register('auth_user');
    const stored=await c.db.get('SELECT password_hash FROM users WHERE id=?',[user.user.id]);
    assert.notEqual(stored!.password_hash,'test-password-1234');
    assert.equal((await c.request('GET','/api/auth/profile',undefined,user.token)).status,200);
    assert.equal((await c.request('POST','/api/auth/register',{username:'auth_user',password:'test-password-1234'})).status,409);
    assert.equal((await c.request('POST','/api/auth/login',{username:'auth_user',password:'invalid-password'})).status,401);
    const login=await c.request('POST','/api/auth/login',{username:'auth_user',password:'test-password-1234'});
    assert.equal(login.status,200);
    assert.equal((await c.request('POST','/api/auth/logout',{},login.body.data.token)).status,200);
    assert.equal((await c.request('GET','/api/auth/profile',undefined,login.body.data.token)).status,401);
    const badOrigin=await fetch(c.base+'/api/organizations',{method:'POST',headers:{Origin:'https://evil.example',Authorization:`Bearer ${user.token}`,'Content-Type':'application/json'},body:'{"name":"bad"}'});
    assert.equal(badOrigin.status,403);
  } finally {await c.close();}
});

test('tenant and business role isolation covers cases, files, runs, documents and events',async()=>{
  const c=await setup();try {
    const f=await c.fixture(),other=await c.register('outsider');
    const uploaded=await c.upload(f.token,f.case.id,1,completeWeekly);
    assert.equal(uploaded.status,201);
    const run=await c.request('POST','/api/agent/requests',{caseId:f.case.id,expectedRevision:2},f.token);
    await c.runner.processOne();
    const result=await c.request('GET',`/api/runs/${run.body.data.runId}`,undefined,f.token);
    for(const endpoint of [`/api/cases/${f.case.id}`,`/api/attachments/${uploaded.body.data.attachments[0].id}/download`,
      `/api/runs/${run.body.data.runId}`,`/api/documents/${result.body.data.output.documentId}`,`/api/events?caseId=${f.case.id}`]) {
      assert.equal((await c.request('GET',endpoint,undefined,other.token)).status,404,endpoint);
    }
    const member=await c.register('reviewer');
    assert.equal((await c.request('POST',`/api/organizations/${f.org.id}/members`,{username:member.user.username,role:'REVIEWER'},f.token)).status,201);
    assert.equal((await c.request('PATCH',`/api/cases/${f.case.id}`,{expectedRevision:3,title:'unauthorized'},member.token)).status,403);
    assert.equal((await c.request('GET',`/api/cases/${f.case.id}`,undefined,member.token)).status,200);
  } finally {await c.close();}
});

test('complete weekly flow produces source evidence, immutable versions and idempotent publication',async()=>{
  const c=await setup();try {
    const f=await c.fixture();
    const rule=await c.request('POST',`/api/organizations/${f.org.id}/rules`,{scenario:'WEEKLY_REPORT',title:'周报要求',effectiveFrom:'2026-11-01',requiredFields:['活动名称','活动地点'],requirements:'须填写活动地点'},f.token);
    assert.equal(rule.status,201);
    assert.equal((await c.upload(f.token,f.case.id,1,completeWeekly)).status,201);
    const run=await c.request('POST','/api/agent/requests',{caseId:f.case.id,expectedRevision:2},f.token);
    assert.equal(run.status,202);
    assert.equal((await c.request('POST','/api/agent/requests',{caseId:f.case.id,expectedRevision:2},f.token)).status,409);
    await c.runner.processOne();
    const result=(await c.request('GET',`/api/runs/${run.body.data.runId}`,undefined,f.token)).body.data;
    assert.equal(result.status,'WAITING_FOR_REVIEW');assert.equal(result.mode,'RULES');
    assert.equal(result.output.issues.length,0);
    assert.equal(result.output.records[0].sources.location.locator.line,3);
    assert.equal(result.output.ruleRefs[0].id,rule.body.data.id);
    const docId=result.output.documentId;
    const original=(await c.request('GET',`/api/documents/${docId}`,undefined,f.token)).body.data;
    const changed=original.blocks.map((b:any,i:number)=>i===0?{...b,text:'人工修改标题'}:b);
    assert.equal((await c.request('PUT',`/api/documents/${docId}`,{expectedVersion:1,blocks:changed},f.token)).status,200);
    assert.equal((await c.request('PUT',`/api/documents/${docId}`,{expectedVersion:1,blocks:changed},f.token)).status,409);
    const restored=await c.request('POST',`/api/documents/${docId}/restore`,{expectedVersion:2,sourceVersion:1},f.token);
    assert.equal(restored.body.data.version,3);assert.deepEqual(restored.body.data.blocks,original.blocks);
    const versions=await c.request('GET',`/api/documents/${docId}/versions`,undefined,f.token);
    assert.equal(versions.body.data.length,3);
    const current=(await c.request('GET',`/api/cases/${f.case.id}`,undefined,f.token)).body.data;
    const confirmation=await c.request('POST',`/api/cases/${f.case.id}/confirmations`,{documentId:docId,expectedRevision:current.revision,note:'已逐项核实',acknowledgeIssues:true},f.token);
    assert.equal(confirmation.status,201);
    const command={commandId:randomUUID(),caseId:f.case.id,confirmationId:confirmation.body.data.confirmationId,expectedRevision:current.revision,action:'publish'};
    const published=await c.request('POST','/api/commands',command,f.token);
    assert.equal(published.status,200);assert.equal(published.body.data.status,'PUBLISHED');
    assert.deepEqual((await c.request('POST','/api/commands',command,f.token)).body.data,published.body.data);
    assert.equal((await c.request('POST','/api/commands',{...command,expectedRevision:999},f.token)).status,409);
    assert.equal((await c.request('PUT',`/api/documents/${docId}`,{expectedVersion:3,blocks:changed},f.token)).status,409);
    const events=(await c.request('GET',`/api/events?caseId=${f.case.id}`,undefined,f.token)).body.data;
    assert.deepEqual(events.map((x:any)=>x.seq),events.map((_:unknown,i:number)=>i+1));
    assert.equal(events.filter((x:any)=>x.type==='case.published').length,1);
    const exported=await fetch(c.base+`/api/documents/${docId}/export?version=1`,{headers:{Authorization:`Bearer ${f.token}`}});
    assert.equal(exported.status,200);assert.match(await exported.text(),/核验草稿/);
  }finally{await c.close();}
});

test('XLSX retains cell references; conflicting sources and invalid numbers require review',async()=>{
  const c=await setup();try {
    const f=await c.fixture();
    const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('周报');
    sheet.addRow(['活动名称','活动日期','活动地点','参与人数','活动总结']);
    sheet.addRow(['迎新活动','2026-11-18','B205',-1,'第二份总结']);
    const form=new FormData();form.append('expectedRevision','1');
    form.append('files',new Blob([new Uint8Array(await workbook.xlsx.writeBuffer())]),'weekly.xlsx');
    assert.equal((await fetch(c.base+`/api/cases/${f.case.id}/attachments`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`},body:form})).status,201);
    await c.upload(f.token,f.case.id,2,completeWeekly);
    const run=await c.request('POST','/api/agent/requests',{caseId:f.case.id,expectedRevision:3},f.token);
    await c.runner.processOne();
    const result=(await c.request('GET',`/api/runs/${run.body.data.runId}`,undefined,f.token)).body.data.output;
    assert.ok(result.issues.some((i:any)=>i.code==='SOURCE_CONFLICT' && i.field==='location'));
    assert.ok(result.issues.some((i:any)=>i.code==='INVALID_PARTICIPANTS'));
    assert.ok(result.records.some((r:any)=>r.sources.location.locator.cell==='C2'));
    assert.equal((await c.upload(f.token,f.case.id,1,completeWeekly)).status,409);
    assert.equal((await c.upload(f.token,f.case.id,4,'binary','bad.exe')).status,415);
  }finally{await c.close();}
});

test('confirmation expires on edits; fresh material invalidates generated evidence',async()=>{
  const c=await setup();try {
    const f=await c.fixture();await c.upload(f.token,f.case.id,1,completeWeekly);
    const run=await c.request('POST','/api/agent/requests',{caseId:f.case.id,expectedRevision:2},f.token);
    await c.runner.processOne();
    const result=(await c.request('GET',`/api/runs/${run.body.data.runId}`,undefined,f.token)).body.data.output;
    const confirmation=await c.request('POST',`/api/cases/${f.case.id}/confirmations`,{documentId:result.documentId,expectedRevision:3,note:'已核实',acknowledgeIssues:true},f.token);
    await c.upload(f.token,f.case.id,3,completeWeekly,'another.txt');
    assert.equal((await c.request('POST','/api/commands',{commandId:randomUUID(),caseId:f.case.id,confirmationId:confirmation.body.data.confirmationId,expectedRevision:4,action:'publish'},f.token)).status,409);
    const again=await c.request('POST',`/api/cases/${f.case.id}/confirmations`,{documentId:result.documentId,expectedRevision:4,note:'已核实',acknowledgeIssues:true},f.token);
    assert.equal(again.body.code,'EVIDENCE_STALE');
  }finally{await c.close();}
});

test('durable queued tasks survive reopening; cancellation and expired leases are respected',async()=>{
  const c=await setup();try {
    const f=await c.fixture();await c.upload(f.token,f.case.id,1,completeWeekly);
    const first=await c.request('POST','/api/agent/requests',{caseId:f.case.id,expectedRevision:2},f.token);
    await c.request('POST',`/api/runs/${first.body.data.runId}/control`,{action:'cancel'},f.token);
    assert.equal(await c.runner.processOne(),false);
    assert.equal((await c.request('GET',`/api/runs/${first.body.data.runId}`,undefined,f.token)).body.data.status,'CANCELLED');
    const queued=await c.request('POST','/api/agent/requests',{caseId:f.case.id,expectedRevision:2},f.token);
    const secondConnection=await new Store({dataDir:c.dataDir,databaseUrl:process.env.TEST_DATABASE_URL||'',host:'127.0.0.1',port:3080,embeddedWorker:false,frontendOrigin:'',sessionHours:1}).open();
    assert.equal((await secondConnection.get('SELECT status FROM runs WHERE id=?',[queued.body.data.runId]))!.status,'QUEUED');
    await secondConnection.run("UPDATE runs SET status='RUNNING',lease_owner=?,lease_until=? WHERE id=?",[randomUUID(),'2000-01-01T00:00:00.000Z',queued.body.data.runId]);
    await secondConnection.close();
    await c.runner.processOne();
    assert.equal((await c.request('GET',`/api/runs/${queued.body.data.runId}`,undefined,f.token)).body.data.status,'WAITING_FOR_REVIEW');
  }finally{await c.close();}
});

test('changing inputs before queued execution fails without creating an obsolete document',async()=>{
  const c=await setup();try {
    const f=await c.fixture();await c.upload(f.token,f.case.id,1,completeWeekly);
    const run=await c.request('POST','/api/agent/requests',{caseId:f.case.id,expectedRevision:2},f.token);
    await c.request('PATCH',`/api/cases/${f.case.id}`,{expectedRevision:2,data:{location:'B205'}},f.token);
    await c.runner.processOne();
    const final=(await c.request('GET',`/api/runs/${run.body.data.runId}`,undefined,f.token)).body.data;
    assert.equal(final.status,'FAILED');assert.match(final.error,/变化/);
    const row=await c.db.get('SELECT COUNT(*) AS count FROM documents WHERE case_id=?',[f.case.id]);
    assert.equal(Number(row!.count),0);
  }finally{await c.close();}
});

test('onboarding checklist reports missing materials and preserves manual review limitation',async()=>{
  const c=await setup();try {
    const f=await c.fixture('ONBOARDING');
    await c.request('PATCH',`/api/cases/${f.case.id}`,{expectedRevision:1,data:{employeeName:'张三',position:'开发',startDate:'2026-11-18',requiredMaterials:['身份证明','学历证明']}},f.token);
    await c.upload(f.token,f.case.id,2,'身份证明：已提交\n姓名：张三','identity.txt');
    const run=await c.request('POST','/api/agent/requests',{caseId:f.case.id,expectedRevision:3},f.token);
    await c.runner.processOne();
    const result=(await c.request('GET',`/api/runs/${run.body.data.runId}`,undefined,f.token)).body.data.output;
    assert.ok(result.issues.some((i:any)=>i.code==='MISSING_MATERIAL'&&i.field==='学历证明'));
    assert.ok(result.issues.some((i:any)=>i.code==='MANUAL_AUTHENTICITY'));
  }finally{await c.close();}
});

test('SSE replays only events after Last-Event-ID',async()=>{
  const c=await setup();try {
    const f=await c.fixture();await c.upload(f.token,f.case.id,1,completeWeekly);
    const controller=new AbortController();
    const response=await fetch(c.base+`/api/events?caseId=${f.case.id}&stream=true`,{headers:{Authorization:`Bearer ${f.token}`,'Last-Event-ID':'1'},signal:controller.signal});
    assert.equal(response.status,200);assert.match(response.headers.get('content-type')!,/text\/event-stream/);
    const reader=response.body!.getReader();let text='';
    while(!text.includes('attachments.added')){
      const chunk=await reader.read();assert.equal(chunk.done,false);text+=new TextDecoder().decode(chunk.value);
    }
    assert.match(text,/id: 2/);assert.doesNotMatch(text,/event: case.created/);
    controller.abort();await reader.cancel().catch(()=>{});
  }finally{await c.close();}
});

test('assigned submitter can upload only to their own case and cannot run or publish',async()=>{
  const c=await setup();try {
    const f=await c.fixture(),submitter=await c.register('submitter');
    await c.request('POST',`/api/organizations/${f.org.id}/members`,{username:'submitter',role:'SUBMITTER'},f.token);
    const own=await c.request('POST','/api/cases',{orgId:f.org.id,title:'分配填报',scenario:'WEEKLY_REPORT',businessDate:'2026-11-18',submitterId:submitter.user.id},f.token);
    assert.equal(own.status,201);
    assert.equal((await c.upload(submitter.token,own.body.data.id,1,completeWeekly)).status,201);
    assert.equal((await c.upload(submitter.token,f.case.id,1,completeWeekly)).status,404);
    const list=await c.request('GET',`/api/cases?orgId=${f.org.id}`,undefined,submitter.token);
    assert.deepEqual(list.body.data.map((x:any)=>x.id),[own.body.data.id]);
    assert.equal((await c.request('POST','/api/agent/requests',{caseId:own.body.data.id,expectedRevision:2},submitter.token)).status,403);
    assert.equal((await c.request('PATCH',`/api/cases/${own.body.data.id}`,{expectedRevision:2,title:'bad'},submitter.token)).status,403);
  }finally{await c.close();}
});

test('concurrent writes preserve one winning document version',async()=>{
  const c=await setup();try {
    const f=await c.fixture();
    const doc=await c.request('POST',`/api/cases/${f.case.id}/documents`,{expectedRevision:1,title:'手工草稿',blocks:[{id:randomUUID(),type:'paragraph',text:'原文'}]},f.token);
    assert.equal(doc.status,201);
    const responses=await Promise.all(['修改一','修改二'].map(text=>c.request('PUT',`/api/documents/${doc.body.data.documentId}`,{expectedVersion:1,blocks:[{id:randomUUID(),type:'paragraph',text}]},f.token)));
    assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
    const versions=await c.request('GET',`/api/documents/${doc.body.data.documentId}/versions`,undefined,f.token);
    assert.equal(versions.body.data.length,2);
  }finally{await c.close();}
});

test('new applicable rule invalidates publication even after confirmation',async()=>{
  const c=await setup();try {
    const f=await c.fixture();await c.upload(f.token,f.case.id,1,completeWeekly);
    const run=await c.request('POST','/api/agent/requests',{caseId:f.case.id,expectedRevision:2},f.token);
    await c.runner.processOne();
    const result=(await c.request('GET',`/api/runs/${run.body.data.runId}`,undefined,f.token)).body.data.output;
    const confirmation=await c.request('POST',`/api/cases/${f.case.id}/confirmations`,{documentId:result.documentId,expectedRevision:3,note:'已核实',acknowledgeIssues:true},f.token);
    assert.equal(confirmation.status,201);
    await c.request('POST',`/api/organizations/${f.org.id}/rules`,{scenario:'WEEKLY_REPORT',title:'新增通知',effectiveFrom:'2026-11-17',requiredFields:['summary']},f.token);
    const response=await c.request('POST','/api/commands',{commandId:randomUUID(),caseId:f.case.id,confirmationId:confirmation.body.data.confirmationId,expectedRevision:3,action:'publish'},f.token);
    assert.equal(response.status,409);assert.equal(response.body.code,'EVIDENCE_STALE');
    assert.equal((await c.db.get('SELECT status FROM cases WHERE id=?',[f.case.id]))!.status,'OPEN');
  }finally{await c.close();}
});

test('DOCX text extraction works and malformed, formula and reserved-field files are rejected',async()=>{
  const c=await setup();try {
    const f=await c.fixture();
    const zip=new JSZip();
    zip.file('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml','<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>活动名称：文档活动</w:t></w:r></w:p></w:body></w:document>');
    const form=new FormData();form.append('expectedRevision','1');form.append('files',new Blob([new Uint8Array(await zip.generateAsync({type:'nodebuffer'}))]),'sample.docx');
    const response=await fetch(c.base+`/api/cases/${f.case.id}/attachments`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`},body:form});
    assert.equal(response.status,201);const body=await response.json() as any;
    assert.equal(body.data.attachments[0].parsed.records[0].fields.activityName,'文档活动');
    assert.equal((await c.upload(f.token,f.case.id,2,'not a zip','bad.docx')).status,422);
    assert.equal((await c.upload(f.token,f.case.id,2,'constructor: bad')).status,422);
    const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('周报');sheet.addRow(['活动名称','参与人数']);
    sheet.addRow(['活动',{formula:'1+1',result:2}]);
    const formula=new FormData();formula.append('expectedRevision','2');formula.append('files',new Blob([new Uint8Array(await workbook.xlsx.writeBuffer())]),'formula.xlsx');
    const rejected=await fetch(c.base+`/api/cases/${f.case.id}/attachments`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`},body:formula});
    assert.equal(rejected.status,422);assert.equal(((await rejected.json()) as any).code,'FORMULA_NOT_SUPPORTED');
  }finally{await c.close();}
});
