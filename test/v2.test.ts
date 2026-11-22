import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer,type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setup,completeWeekly } from './helpers.js';
import { endpoints,responseSchemas } from '../src/openapi.js';

type Context=Awaited<ReturnType<typeof setup>>;
async function ruleDraft(c:Context,scenario='WEEKLY_REPORT'){
  const f=await c.fixture(scenario);
  const upload=await c.upload(f.token,f.case.id,1,completeWeekly);assert.equal(upload.status,201);
  const queued=await c.request('POST','/api/agent/requests',{caseId:f.case.id,expectedRevision:2},f.token);assert.equal(queued.status,202);
  await c.runner.processOne();
  const run=(await c.request('GET',`/api/runs/${queued.body.data.runId}`,undefined,f.token)).body.data;
  assert.equal(run.status,'WAITING_FOR_REVIEW');
  const document=(await c.request('GET',`/api/documents/${run.output.documentId}`,undefined,f.token)).body.data;
  return {...f,document,run,revision:3};
}
async function skill(c:Context,f:Awaited<ReturnType<typeof ruleDraft>>){
  const templates=(await c.request('GET','/api/skill-templates',undefined,f.token)).body.data;
  const template=templates.find((x:any)=>x.scenario===f.case.scenario);
  const created=await c.request('POST',`/api/organizations/${f.org.id}/skills`,template,f.token);assert.equal(created.status,201);
  const {skillId,version}=created.body.data;
  const trial=await c.request('POST',`/api/skills/${skillId}/versions/${version}/trials`,{caseId:f.case.id},f.token);
  assert.equal(trial.status,201);assert.equal(trial.body.data.passed,true);assert.equal(trial.body.data.modelCalled,false);
  assert.equal((await c.request('POST',`/api/skills/${skillId}/versions/${version}/publish`,{},f.token)).status,200);
  return {skillId,skillVersion:version,template};
}
async function modelRun(c:Context,f:Awaited<ReturnType<typeof ruleDraft>>,s:Awaited<ReturnType<typeof skill>>){
  const response=await c.request('POST','/api/agent/requests',{caseId:f.case.id,expectedRevision:f.revision,mode:'MODEL',documentId:f.document.id,
    expectedDocumentVersion:f.document.version,blockIds:[f.document.blocks[0].id],goal:'请根据证据精简标题',skillId:s.skillId,skillVersion:s.skillVersion},f.token);
  assert.equal(response.status,202,JSON.stringify(response.body));return response.body.data;
}
async function stub(handler?:(index:number,input:any,res:ServerResponse)=>void){
  let calls=0,resolveFirst!:(value:any)=>void;const first=new Promise<any>(resolve=>{resolveFirst=resolve;});
  const server=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const input=JSON.parse(body.messages[1].content);calls++;resolveFirst(input);
    if(handler){handler(calls,input,res);return;}reply(res,input);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {config:{baseUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,name:'test-model',apiKey:'test-only-not-a-real-key',timeoutMs:1000},first,get calls(){return calls;},close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
function reply(res:ServerResponse,input:any,overrides:Record<string,unknown>={}){
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({replacements:[{blockId:input.targetBlocks[0].id,text:'经核验的周报建议'}],reason:'根据来源调整表达',evidenceRefs:[input.evidenceRefs[0]],...overrides})}}],usage:{prompt_tokens:23,completion_tokens:12,total_tokens:35}}));
}

test('field corrections preserve originals and affect both scenario verification and stale confirmations',async()=>{
  const c=await setup();try{
    for(const scenario of ['WEEKLY_REPORT','ONBOARDING']){
      const f=await ruleDraft(c,scenario);
      const records=(await c.request('GET',`/api/cases/${f.case.id}/records`,undefined,f.token)).body.data;
      const attachment=records.attachments[0],record=attachment.records[0];
      const correction=await c.request('POST',`/api/cases/${f.case.id}/field-corrections`,{expectedRevision:3,attachmentId:attachment.attachmentId,recordId:record.id,
        field:scenario==='WEEKLY_REPORT'?'location':'employeeName',value:scenario==='WEEKLY_REPORT'?'B205':'李四',reason:'核对后更正'},f.token);
      assert.equal(correction.status,201);
      const stale=await c.request('POST',`/api/cases/${f.case.id}/confirmations`,{documentId:f.document.id,expectedRevision:4,note:'核实',acknowledgeIssues:true},f.token);
      assert.equal(stale.body.code,'EVIDENCE_STALE');
      const queued=await c.request('POST','/api/agent/requests',{caseId:f.case.id,expectedRevision:4},f.token);await c.runner.processOne();
      const run=(await c.request('GET',`/api/runs/${queued.body.data.runId}`,undefined,f.token)).body.data;
      const field=scenario==='WEEKLY_REPORT'?'location':'employeeName';
      const corrected=run.output.records.find((r:any)=>r.id===record.id);
      assert.equal(corrected.fields[field],scenario==='WEEKLY_REPORT'?'B205':'李四');
      assert.equal(corrected.corrections[field].reason,'核对后更正');
      if(scenario==='WEEKLY_REPORT')assert.equal(corrected.sources.location.quote,'活动地点：B203');
      const original=await fetch(c.base+`/api/attachments/${attachment.attachmentId}/download`,{headers:{Authorization:`Bearer ${f.token}`}});
      assert.equal(await original.text(),completeWeekly);
    }
  }finally{await c.close();}
});

test('patch review is versioned, idempotent, conflict-safe and gates publication',async()=>{
  const c=await setup();try{
    const f=await ruleDraft(c),body={baseVersion:1,replacements:[{blockId:f.document.blocks[0].id,text:'人工修订'}],reason:'核实内容',evidenceRefs:[]};
    const created=await c.request('POST',`/api/documents/${f.document.id}/patches`,body,f.token);assert.equal(created.status,201);
    const patchId=created.body.data.id;
    const blocked=await c.request('POST',`/api/cases/${f.case.id}/confirmations`,{documentId:f.document.id,expectedRevision:4,note:'核实',acknowledgeIssues:true},f.token);
    assert.equal(blocked.body.code,'PATCH_REVIEW_REQUIRED');
    const responses=await Promise.all([1,2].map(()=>c.request('POST',`/api/patches/${patchId}/accept`,{expectedVersion:1},f.token)));
    assert.equal(responses[0]!.status,200);assert.equal(responses[1]!.status,200);assert.equal(responses[1]!.body.data.acceptedVersion,2);
    const diff=(await c.request('GET',`/api/documents/${f.document.id}/diff?fromVersion=1&toVersion=2`,undefined,f.token)).body.data;
    assert.equal(diff.changes.length,1);assert.equal(diff.changes[0].change,'MODIFIED');
    const second=await c.request('POST',`/api/documents/${f.document.id}/patches`,{...body,baseVersion:2},f.token);
    await c.request('PUT',`/api/documents/${f.document.id}`,{expectedVersion:2,blocks:f.document.blocks},f.token);
    assert.equal((await c.request('POST',`/api/patches/${second.body.data.id}/accept`,{expectedVersion:3},f.token)).status,409);
    assert.equal((await c.request('POST',`/api/patches/${second.body.data.id}/reject`,{expectedVersion:3},f.token)).status,200);
    const outsider=await c.register('patch_outsider');assert.equal((await c.request('GET',`/api/documents/${f.document.id}/patches`,undefined,outsider.token)).status,404);
  }finally{await c.close();}
});

test('skill publication requires a trial, new versions preserve old content and tool scope is enforced',async()=>{
  const c=await setup();try{
    const f=await ruleDraft(c);
    const template=(await c.request('GET','/api/skill-templates',undefined,f.token)).body.data[0];
    const created=(await c.request('POST',`/api/organizations/${f.org.id}/skills`,template,f.token)).body.data;
    assert.equal((await c.request('POST',`/api/skills/${created.skillId}/versions/1/publish`,{},f.token)).status,409);
    assert.equal((await c.request('POST',`/api/organizations/${f.org.id}/skills`,{...template,toolBindings:['exec_shell']},f.token)).status,422);
    const published=await skill(c,f);
    const {name:_,...content}=template;
    const v2=await c.request('POST',`/api/skills/${published.skillId}/versions`,{...content,instructions:'新版指导'},f.token);
    assert.equal(v2.body.data.version,2);assert.equal(v2.body.data.status,'DRAFT');
    const original=(await c.request('GET',`/api/skills/${published.skillId}/versions/1`,undefined,f.token)).body.data;
    assert.equal(original.status,'PUBLISHED');assert.equal(original.content.instructions,template.instructions);
    const outsider=await c.register('skill_outsider');assert.equal((await c.request('GET',`/api/skills/${published.skillId}/versions/1`,undefined,outsider.token)).status,404);
  }finally{await c.close();}
});

test('MODEL flow records real protocol usage, produces pending patch and publishes only after human acceptance',async()=>{
  const model=await stub(),c=await setup({model:model.config});try{
    const f=await ruleDraft(c),s=await skill(c,f),queued=await modelRun(c,f,s);
    await c.runner.processOne();
    const response=await c.request('GET',`/api/runs/${queued.runId}`,undefined,f.token);responseSchemas.Run.parse(response.body);
    const run=response.body.data;assert.equal(run.status,'WAITING_FOR_REVIEW');assert.equal(run.mode,'MODEL');
    assert.equal(run.usage.attempts[0].totalTokens,35);assert.equal(run.usage.cost,null);assert.equal(run.definition.skillVersion,1);
    assert.equal((await c.request('GET',`/api/documents/${f.document.id}`,undefined,f.token)).body.data.version,1);
    const accepted=await c.request('POST',`/api/patches/${run.output.patchId}/accept`,{expectedVersion:1},f.token);assert.equal(accepted.status,200);
    const item=(await c.request('GET',`/api/cases/${f.case.id}`,undefined,f.token)).body.data;
    const confirmed=await c.request('POST',`/api/cases/${f.case.id}/confirmations`,{documentId:f.document.id,expectedRevision:item.revision,note:'人工检查 AI 修订',acknowledgeIssues:true},f.token);assert.equal(confirmed.status,201);
    const published=await c.request('POST','/api/commands',{commandId:randomUUID(),caseId:f.case.id,confirmationId:confirmed.body.data.confirmationId,expectedRevision:item.revision,action:'publish'},f.token);assert.equal(published.status,200);
  }finally{await c.close();await model.close();}
});

test('unconfigured MODEL mode fails explicitly while RULES remains available',async()=>{
  const c=await setup();try{const f=await ruleDraft(c),s=await skill(c,f);
    const response=await c.request('POST','/api/agent/requests',{caseId:f.case.id,expectedRevision:3,mode:'MODEL',documentId:f.document.id,expectedDocumentVersion:1,blockIds:[f.document.blocks[0].id],goal:'修订',...s,template:undefined},f.token);
    assert.equal(response.status,409);assert.equal(response.body.code,'MODEL_NOT_CONFIGURED');
  }finally{await c.close();}
});

for(const kind of ['timeout','429','invalid-json','invalid-envelope','invalid-reference','invalid-target','oversized','network'] as const)test(`model protocol handles ${kind} without overwriting content`,async()=>{
  const model=await stub((index,input,res)=>{
    if(kind==='timeout')return;
    if(kind==='429'&&index===1){res.statusCode=429;res.end('{}');return;}
    if(kind==='network'&&index===1){res.destroy();return;}
    if(kind==='invalid-json'){res.end('{bad');return;}
    if(kind==='invalid-envelope'){res.end('null');return;}
    if(kind==='invalid-reference'){reply(res,input,{evidenceRefs:['attachment:invented']});return;}
    if(kind==='invalid-target'){reply(res,input,{replacements:[{blockId:randomUUID(),text:'不允许的区块'}]});return;}
    if(kind==='oversized'){res.end('x'.repeat(129*1024));return;}
    reply(res,input);
  });
  const c=await setup({model:{...model.config,timeoutMs:kind==='timeout'?100:1000}});try{
    const f=await ruleDraft(c),s=await skill(c,f),queued=await modelRun(c,f,s);await c.runner.processOne();
    const run=(await c.request('GET',`/api/runs/${queued.runId}`,undefined,f.token)).body.data;
    assert.equal(run.status,kind==='429'||kind==='network'?'WAITING_FOR_REVIEW':'FAILED',JSON.stringify(run));
    if(kind==='429'||kind==='network')assert.equal(run.usage.attempts.length,2);
    if(kind==='invalid-envelope'||kind==='invalid-json')assert.equal(model.calls,1);
    assert.equal((await c.request('GET',`/api/documents/${f.document.id}`,undefined,f.token)).body.data.version,1);
  }finally{await c.close();await model.close();}
});

for(const action of ['cancel','disable','lose-lease'] as const)test(`in-flight ${action} prevents a late proposal`,async()=>{
  let held:ServerResponse|undefined,input:any;
  const model=await stub((_index,received,res)=>{held=res;input=received;});
  const c=await setup({model:{...model.config,timeoutMs:5000}});try{
    const f=await ruleDraft(c),s=await skill(c,f),queued=await modelRun(c,f,s);
    const processing=c.runner.processOne();await model.first;
    if(action==='cancel')await c.request('POST',`/api/runs/${queued.runId}/control`,{action:'cancel'},f.token);
    else if(action==='disable')await c.request('POST',`/api/skills/${s.skillId}/versions/1/disable`,{},f.token);
    else await c.db.run('UPDATE runs SET lease_owner=?,lease_until=? WHERE id=?',[randomUUID(),new Date(Date.now()+60000).toISOString(),queued.runId]);
    // Even if the provider ignores cancellation and returns, the commit must reject it.
    reply(held!,input);await processing;
    const count=await c.db.get('SELECT COUNT(*) AS count FROM patches WHERE document_id=?',[f.document.id]);assert.equal(Number(count!.count),0);
    const run=(await c.request('GET',`/api/runs/${queued.runId}`,undefined,f.token)).body.data;
    if(action==='cancel')assert.equal(run.status,'CANCELLED');
    if(action==='disable')assert.equal(run.status,'FAILED');
  }finally{await c.close();await model.close();}
});

test('OpenAPI covers all actual routes and includes schema constraints, SSE and multipart',async()=>{
  const c=await setup();try{
    const response=await fetch(c.base+'/api/openapi.json'),spec=await response.json() as any;assert.equal(spec.openapi,'3.1.0');
    const routes=c.app.router.stack.flatMap((layer:any)=>layer.route?Object.keys(layer.route.methods).map(method=>({method,path:layer.route.path.replace(/:([\w]+)/g,'{$1}')})):[]);
    for(const route of routes)assert.ok(spec.paths[route.path]?.[route.method],JSON.stringify(route));
    assert.equal(routes.length,endpoints.length);
    assert.ok(spec.paths['/api/events'].get.responses['200'].content['text/event-stream']);
    assert.ok(spec.paths['/api/cases/{id}/attachments'].post.requestBody.content['multipart/form-data']);
    assert.equal(spec.paths['/api/cases/{id}/field-corrections'].post.requestBody.content['application/json'].schema.properties.expectedRevision.minimum,1);
    assert.ok(!JSON.stringify(spec).includes('test-only-not-a-real-key'));
  }finally{await c.close();}
});

test('model wait renews the lease, cancellation aborts the HTTP request, and late replies are discarded',async()=>{
  let held:ServerResponse|undefined;let responseInput:any;let closed!:()=>void;
  const disconnected=new Promise<void>(resolve=>{closed=resolve;});
  const model=await stub((_n,input,res)=>{held=res;responseInput=input;res.once('close',closed);});
  const c=await setup({model:{...model.config,timeoutMs:5000}});try{
    const f=await ruleDraft(c),s=await skill(c,f),queued=await modelRun(c,f,s);
    const processing=c.runner.processOne();await model.first;
    const shortened=new Date(Date.now()+1800).toISOString();
    await c.db.run('UPDATE runs SET lease_until=? WHERE id=?',[shortened,queued.runId]);
    await new Promise(resolve=>setTimeout(resolve,1200));
    assert.ok((await c.db.get('SELECT lease_until FROM runs WHERE id=?',[queued.runId]))!.lease_until>shortened);
    await c.request('POST',`/api/runs/${queued.runId}/control`,{action:'cancel'},f.token);
    await Promise.race([disconnected,new Promise((_,reject)=>setTimeout(()=>reject(new Error('HTTP request was not aborted')),2500))]);
    reply(held!,responseInput);await processing;
    assert.equal(Number((await c.db.get('SELECT COUNT(*) AS count FROM patches WHERE document_id=?',[f.document.id]))!.count),0);
  }finally{await c.close();await model.close();}
});

test('input limits fail before HTTP calls and unknown token usage remains null',async()=>{
  const model=await stub((_index,input,res)=>{
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({replacements:[{blockId:input.targetBlocks[0].id,text:'建议'}],reason:'说明',evidenceRefs:[input.evidenceRefs[0]]})}}]}));
  });
  const c=await setup({model:model.config});try{
    const f=await ruleDraft(c),s=await skill(c,f),queued=await modelRun(c,f,s);await c.runner.processOne();
    const first=(await c.request('GET',`/api/runs/${queued.runId}`,undefined,f.token)).body.data;
    assert.equal(first.usage.attempts[0].promptTokens,null);assert.equal(first.usage.attempts[0].totalTokens,null);
    await c.request('POST',`/api/patches/${first.output.patchId}/reject`,{expectedVersion:1},f.token);
    const current=(await c.request('GET',`/api/cases/${f.case.id}`,undefined,f.token)).body.data;
    const large=Object.fromEntries(Array.from({length:9},(_,i)=>[`field${i}`,'x'.repeat(4000)]));
    await c.request('PATCH',`/api/cases/${f.case.id}`,{expectedRevision:current.revision,data:large},f.token);
    const rules=await c.request('POST','/api/agent/requests',{caseId:f.case.id,expectedRevision:current.revision+1},f.token);await c.runner.processOne();
    const generated=(await c.request('GET',`/api/runs/${rules.body.data.runId}`,undefined,f.token)).body.data;
    f.document=(await c.request('GET',`/api/documents/${generated.output.documentId}`,undefined,f.token)).body.data;
    f.revision=generated.output.caseRevision;
    const before=model.calls,tooLarge=await modelRun(c,f,s);await c.runner.processOne();
    const failed=(await c.request('GET',`/api/runs/${tooLarge.runId}`,undefined,f.token)).body.data;
    assert.equal(failed.status,'FAILED');assert.match(failed.error,/32000/);assert.equal(model.calls,before);
  }finally{await c.close();await model.close();}
});

test('correction of a previously missing field does not invent original source evidence',async()=>{
  const c=await setup();try{
    const f=await c.fixture();await c.upload(f.token,f.case.id,1,completeWeekly.replace('活动日期：2026-11-18\n',''));
    const files=(await c.request('GET',`/api/cases/${f.case.id}/records`,undefined,f.token)).body.data.attachments;
    const correction=await c.request('POST',`/api/cases/${f.case.id}/field-corrections`,{expectedRevision:2,attachmentId:files[0].attachmentId,recordId:files[0].records[0].id,field:'activityDate',value:'不是日期',reason:'待进一步核对'},f.token);
    assert.equal(correction.body.data.originalValue,null);
    const queued=await c.request('POST','/api/agent/requests',{caseId:f.case.id,expectedRevision:3},f.token);await c.runner.processOne();
    const result=await c.request('GET',`/api/runs/${queued.body.data.runId}`,undefined,f.token);responseSchemas.Run.parse(result.body);
    const issue=result.body.data.output.issues.find((i:any)=>i.code==='INVALID_DATE');assert.deepEqual(issue.sources,[]);
    assert.equal(result.body.data.output.records[0].corrections.activityDate.originalValue,null);
  }finally{await c.close();}
});
