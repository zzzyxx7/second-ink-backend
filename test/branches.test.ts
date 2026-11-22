import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer,type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setup,completeWeekly } from './helpers.js';
import { responseSchemas } from '../src/openapi.js';
import { hash } from '../src/auth.js';
import { verifyFull,type RunInput } from '../src/verification.js';
type Context=Awaited<ReturnType<typeof setup>>;

async function fixture(c:Context,scenario='WEEKLY_REPORT',model=false,maxModelCalls=4){
  const f=await c.fixture(scenario);let revision=1;
  if(scenario==='ONBOARDING'){
    await c.request('PATCH',`/api/cases/${f.case.id}`,{expectedRevision:revision++,data:{employeeName:'张三',position:'开发',startDate:'2026-11-18',requiredMaterials:['身份证明','学历证明']}},f.token);
  }
  const uploaded=await c.upload(f.token,f.case.id,revision++,scenario==='WEEKLY_REPORT'?completeWeekly:'员工姓名：张三\n岗位：开发\n入职日期：2026-11-18\n身份证明：已提交\n学历证明：已提交');assert.equal(uploaded.status,201);
  const templates=(await c.request('GET','/api/team-templates',undefined,f.token)).body.data;
  const definition={...templates.find((t:any)=>t.scenario===scenario),maxModelCalls};
  const team=(await c.request('POST',`/api/organizations/${f.org.id}/teams`,definition,f.token)).body.data;
  assert.equal((await c.request('POST',`/api/teams/${team.teamId}/versions/1/publish`,{},f.token)).status,200);
  let report:any;
  if(model){
    const doc=(await c.request('POST',`/api/cases/${f.case.id}/documents`,{expectedRevision:revision++,title:'原文档',blocks:[{id:randomUUID(),type:'heading',text:'原文'}]},f.token)).body.data;
    const templates=(await c.request('GET','/api/skill-templates',undefined,f.token)).body.data;
    const skill=(await c.request('POST',`/api/organizations/${f.org.id}/skills`,templates.find((s:any)=>s.scenario===scenario),f.token)).body.data;
    await c.request('POST',`/api/skills/${skill.skillId}/versions/1/trials`,{caseId:f.case.id},f.token);
    await c.request('POST',`/api/skills/${skill.skillId}/versions/1/publish`,{},f.token);
    report={documentId:doc.documentId,expectedDocumentVersion:1,blockIds:[doc.blocks[0].id],goal:'精简',skillId:skill.skillId,skillVersion:1};
  }
  const queued=await c.request('POST','/api/agent/requests',{caseId:f.case.id,expectedRevision:revision,mode:'TEAM',teamId:team.teamId,teamVersion:1,...(report?{report}:{})},f.token);
  assert.equal(queued.status,202,JSON.stringify(queued.body));return {...f,team,definition,report,revision,runId:queued.body.data.runId};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function run(c:Context,f:Fixture,runId=f.runId){const r=await c.request('GET',`/api/runs/${runId}`,undefined,f.token);responseSchemas.Run.parse(r.body);return r.body.data;}
async function current(c:Context,f:Fixture){const r=await c.request('GET',`/api/cases/${f.case.id}`,undefined,f.token);responseSchemas.CaseDetail.parse(r.body);return r.body.data;}
async function checkpoints(c:Context,f:Fixture,runId=f.runId){const r=await c.request('GET',`/api/runs/${runId}/checkpoints`,undefined,f.token);responseSchemas.Checkpoints.parse(r.body);return r.body.data;}
async function control(c:Context,f:Fixture,action:string,extra:Record<string,unknown>={}){
  const view=await run(c,f);return c.request('POST',`/api/runs/${f.runId}/control`,{action,scope:'team',controlId:randomUUID(),expectedControlRevision:view.team.controlRevision,...extra},f.token);
}
async function pauseReport(c:Context,f:Fixture){await control(c,f,'pause',{scope:'branch',nodeId:'report'});await c.runner.processOne();assert.equal((await run(c,f)).status,'PAUSED');}
async function preview(c:Context,f:Fixture,extra:Record<string,unknown>={}){
  const result=await c.request('POST',`/api/runs/${f.runId}/amendments`,{expectedRevision:(await current(c,f)).revision,...extra},f.token);
  assert.equal(result.status,201,JSON.stringify(result.body));responseSchemas.Amendment.parse(result.body);return result.body.data;
}
async function branch(c:Context,f:Fixture,p:any,commandId=randomUUID()){
  const result=await c.request('POST',`/api/runs/${f.runId}/branches`,{previewId:p.previewId,previewDigest:p.previewDigest,commandId},f.token);
  assert.equal(result.status,202,JSON.stringify(result.body));responseSchemas.Branch.parse(result.body);return result.body.data;
}
async function worker(c:Context){
  const child=spawn(process.execPath,[fileURLToPath(new URL('./team-recovery-child.js',import.meta.url)),c.dataDir],{stdio:['ignore','pipe','pipe']});let output='';
  child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  assert.equal(await new Promise(resolve=>child.once('exit',resolve)),0,output);
}

test('AMEND reuses three read nodes, fences the old branch and creates one fresh draft after worker restart',async()=>{
  const c=await setup();try{
    const f=await fixture(c);await pauseReport(c,f);const before=await checkpoints(c,f);
    const p=await preview(c,f);assert.deepEqual(p.nodes.map((n:any)=>n.action),['REUSE','REUSE','REUSE','RECOMPUTE']);assert.equal(p.verification.mode,'REUSED_NODE');
    const commandId=randomUUID(),child=await branch(c,f,p,commandId);assert.deepEqual(await branch(c,f,p,commandId),child);
    assert.equal(child.parentRunId,f.runId);assert.notEqual(child.branchId,(await run(c,f)).lineage.branchId);assert.equal(child.planVersion,2);
    assert.equal((await run(c,f)).status,'SUPERSEDED');assert.equal((await control(c,f,'resume')).body.code,'BRANCH_SUPERSEDED');
    const copied=await run(c,f,child.runId);assert.equal(copied.reuse.nodes.length,3);assert.ok(copied.team.nodes.filter((n:any)=>n.role!=='REPORT').every((n:any)=>n.attempt===0&&n.reusedFrom));
    await worker(c);const done=await run(c,f,child.runId);assert.equal(done.status,'WAITING_FOR_REVIEW');assert.equal(done.output.verification.mode,'REUSED_NODE');
    assert.equal(done.team.nodes.find((n:any)=>n.role==='REPORT').attempt,1);assert.equal((await current(c,f)).documents.length,1);
    assert.deepEqual((await checkpoints(c,f)).map((p:any)=>p.digest),before.map((p:any)=>p.digest));
    const family=await c.request('GET',`/api/runs/${child.runId}/branches`,undefined,f.token);responseSchemas.Branches.parse(family.body);assert.equal(family.body.data.filter((b:any)=>b.isCurrent).length,1);
    const events=(await c.request('GET',`/api/events?caseId=${f.case.id}`,undefined,f.token)).body.data;assert.ok(events.some((e:any)=>e.type==='run.branch_created'&&e.data.rootRunId===f.runId&&e.data.planVersion===2));
  }finally{await c.close();}
});

for(const scenario of ['WEEKLY_REPORT','ONBOARDING'])test(`${scenario} correction recomputes affected decisions and preserves original evidence`,async()=>{
  const c=await setup();try{
    const f=await fixture(c,scenario);await pauseReport(c,f);
    const record=(await c.request('GET',`/api/cases/${f.case.id}/records`,undefined,f.token)).body.data.attachments[0];
    const field=scenario==='WEEKLY_REPORT'?'location':'position',value=scenario==='WEEKLY_REPORT'?'B205':'后端工程师';
    const corrected=await c.request('POST',`/api/cases/${f.case.id}/field-corrections`,{expectedRevision:f.revision,attachmentId:record.attachmentId,recordId:record.records[0].id,field,value,reason:'原件人工复核'},f.token);assert.equal(corrected.status,201);
    const p=await preview(c,f);assert.equal(p.nodes.find((n:any)=>n.nodeId==='policy').action,'REUSE');assert.equal(p.nodes.find((n:any)=>n.nodeId==='verify').action,'RECOMPUTE');assert.ok(p.verification.reused>0&&p.verification.executed>0);
    const child=await branch(c,f,p);await c.runner.processOne();const done=await run(c,f,child.runId);assert.equal(done.status,'WAITING_FOR_REVIEW');
    const verification=done.team.nodes.find((n:any)=>n.role==='VERIFY').output;
    const frozen:RunInput=JSON.parse((await c.db.get('SELECT input_json FROM runs WHERE id=?',[child.runId]))!.input_json);
    const {decisions,verification:stats,...facts}=verification;assert.deepEqual(facts,verifyFull(frozen));
    const changed=verification.records.find((r:any)=>r.corrections?.[field]);assert.equal(changed.fields[field],value);assert.ok(changed.sources[field].quote.includes(scenario==='WEEKLY_REPORT'?'B203':'开发'));assert.equal(changed.corrections[field].id,corrected.body.data.correctionId);
    const source=JSON.parse((await c.db.get('SELECT input_json FROM runs WHERE id=?',[f.runId]))!.input_json);assert.notEqual(source.attachments[0].parsed.records[0].fields[field],value);
  }finally{await c.close();}
});

test('historical branching preserves documents and confirmations but requires a new draft and confirmation',async()=>{
  const c=await setup();try{
    const f=await fixture(c);await c.runner.processOne();const old=await run(c,f),cp=(await checkpoints(c,f))[0];
    const confirmation=await c.request('POST',`/api/cases/${f.case.id}/confirmations`,{expectedRevision:(await current(c,f)).revision,documentId:old.output.documentId,note:'已核查',acknowledgeIssues:true},f.token);assert.equal(confirmation.status,201);
    const p=await preview(c,f,{kind:'HISTORY',checkpointId:cp.id}),commandId=randomUUID(),child=await branch(c,f,p,commandId);
    assert.equal(Number((await c.db.get('SELECT COUNT(*) AS n FROM commands WHERE case_id=?',[f.case.id]))!.n),0);
    const stale=await c.request('POST','/api/commands',{action:'publish',commandId:randomUUID(),caseId:f.case.id,confirmationId:confirmation.body.data.confirmationId,expectedRevision:child.caseRevision},f.token);assert.equal(stale.status,409);
    const oldConfirm=await c.request('POST',`/api/cases/${f.case.id}/confirmations`,{expectedRevision:child.caseRevision,documentId:old.output.documentId,note:'旧稿',acknowledgeIssues:true},f.token);assert.equal(oldConfirm.body.code,'EVIDENCE_STALE');
    await c.runner.processOne();const done=await run(c,f,child.runId);assert.notEqual(done.output.documentId,old.output.documentId);assert.equal((await current(c,f)).documents.length,2);
    const confirmed=(await c.request('POST',`/api/cases/${f.case.id}/confirmations`,{expectedRevision:(await current(c,f)).revision,documentId:done.output.documentId,note:'新分支已核查',acknowledgeIssues:true},f.token)).body.data;
    assert.equal((await c.request('POST','/api/commands',{action:'publish',commandId:randomUUID(),caseId:f.case.id,confirmationId:confirmed.confirmationId,expectedRevision:confirmed.caseRevision},f.token)).status,200);
    assert.equal((await c.request('POST',`/api/runs/${f.runId}/amendments`,{kind:'HISTORY',checkpointId:cp.id,expectedRevision:(await current(c,f)).revision},f.token)).status,409);
    assert.deepEqual(await branch(c,f,p,commandId),child);
  }finally{await c.close();}
});

test('material selection replaces active evidence while original bytes and correction history remain accessible',async()=>{
  const c=await setup();try{
    const f=await fixture(c);await pauseReport(c,f);const old=(await current(c,f)).attachments[0];
    const record=(await c.request('GET',`/api/cases/${f.case.id}/records`,undefined,f.token)).body.data.attachments[0].records[0];
    assert.equal((await c.request('POST',`/api/cases/${f.case.id}/field-corrections`,{expectedRevision:2,attachmentId:old.id,recordId:record.id,field:'location',value:'B205',reason:'原件补正'},f.token)).status,201);
    const replacement=await c.upload(f.token,f.case.id,3,completeWeekly.replace('B203','B206'),'replacement.txt');assert.equal(replacement.status,201,JSON.stringify(replacement.body));const fresh=replacement.body.data.attachments[0];
    const selected=await c.request('POST',`/api/cases/${f.case.id}/material-selection`,{expectedRevision:4,activeAttachmentIds:[fresh.id],reason:'使用补交材料'},f.token);assert.equal(selected.status,200);responseSchemas.MaterialSelection.parse(selected.body);
    const detail=await current(c,f);assert.equal(detail.attachments.find((a:any)=>a.id===old.id).active,false);
    const records=await c.request('GET',`/api/cases/${f.case.id}/records`,undefined,f.token);responseSchemas.Records.parse(records.body);assert.equal(records.body.data.attachments.find((a:any)=>a.attachmentId===old.id).records[0].corrections.location.value,'B205');
    const download=await fetch(`${c.base}/api/attachments/${old.id}/download`,{headers:{Authorization:`Bearer ${f.token}`}});assert.equal(await download.text(),completeWeekly);
    const p=await preview(c,f),child=await branch(c,f,p);await c.runner.processOne();const done=await run(c,f,child.runId);assert.equal(done.output.records.length,1);assert.equal(done.output.records[0].fields.location,'B206');
    const refs=await c.service.evidenceRefs(c.db,f.case.id);assert.ok(!refs.has(`attachment:${old.id}`));assert.ok(![...refs].some(ref=>ref.startsWith('correction:')));
    const uploaded=await c.upload(f.token,f.case.id,(await current(c,f)).revision,completeWeekly,'third.txt');assert.equal(uploaded.status,201);assert.equal((await current(c,f)).attachments.filter((a:any)=>a.active).length,2);
    const invalid=await c.request('POST',`/api/cases/${f.case.id}/material-selection`,{expectedRevision:(await current(c,f)).revision,activeAttachmentIds:[randomUUID()],reason:'无效材料'},f.token);assert.equal(invalid.status,422);
  }finally{await c.close();}
});

test('previews reject expired, changed facts, changed controls and disabled definitions',async()=>{
  const c=await setup();try{
    const f=await fixture(c);await pauseReport(c,f);let p=await preview(c,f);
    const submit=(p:any)=>c.request('POST',`/api/runs/${f.runId}/branches`,{previewId:p.previewId,previewDigest:p.previewDigest,commandId:randomUUID()},f.token);
    assert.equal((await submit({...p,previewDigest:'0'.repeat(64)})).body.code,'PREVIEW_CONFLICT');
    await c.db.run('UPDATE amendment_previews SET expires_at=? WHERE id=?',['2000-01-01T00:00:00.000Z',p.previewId]);assert.equal((await submit(p)).body.code,'PREVIEW_EXPIRED');
    p=await preview(c,f);await control(c,f,'pause');assert.equal((await submit(p)).body.code,'CHECKPOINT_CONFLICT');
    p=await preview(c,f);await c.request('PATCH',`/api/cases/${f.case.id}`,{expectedRevision:f.revision,data:{changed:'new'}},f.token);assert.equal((await submit(p)).status,409);
    p=await preview(c,f);await c.request('POST',`/api/teams/${f.team.teamId}/versions/1/disable`,{},f.token);assert.equal((await submit(p)).body.code,'TEAM_DISABLED');
    assert.equal((await run(c,f)).status,'PAUSED');assert.equal(Number((await c.db.get('SELECT COUNT(*) AS n FROM run_lineage WHERE root_run_id=?',[f.runId]))!.n),1);
  }finally{await c.close();}
});

test('only one concurrent branch wins; tenants, submitters and nonpaused executions cannot create branches',async()=>{
  const c=await setup();try{
    const f=await fixture(c);assert.equal((await c.request('POST',`/api/runs/${f.runId}/amendments`,{expectedRevision:f.revision},f.token)).body.code,'PAUSE_REQUIRED');await pauseReport(c,f);
    const p=await preview(c,f),outsider=await c.register('branch_outsider');
    assert.equal((await c.request('POST',`/api/runs/${f.runId}/amendments`,{expectedRevision:f.revision},outsider.token)).status,404);
    assert.equal((await c.request('POST',`/api/runs/${f.runId}/branches`,{previewId:p.previewId,previewDigest:p.previewDigest,commandId:randomUUID()},outsider.token)).status,404);
    await c.request('POST',`/api/organizations/${f.org.id}/members`,{username:outsider.user.username,role:'SUBMITTER'},f.token);
    assert.equal((await c.request('POST',`/api/runs/${f.runId}/amendments`,{expectedRevision:f.revision},outsider.token)).status,403);
    const results=await Promise.all([1,2].map(()=>c.request('POST',`/api/runs/${f.runId}/branches`,{previewId:p.previewId,previewDigest:p.previewDigest,commandId:randomUUID()},f.token)));
    assert.deepEqual(results.map(r=>r.status).sort(),[202,409]);assert.equal(Number((await c.db.get("SELECT COUNT(*) AS n FROM runs WHERE case_id=? AND status='QUEUED'",[f.case.id]))!.n),1);
  }finally{await c.close();}
});

test('checkpoint corruption and missing originals fail without changing the active head',async()=>{
  const c=await setup();try{
    const f=await fixture(c);await pauseReport(c,f);const cp=(await c.db.get('SELECT * FROM run_checkpoints WHERE run_id=? ORDER BY event_seq DESC LIMIT 1',[f.runId]))!;
    const attempt=()=>c.request('POST',`/api/runs/${f.runId}/amendments`,{expectedRevision:f.revision},f.token);
    await c.db.run('UPDATE run_checkpoints SET digest=? WHERE id=?',['bad',cp.id]);assert.equal((await attempt()).body.code,'CHECKPOINT_CORRUPT');
    await c.db.run('UPDATE run_checkpoints SET digest=? WHERE id=?',[cp.digest,cp.id]);
    const file=(await c.db.get('SELECT stored_name FROM attachments WHERE case_id=?',[f.case.id]))!,filename=path.join(c.dataDir,'attachments',file.stored_name),original=await readFile(filename);
    await writeFile(filename,'被篡改');assert.equal((await attempt()).body.code,'CHECKPOINT_CORRUPT');await writeFile(filename,original);
    assert.equal((await current(c,f)).currentRunId,f.runId);await preview(c,f);
  }finally{await c.close();}
});

test('a changed team version and an initial historical checkpoint cannot reuse incompatible node outputs',async()=>{
  const c=await setup();try{
    const f=await fixture(c);await pauseReport(c,f);const original=(await run(c,f)).team.teamDigest;
    const {name,...definition}=f.definition;
    const version=await c.request('POST',`/api/teams/${f.team.teamId}/versions`,{...definition,concurrency:1},f.token);assert.equal(version.status,201);
    await c.request('POST',`/api/teams/${f.team.teamId}/versions/2/publish`,{},f.token);
    const p=await preview(c,f,{teamId:f.team.teamId,teamVersion:2});assert.ok(p.nodes.every((n:any)=>n.action==='RECOMPUTE'));
    const child=await branch(c,f,p);await c.runner.processOne();const done=await run(c,f,child.runId);assert.equal(done.team.teamVersion,2);assert.notEqual(done.team.teamDigest,original);assert.equal(done.reuse.nodes.length,0);
    const initial=(await checkpoints(c,f)).at(-1),historical=await preview(c,f,{kind:'HISTORY',checkpointId:initial.id,teamId:f.team.teamId,teamVersion:2});assert.ok(historical.nodes.every((n:any)=>n.action==='RECOMPUTE'));assert.equal(historical.verification.reused,0);
  }finally{await c.close();}
});

test('legacy checkpoints remain immutable and conservatively run a full verification',async()=>{
  const c=await setup();try{
    const f=await fixture(c);await pauseReport(c,f);
    const source=(await c.db.get('SELECT input_json FROM runs WHERE id=?',[f.runId]))!,old=JSON.parse(source.input_json);delete old.verificationEngineVersion;const inputJson=JSON.stringify(old);
    await c.db.run('UPDATE runs SET input_json=? WHERE id=?',[inputJson,f.runId]);
    const cps=await c.db.all('SELECT * FROM run_checkpoints WHERE run_id=?',[f.runId]);
    for(const cp of cps){const snapshot=JSON.parse(cp.snapshot_json);delete snapshot.cacheVersion;delete snapshot.lineage;snapshot.inputDigest=hash(inputJson);snapshot.completedSteps.forEach((s:any)=>{delete s.fingerprint;if(s.nodeId==='verify'){delete s.output.decisions;delete s.output.verification;s.outputDigest=hash(JSON.stringify(s.output));}});const json=JSON.stringify(snapshot);await c.db.run('UPDATE run_checkpoints SET snapshot_json=?,digest=? WHERE id=?',[json,hash(json),cp.id]);}
    const historic=(await checkpoints(c,f)).map((p:any)=>p.digest),p=await preview(c,f);assert.ok(p.nodes.every((n:any)=>n.action==='RECOMPUTE'));assert.equal(p.verification.fallbackReason,'LEGACY_DEPENDENCIES');
    const child=await branch(c,f,p);await c.runner.processOne();const done=await run(c,f,child.runId);assert.equal(done.output.verification.reused,0);assert.equal(done.output.verification.mode,'FULL');assert.deepEqual((await checkpoints(c,f)).map((p:any)=>p.digest),historic);
  }finally{await c.close();}
});

async function provider(holdFirst=false){
  let count=0,held:ServerResponse|undefined,heldInput:any,resolve!:()=>void;const first=new Promise<void>(r=>{resolve=r;});
  const reply=(input:any,res:ServerResponse)=>res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({replacements:[{blockId:input.targetBlocks[0].id,text:'修订报告'}],reason:'来源核查',evidenceRefs:[input.evidenceRefs[0]]})}}]}));
  const server=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);const input=JSON.parse(JSON.parse(Buffer.concat(chunks).toString()).messages[1].content);count++;resolve();if(holdFirst&&count===1){held=res;heldInput=input;}else reply(input,res);});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {config:{baseUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,name:'branch-stub',apiKey:'local',timeoutMs:2000},first,get count(){return count;},late:()=>reply(heldInput,held!),close:async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}};
}

test('root model budget survives multiple historical forks and old pending patches become superseded',async()=>{
  const model=await provider(),c=await setup({model:model.config});try{
    const f=await fixture(c,'WEEKLY_REPORT',true,2);await c.runner.processOne();const first=await run(c,f),cp=(await checkpoints(c,f)).find((p:any)=>p.snapshot.completedSteps.length===3);
    const p=await preview(c,f,{kind:'HISTORY',checkpointId:cp.id,report:{...f.report,goal:'新的报告要求'}}),child=await branch(c,f,p);assert.equal(p.budget.used,1);assert.equal(p.nodes.filter((n:any)=>n.action==='REUSE').length,3);
    const oldPatch=await c.request('POST',`/api/patches/${first.output.patchId}/accept`,{expectedVersion:1},f.token);assert.equal(oldPatch.body.code,'PATCH_SUPERSEDED');
    await c.runner.processOne();const done=await run(c,f,child.runId);assert.equal(done.team.modelCalls,1);assert.equal(done.team.rootModelCalls,2);assert.equal(model.count,2);
    const exhausted=await c.request('POST',`/api/runs/${f.runId}/amendments`,{kind:'HISTORY',checkpointId:cp.id,expectedRevision:(await current(c,f)).revision},f.token);assert.equal(exhausted.body.code,'MODEL_BUDGET_EXCEEDED');
    const rules=await preview(c,f,{kind:'HISTORY',checkpointId:cp.id,report:null}),rulesChild=await branch(c,f,rules);await c.runner.processOne();assert.equal((await run(c,f,rulesChild.runId)).team.rootModelCalls,2);assert.equal(model.count,2);assert.equal(rulesChild.planVersion,3);
    const family=(await c.request('GET',`/api/runs/${f.runId}/branches`,undefined,f.token)).body.data;assert.deepEqual(family.map((b:any)=>b.planVersion),[1,2,3]);assert.ok(family.every((b:any)=>b.rootRunId===f.runId));
  }finally{await c.close();await model.close();}
});

test('paused model amendment rejects late old output and model config changes invalidate a preview',async()=>{
  const model=await provider(true),c=await setup({model:model.config});try{
    const f=await fixture(c,'WEEKLY_REPORT',true);const processing=c.runner.processOne();await model.first;await control(c,f,'pause');await processing;assert.equal((await run(c,f)).status,'PAUSED');
    let p=await preview(c,f);const originalName=c.service.config.model!.name;c.service.config.model!.name='different-model';
    assert.equal((await c.request('POST',`/api/runs/${f.runId}/branches`,{previewId:p.previewId,previewDigest:p.previewDigest,commandId:randomUUID()},f.token)).body.code,'PREVIEW_STALE');c.service.config.model!.name=originalName;
    p=await preview(c,f,{report:{...f.report,goal:'分支目标'}});const child=await branch(c,f,p);model.late();await c.runner.processOne();const done=await run(c,f,child.runId);assert.equal(done.status,'WAITING_FOR_REVIEW');
    assert.equal(Number((await c.db.get('SELECT COUNT(*) AS n FROM patches WHERE source_run_id=?',[f.runId]))!.n),0);assert.equal(Number((await c.db.get('SELECT COUNT(*) AS n FROM patches WHERE source_run_id=?',[child.runId]))!.n),1);assert.equal(done.team.rootModelCalls,2);
  }finally{await c.close();await model.close();}
});
