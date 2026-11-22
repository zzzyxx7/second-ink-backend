import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer,type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setup,completeWeekly } from './helpers.js';
import { responseSchemas } from '../src/openapi.js';
type Context=Awaited<ReturnType<typeof setup>>;

async function fixture(c:Context,model=false,options:Record<string,unknown>={},scenario:'WEEKLY_REPORT'|'ONBOARDING'='WEEKLY_REPORT'){
  const f=await c.fixture(scenario);let initialRevision=1;
  if(scenario==='ONBOARDING'){
    await c.request('PATCH',`/api/cases/${f.case.id}`,{expectedRevision:1,data:{employeeName:'张三',position:'后端开发',startDate:'2026-11-18',requiredMaterials:['身份证明','学历证明']}},f.token);initialRevision=2;
  }
  await c.upload(f.token,f.case.id,initialRevision,scenario==='WEEKLY_REPORT'?completeWeekly:'员工姓名：张三\n岗位：后端开发\n入职日期：2026-11-18\n身份证明：已提交\n学历证明：已提交');
  const templates=(await c.request('GET','/api/team-templates',undefined,f.token)).body.data;
  const definition={...templates.find((t:any)=>t.scenario===scenario),...options};
  const created=await c.request('POST',`/api/organizations/${f.org.id}/teams`,definition,f.token);assert.equal(created.status,201,JSON.stringify(created.body));
  const team=created.body.data;
  assert.equal((await c.request('POST',`/api/teams/${team.teamId}/versions/1/publish`,{},f.token)).status,200);
  let report:any,revision=initialRevision+1;
  if(model){
    const doc=(await c.request('POST',`/api/cases/${f.case.id}/documents`,{expectedRevision:revision,title:'团队报告',blocks:[{id:randomUUID(),type:'heading',text:'原报告'}]},f.token)).body.data;
    revision++;
    const skills=(await c.request('GET','/api/skill-templates',undefined,f.token)).body.data;
    const skill=(await c.request('POST',`/api/organizations/${f.org.id}/skills`,skills.find((s:any)=>s.scenario===scenario),f.token)).body.data;
    assert.equal((await c.request('POST',`/api/skills/${skill.skillId}/versions/1/trials`,{caseId:f.case.id},f.token)).body.data.passed,true);
    await c.request('POST',`/api/skills/${skill.skillId}/versions/1/publish`,{},f.token);
    report={documentId:doc.documentId,expectedDocumentVersion:1,blockIds:[doc.blocks[0].id],goal:'精简报告',skillId:skill.skillId,skillVersion:1};
  }
  const queued=await c.request('POST','/api/agent/requests',{caseId:f.case.id,expectedRevision:revision,mode:'TEAM',teamId:team.teamId,teamVersion:1,...(report?{report}:{})},f.token);
  assert.equal(queued.status,202,JSON.stringify(queued.body));
  return {...f,team,runId:queued.body.data.runId,revision,report,definition};
}
async function view(c:Context,f:Awaited<ReturnType<typeof fixture>>){const response=await c.request('GET',`/api/runs/${f.runId}`,undefined,f.token);responseSchemas.Run.parse(response.body);return response.body.data;}
async function control(c:Context,f:Awaited<ReturnType<typeof fixture>>,action:string,extras:Record<string,unknown>={}){
  const current=await view(c,f);
  return c.request('POST',`/api/runs/${f.runId}/control`,{action,scope:'team',controlId:randomUUID(),expectedControlRevision:current.team.controlRevision,...extras},f.token);
}
async function provider(handler?:(count:number,input:any,res:ServerResponse)=>void){
  let count=0,resolve!:(input:any)=>void;const first=new Promise<any>(r=>{resolve=r;});
  const server=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8')),input=JSON.parse(body.messages[1].content);resolve(input);count++;
    if(handler)handler(count,input,res);else reply(input,res);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {config:{baseUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,name:'team-stub',apiKey:'local-test',timeoutMs:2000},first,get count(){return count;},close:async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}};
}
function reply(input:any,res:ServerResponse){res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({replacements:[{blockId:input.targetBlocks[0].id,text:'团队核验后的报告'}],reason:'根据证据修改',evidenceRefs:[input.evidenceRefs[0]]})}}]}));}

test('TEAM runs four versioned roles, starts independent nodes together, persists dependency outputs and draft',async()=>{
  const c=await setup();try{
    const f=await fixture(c);await c.runner.processOne();const result=await view(c,f);
    assert.equal(result.mode,'TEAM');assert.equal(result.status,'WAITING_FOR_REVIEW');
    assert.equal(result.team.coordinatorVersion,'coordinator@1');assert.ok(result.team.nodes.every((n:any)=>n.status==='COMPLETED'&&n.attempt===1));
    assert.equal(result.output.execution,'RULES_DRAFT');
    assert.deepEqual(result.team.route.layers.map((layer:any)=>layer.layer),['L0','L1','L2','L3','L4','L5']);
    assert.ok(result.team.nodes.every((n:any)=>n.agentVersion.endsWith('@1')));
    const events=(await c.request('GET',`/api/events?caseId=${f.case.id}`,undefined,f.token)).body.data;
    const started=events.filter((e:any)=>e.type==='team.node_started');assert.deepEqual(started.map((e:any)=>e.data.nodeId),['policy','materials','verify','report']);
    const firstComplete=events.findIndex((e:any)=>e.type==='team.node_completed');
    assert.ok(events.findIndex((e:any)=>e.type==='team.node_started'&&e.data.nodeId==='materials')<firstComplete);
    const checkpoints=await c.request('GET',`/api/runs/${f.runId}/checkpoints`,undefined,f.token);responseSchemas.Checkpoints.parse(checkpoints.body);
    assert.ok(checkpoints.body.data.some((p:any)=>p.snapshot.completedSteps.length===3));
    assert.equal(checkpoints.body.data[0].snapshot.completedSteps.length,4);
    assert.ok(checkpoints.body.data[0].snapshot.documentVersions.some((v:any)=>v.documentId===result.output.documentId&&v.version===1));
    const row=await c.db.get('SELECT COUNT(*) AS count FROM documents WHERE case_id=?',[f.case.id]);assert.equal(Number(row!.count),1);
  }finally{await c.close();}
});

test('team definitions reject cycles, missing dependencies, duplicate roles, unknown tools and cross-tenant access',async()=>{
  const c=await setup();try{
    const f=await fixture(c);
    const cycle={...f.definition,nodes:f.definition.nodes.map((n:any)=>n.id==='policy'?{...n,dependsOn:['verify']}:n)};
    assert.equal((await c.request('POST',`/api/organizations/${f.org.id}/teams`,cycle,f.token)).status,422);
    assert.equal((await c.request('POST',`/api/organizations/${f.org.id}/teams`,{...f.definition,toolBindings:['shell']},f.token)).status,422);
    const unknown={...f.definition,nodes:f.definition.nodes.map((n:any)=>n.id==='verify'?{...n,dependsOn:['missing']}:n)};
    assert.equal((await c.request('POST',`/api/organizations/${f.org.id}/teams`,unknown,f.token)).status,422);
    const outsider=await c.register('team_outsider');
    for(const url of [`/api/teams/${f.team.teamId}/versions/1`,`/api/runs/${f.runId}`,`/api/runs/${f.runId}/checkpoints`])assert.equal((await c.request('GET',url,undefined,outsider.token)).status,404);
    assert.equal((await c.request('POST',`/api/runs/${f.runId}/control`,{action:'pause',scope:'team',controlId:randomUUID(),expectedControlRevision:1},outsider.token)).status,404);
    const {name:_,...definition}=f.definition;
    const newVersion=await c.request('POST',`/api/teams/${f.team.teamId}/versions`,{...definition,concurrency:1},f.token);
    assert.equal(newVersion.body.data.version,2);assert.equal((await view(c,f)).team.teamVersion,1);
  }finally{await c.close();}
});

test('queued pause is stable, control IDs are idempotent and version conflicts do not change state',async()=>{
  const c=await setup();try{
    const f=await fixture(c),command={action:'pause',scope:'team',controlId:randomUUID(),expectedControlRevision:1};
    const paused=await c.request('POST',`/api/runs/${f.runId}/control`,command,f.token);assert.equal(paused.body.data.state,'PAUSED');
    assert.deepEqual((await c.request('POST',`/api/runs/${f.runId}/control`,command,f.token)).body.data,paused.body.data);
    assert.equal((await c.request('POST',`/api/runs/${f.runId}/control`,{...command,action:'resume'},f.token)).status,409);
    assert.equal((await c.request('POST','/api/agent/requests',{caseId:f.case.id,expectedRevision:2},f.token)).status,409);
    assert.equal(await c.runner.processOne(),false);
    assert.equal((await control(c,f,'resume',{expectedControlRevision:1})).status,409);
    assert.equal((await control(c,f,'resume')).status,200);await c.runner.processOne();assert.equal((await view(c,f)).status,'WAITING_FOR_REVIEW');
  }finally{await c.close();}
});

test('branch pause allows materials to complete and resume reuses its checkpoint output',async()=>{
  const c=await setup();try{
    const f=await fixture(c);
    assert.equal((await control(c,f,'pause',{scope:'branch',nodeId:'policy'})).status,200);
    await c.runner.processOne();const paused=await view(c,f);
    assert.equal(paused.status,'PAUSED');assert.equal(paused.team.nodes.find((n:any)=>n.id==='materials').status,'COMPLETED');
    assert.equal(paused.team.nodes.find((n:any)=>n.id==='policy').status,'PAUSED');
    assert.equal((await control(c,f,'resume',{scope:'branch',nodeId:'policy'})).status,200);
    await c.runner.processOne();const final=await view(c,f);
    assert.equal(final.status,'WAITING_FOR_REVIEW');assert.equal(final.team.nodes.find((n:any)=>n.id==='materials').attempt,1);
  }finally{await c.close();}
});

test('paused resume refuses changed materials or corrupted checkpoint references',async()=>{
  const c=await setup();try{
    const f=await fixture(c);await control(c,f,'pause');
    const latest=(await c.db.get('SELECT * FROM run_checkpoints WHERE run_id=? ORDER BY event_seq DESC LIMIT 1',[f.runId]))!;
    await c.db.run('UPDATE run_checkpoints SET snapshot_json=? WHERE id=?',['{}',latest.id]);
    const corrupt=await control(c,f,'resume');assert.equal(corrupt.body.code,'CHECKPOINT_CORRUPT');
    await c.db.run('UPDATE run_checkpoints SET snapshot_json=? WHERE id=?',[latest.snapshot_json,latest.id]);
    await c.request('PATCH',`/api/cases/${f.case.id}`,{expectedRevision:2,data:{changed:'new'}},f.token);
    assert.equal((await control(c,f,'resume')).body.code,'RESUME_INPUT_CHANGED');
    assert.equal((await view(c,f)).status,'PAUSED');assert.equal((await control(c,f,'cancel')).status,200);
  }finally{await c.close();}
});

for(const scope of ['team','branch'] as const)test(`MODEL ${scope} pause fences late output and resumes only the report`,async()=>{
  let held:ServerResponse|undefined,received:any;
  const model=await provider((count,input,res)=>{if(count===1){held=res;received=input;}else reply(input,res);});
  const c=await setup({model:model.config});try{
    const f=await fixture(c,true),processing=c.runner.processOne();await model.first;
    const accepted=await control(c,f,'pause',{scope,...(scope==='branch'?{nodeId:'report'}:{})});assert.equal(accepted.body.data.state,scope==='team'?'PAUSE_REQUESTED':'RUNNING');
    await processing;const paused=await view(c,f);assert.equal(paused.status,'PAUSED');
    assert.equal(paused.team.nodes.filter((n:any)=>n.status==='COMPLETED').length,3);
    reply(received,held!);
    assert.equal(Number((await c.db.get('SELECT COUNT(*) AS count FROM patches WHERE document_id=?',[f.report.documentId]))!.count),0);
    const checkpoints=(await c.request('GET',`/api/runs/${f.runId}/checkpoints`,undefined,f.token)).body.data;
    assert.equal((await control(c,f,'resume',{scope,...(scope==='branch'?{nodeId:'report'}:{}),checkpointId:checkpoints[0].id})).status,200);
    await c.runner.processOne();const done=await view(c,f);assert.equal(done.status,'WAITING_FOR_REVIEW');assert.equal(done.output.execution,'MODEL_PATCH');
    assert.equal(done.team.nodes.find((n:any)=>n.id==='report').attempt,2);assert.ok(done.team.nodes.filter((n:any)=>n.id!=='report').every((n:any)=>n.attempt===1));
    assert.equal(done.team.modelCalls,2);
    assert.equal(Number((await c.db.get('SELECT COUNT(*) AS count FROM patches WHERE document_id=?',[f.report.documentId]))!.count),1);
  }finally{await c.close();await model.close();}
});

test('required model failures preserve completed nodes; retry succeeds without re-reading the team',async()=>{
  const model=await provider((count,input,res)=>{if(count===1){res.statusCode=400;res.end('{}');}else reply(input,res);});
  const c=await setup({model:model.config});try{
    const f=await fixture(c,true);await c.runner.processOne();let result=await view(c,f);assert.equal(result.status,'FAILED');
    assert.equal(result.team.nodes.find((n:any)=>n.id==='report').status,'FAILED');
    assert.equal((await control(c,f,'retry',{nodeId:'report',scope:'branch'})).status,200);
    await c.runner.processOne();result=await view(c,f);assert.equal(result.status,'WAITING_FOR_REVIEW');assert.ok(result.team.nodes.filter((n:any)=>n.id!=='report').every((n:any)=>n.attempt===1));
  }finally{await c.close();await model.close();}
});

test('team model budget counts failed requests and prevents extra retry calls',async()=>{
  const model=await provider((_count,_input,res)=>{res.statusCode=429;res.end('{}');});
  const c=await setup({model:model.config});try{
    const f=await fixture(c,true,{maxModelCalls:1});await c.runner.processOne();const failed=await view(c,f);
    assert.equal(failed.status,'FAILED');assert.match(failed.error,/预算/);assert.equal(failed.team.modelCalls,1);assert.equal(model.count,1);
    await control(c,f,'retry',{nodeId:'report'});await c.runner.processOne();assert.equal(model.count,1);
    assert.equal((await control(c,f,'retry',{nodeId:'report'})).body.code,'RETRY_LIMIT');
  }finally{await c.close();await model.close();}
});

test('expired worker recovery retains completed outputs across a real new process',async()=>{
  const c=await setup();try{
    const f=await fixture(c);await control(c,f,'pause',{scope:'branch',nodeId:'policy'});await c.runner.processOne();
    await control(c,f,'resume');
    await c.db.run("UPDATE runs SET status='RUNNING',lease_owner=?,lease_until=? WHERE id=?",[randomUUID(),'2000-01-01T00:00:00.000Z',f.runId]);
    await c.db.run("UPDATE run_nodes SET status='RUNNING',attempt=1,generation=generation+1 WHERE run_id=? AND node_id='policy'",[f.runId]);
    const child=spawn(process.execPath,[fileURLToPath(new URL('./team-recovery-child.js',import.meta.url)),c.dataDir],{stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
    const code=await new Promise(resolve=>child.once('exit',resolve));assert.equal(code,0,output);
    const result=await view(c,f);assert.equal(result.status,'WAITING_FOR_REVIEW');assert.equal(result.team.nodes.find((n:any)=>n.id==='materials').attempt,1);assert.equal(result.team.nodes.find((n:any)=>n.id==='policy').attempt,2);
    assert.equal(Number((await c.db.get('SELECT COUNT(*) AS count FROM documents WHERE case_id=?',[f.case.id]))!.count),1);
  }finally{await c.close();}
});

test('disabled teams prevent new work and late provider writes',async()=>{
  let held:ServerResponse|undefined,received:any;
  const model=await provider((_count,input,res)=>{held=res;received=input;});
  const c=await setup({model:model.config});try{
    const f=await fixture(c,true),running=c.runner.processOne();await model.first;
    await c.request('POST',`/api/teams/${f.team.teamId}/versions/1/disable`,{},f.token);
    await running;assert.equal((await view(c,f)).status,'FAILED');reply(received,held!);
    assert.equal(Number((await c.db.get('SELECT COUNT(*) AS count FROM patches WHERE document_id=?',[f.report.documentId]))!.count),0);
    const request=await c.request('POST','/api/agent/requests',{caseId:f.case.id,expectedRevision:3,mode:'TEAM',teamId:f.team.teamId,teamVersion:1},f.token);
    assert.equal(request.body.code,'TEAM_DISABLED');
  }finally{await c.close();await model.close();}
});

test('TEAM cancellation accepts the legacy API shape and preserves prior outputs without late writes',async()=>{
  let held:ServerResponse|undefined,received:any;
  const model=await provider((_count,input,res)=>{held=res;received=input;});
  const c=await setup({model:model.config});try{
    const f=await fixture(c,true),processing=c.runner.processOne();await model.first;
    const cancelled=await c.request('POST',`/api/runs/${f.runId}/control`,{action:'cancel'},f.token);assert.equal(cancelled.status,200);
    reply(received,held!);await processing;
    const result=await view(c,f);assert.equal(result.status,'CANCELLED');assert.equal(result.team.nodes.filter((n:any)=>n.status==='COMPLETED').length,3);
    assert.equal(result.team.nodes.find((n:any)=>n.role==='REPORT').status,'CANCELLED');
    assert.equal(Number((await c.db.get('SELECT COUNT(*) AS count FROM patches WHERE document_id=?',[f.report.documentId]))!.count),0);
  }finally{await c.close();await model.close();}
});

test('two worker processes cannot both commit a claimed team run',async()=>{
  const c=await setup();try{
    const f=await fixture(c);
    await Promise.all([1,2].map(()=>new Promise<void>((resolve,reject)=>{
      const child=spawn(process.execPath,[fileURLToPath(new URL('./team-recovery-child.js',import.meta.url)),c.dataDir],{stdio:['ignore','pipe','pipe']});
      let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);child.on('error',reject);
      child.once('exit',code=>code===0?resolve():reject(new Error(output)));
    })));
    const result=await view(c,f);assert.equal(result.status,'WAITING_FOR_REVIEW');assert.ok(result.team.nodes.every((n:any)=>n.attempt===1));
    assert.equal(Number((await c.db.get('SELECT COUNT(*) AS count FROM documents WHERE case_id=?',[f.case.id]))!.count),1);
  }finally{await c.close();}
});

test('ONBOARDING uses the same team engine with its own materials and rules',async()=>{
  const c=await setup();try{
    const f=await fixture(c,false,{},'ONBOARDING');await c.runner.processOne();const run=await view(c,f);
    assert.equal(run.status,'WAITING_FOR_REVIEW');assert.equal(run.team.route.scene,'ONBOARDING');
    assert.equal(run.output.issues.filter((i:any)=>i.severity==='ERROR').length,0);
    assert.ok(run.output.issues.some((i:any)=>i.code==='MANUAL_AUTHENTICITY'));
    const document=(await c.request('GET',`/api/documents/${run.output.documentId}`,undefined,f.token)).body.data;
    assert.ok(document.blocks.some((b:any)=>b.text.includes('张三')));
  }finally{await c.close();}
});
