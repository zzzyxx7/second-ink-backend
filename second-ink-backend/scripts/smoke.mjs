import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const directory=await mkdtemp(path.join(tmpdir(),'second-ink-smoke-'));
const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');
const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
const separateWorker=process.argv.includes('--separate-worker');
const branchMode=process.argv.includes('--branch');
const teamMode=process.argv.includes('--team')||branchMode;
let providerCanRespond=!teamMode,firstModelResolve;
const firstModelRequest=new Promise(resolve=>{firstModelResolve=resolve;});
const provider=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString('utf8')),input=JSON.parse(body.messages[1].content);
  firstModelResolve();
  if(!providerCanRespond)return;
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({replacements:[{blockId:input.targetBlocks[0].id,text:'人工修正后待审周报'}],reason:'本地桩验证提案协议',evidenceRefs:[input.evidenceRefs[0]]})}}]}));
});
provider.listen(0,'127.0.0.1');await once(provider,'listening');
const environment={...process.env,HOST:'127.0.0.1',PORT:String(port),DATABASE_URL:'',DATA_DIR:directory,EMBEDDED_WORKER:separateWorker?'false':'true',
  MODEL_BASE_URL:`http://127.0.0.1:${provider.address().port}/v1`,MODEL_NAME:'local-protocol-stub',MODEL_API_KEY:'smoke-only',MODEL_TIMEOUT_MS:'2000'};
const child=spawn(process.execPath,['dist/server.js'],{
  env:environment,
  stdio:['ignore','pipe','pipe']
});
let log='';for(const pipe of [child.stdout,child.stderr])pipe.on('data',chunk=>{log=(log+chunk.toString()).slice(-3000);});
const children=[child];
const base=`http://127.0.0.1:${port}`;
let token;
async function request(method,url,body,status=200){
  const response=await fetch(base+url,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
  const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result.data;
}
try{
  let ready=false;
  for(let i=0;i<100;i++){
    if(child.exitCode!==null)throw new Error(log);
    try{await request('GET','/api/health');ready=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}
  }
  assert.ok(ready,'Server did not become ready');
  if(separateWorker){
    const worker=spawn(process.execPath,['dist/worker.js'],{env:environment,stdio:['ignore','pipe','pipe']});
    children.push(worker);
    for(const pipe of [worker.stdout,worker.stderr])pipe.on('data',chunk=>{log=(log+chunk.toString()).slice(-3000);});
  }
  token=(await request('POST','/api/auth/register',{username:'smoke_user',password:'smoke-password-1234'},201)).token;
  const org=await request('POST','/api/organizations',{name:'Second Ink 验证组织'},201);
  const item=await request('POST','/api/cases',{orgId:org.id,title:'社团周报',scenario:'WEEKLY_REPORT',businessDate:'2026-11-18',data:{}},201);
  const form=new FormData();form.append('expectedRevision','1');
  form.append('files',new Blob(['活动名称：迎新\n活动日期：2026-11-18\n活动地点：B203\n参与人数：25\n活动总结：已完成']), 'weekly.txt');
  const uploaded=await fetch(base+`/api/cases/${item.id}/attachments`,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:form});
  assert.equal(uploaded.status,201);
  const records=await request('GET',`/api/cases/${item.id}/records`),file=records.attachments[0];
  await request('POST',`/api/cases/${item.id}/field-corrections`,{expectedRevision:2,attachmentId:file.attachmentId,recordId:file.records[0].id,field:'location',value:'B205',reason:'人工核对场地'},201);
  const run=await request('POST','/api/agent/requests',{caseId:item.id,expectedRevision:3},202);
  let final;
  for(let i=0;i<100;i++){
    final=await request('GET',`/api/runs/${run.runId}`);
    if(final.status==='WAITING_FOR_REVIEW'||final.status==='FAILED')break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(final.status,'WAITING_FOR_REVIEW',JSON.stringify(final));
  assert.equal(final.output.records[0].fields.location,'B205');
  const document=await request('GET',`/api/documents/${final.output.documentId}`);
  const templates=await request('GET','/api/skill-templates');
  const skill=await request('POST',`/api/organizations/${org.id}/skills`,templates[0],201);
  assert.equal((await request('POST',`/api/skills/${skill.skillId}/versions/1/trials`,{caseId:item.id},201)).passed,true);
  await request('POST',`/api/skills/${skill.skillId}/versions/1/publish`,{});
  const report={documentId:document.id,expectedDocumentVersion:1,blockIds:[document.blocks[0].id],goal:'精简标题',skillId:skill.skillId,skillVersion:1};
  let modelRun;
  if(teamMode){
    const templates=await request('GET','/api/team-templates');
    const team=await request('POST',`/api/organizations/${org.id}/teams`,templates[0],201);
    await request('POST',`/api/teams/${team.teamId}/versions/1/publish`,{});
    modelRun=await request('POST','/api/agent/requests',{caseId:item.id,expectedRevision:4,mode:'TEAM',teamId:team.teamId,teamVersion:1,report},202);
    await Promise.race([firstModelRequest,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Team report never started')),10000);timer.unref();})]);
    const before=await request('GET',`/api/runs/${modelRun.runId}`);
    const paused=await request('POST',`/api/runs/${modelRun.runId}/control`,{action:'pause',scope:'team',controlId:randomUUID(),expectedControlRevision:before.team.controlRevision});
    assert.equal(paused.state,'PAUSE_REQUESTED');
    let state;
    for(let i=0;i<100;i++){
      state=await request('GET',`/api/runs/${modelRun.runId}`);if(state.status==='PAUSED')break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(state.status,'PAUSED');assert.equal(state.team.nodes.filter(n=>n.status==='COMPLETED').length,3);
    const checkpoints=await request('GET',`/api/runs/${modelRun.runId}/checkpoints`);
    assert.equal(checkpoints[0].snapshot.completedSteps.length,3);providerCanRespond=true;
    if(branchMode){
      const revision=(await request('GET',`/api/cases/${item.id}`)).revision;
      const form=new FormData();form.append('expectedRevision',String(revision));form.append('files',new Blob(['活动名称：迎新\n活动日期：2026-11-18\n活动地点：B207\n参与人数：25\n活动总结：已完成']),'replacement.txt');
      const uploaded=await fetch(base+`/api/cases/${item.id}/attachments`,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:form});const replacement=await uploaded.json();assert.equal(uploaded.status,201,JSON.stringify(replacement));
      const selected=await request('POST',`/api/cases/${item.id}/material-selection`,{expectedRevision:replacement.data.caseRevision,activeAttachmentIds:[replacement.data.attachments[0].id],reason:'补交材料替代旧材料'});
      const preview=await request('POST',`/api/runs/${modelRun.runId}/amendments`,{expectedRevision:selected.caseRevision,report:{...report,goal:'根据补交材料精简标题'}},201);
      assert.ok(preview.verification.reused>0&&preview.verification.executed>0);
      const command={previewId:preview.previewId,previewDigest:preview.previewDigest,commandId:randomUUID()};
      const child=await request('POST',`/api/runs/${modelRun.runId}/branches`,command,202);
      assert.deepEqual(await request('POST',`/api/runs/${modelRun.runId}/branches`,command,202),child);
      assert.equal((await request('GET',`/api/runs/${modelRun.runId}`)).status,'SUPERSEDED');modelRun=child;
    }else await request('POST',`/api/runs/${modelRun.runId}/control`,{action:'resume',scope:'team',controlId:randomUUID(),expectedControlRevision:state.team.controlRevision,checkpointId:checkpoints[0].id});
  }else modelRun=await request('POST','/api/agent/requests',{caseId:item.id,expectedRevision:4,mode:'MODEL',...report},202);
  let modelResult;
  for(let i=0;i<100;i++){
    modelResult=await request('GET',`/api/runs/${modelRun.runId}`);
    if(modelResult.status==='WAITING_FOR_REVIEW'||modelResult.status==='FAILED')break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(modelResult.status,'WAITING_FOR_REVIEW',JSON.stringify(modelResult));
  if(branchMode){
    assert.equal(modelResult.reuse.nodes.length,1);assert.equal(modelResult.team.nodes.find(n=>n.role==='REPORT').attempt,1);
    assert.equal(modelResult.team.rootModelCalls,2);assert.equal(modelResult.team.modelCalls,1);
    const verify=modelResult.team.nodes.find(n=>n.role==='VERIFY').output;assert.equal(verify.records[0].fields.location,'B207');
    assert.equal((await request('GET',`/api/runs/${modelRun.runId}/branches`)).length,2);
  }else if(teamMode){
    assert.ok(modelResult.team.nodes.filter(n=>n.role!=='REPORT').every(n=>n.attempt===1));
    assert.equal(modelResult.team.nodes.find(n=>n.role==='REPORT').attempt,2);
  }
  assert.equal(modelResult.usage.attempts[0].totalTokens,null);
  await request('POST',`/api/patches/${modelResult.output.patchId}/accept`,{expectedVersion:1});
  assert.equal((await request('GET',`/api/documents/${document.id}/diff?fromVersion=1&toVersion=2`)).changes.length,1);
  const current=await request('GET',`/api/cases/${item.id}`);
  const confirmed=await request('POST',`/api/cases/${item.id}/confirmations`,{documentId:final.output.documentId,expectedRevision:current.revision,note:'已人工核实并知晓制度未登记提示',acknowledgeIssues:true},201);
  const command={commandId:randomUUID(),caseId:item.id,confirmationId:confirmed.confirmationId,expectedRevision:current.revision,action:'publish'};
  const receipt=await request('POST','/api/commands',command);
  assert.deepEqual(await request('POST','/api/commands',command),receipt);
  console.log(`PASS (local model stub): upload → correction → ${separateWorker?'separate':'embedded'} worker → verification → Skill trial/publish → ${branchMode?'TEAM → pause → material selection → amendment preview → branch → incremental verification →':teamMode?'TEAM DAG → pause → checkpoint resume →':'MODEL'} proposal → human acceptance → idempotent publication`);
}catch(error){console.error(log);throw error;}
finally{
  await Promise.all(children.map(async process=>{if(process.exitCode===null){const exited=once(process,'exit');process.kill();await exited;}}));
  provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));
  await rm(directory,{recursive:true,force:true});
}
