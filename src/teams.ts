import type { Service } from './service.js';
import type { Query,Row } from './db.js';
import type { Principal } from './auth.js';
import { hash,id,now } from './auth.js';
import { requireThat } from './errors.js';
import { agentVersions,descendants,teamDefinitionSchema,type TeamDefinition,type TeamControl } from './team-contracts.js';
import type { RunInput } from './verification.js';
import { nodeCacheVersion,nodeFingerprint } from './reuse.js';

export function evidenceDigest(input:RunInput){
  return hash(JSON.stringify({caseId:input.caseId,scenario:input.scenario,title:input.title,businessDate:input.businessDate,data:input.data,correctionDigest:input.correctionDigest,
    attachments:input.attachments.map(a=>({id:a.id,sha256:a.sha256,purpose:a.purpose})),rules:input.rules}));
}
export class Teams {
  constructor(readonly service:Service){}
  view(row:Row){return {teamId:row.team_id,version:row.version,status:row.status,digest:row.digest,definition:JSON.parse(row.definition_json),createdBy:row.created_by,createdAt:row.created_at};}
  async get(q:Query,user:Principal,teamId:string,version?:number,lock=false){
    const suffix=lock?this.service.db.lock:'';
    const team=await q.get('SELECT * FROM teams WHERE id=?'+suffix,[teamId]);
    requireThat(team,404,'NOT_FOUND','团队不存在');await this.service.org(q,user,team.org_id);
    const selected=version===undefined?await q.get('SELECT * FROM team_versions WHERE team_id=? ORDER BY version DESC LIMIT 1'+suffix,[teamId]):await q.get('SELECT * FROM team_versions WHERE team_id=? AND version=?'+suffix,[teamId,version]);
    requireThat(selected,404,'NOT_FOUND','团队版本不存在');return {team,version:selected};
  }
  async create(user:Principal,orgId:string,name:string,definition:TeamDefinition){
    return this.service.db.transaction(async q=>{
      await this.service.org(q,user,orgId,['ADMIN']);const teamId=id();
      await q.run('INSERT INTO teams(id,org_id,name,created_at) VALUES (?,?,?,?)',[teamId,orgId,name,now()]);
      return this.addVersion(q,user,teamId,1,definition);
    });
  }
  private async addVersion(q:Query,user:Principal,teamId:string,version:number,definition:TeamDefinition){
    const parsed=teamDefinitionSchema.parse(definition);
    const json=JSON.stringify({...parsed,nodes:parsed.nodes.map(node=>({...node,agentVersion:node.agentVersion||agentVersions[node.role]}))});
    await q.run("INSERT INTO team_versions(team_id,version,status,definition_json,digest,created_by,created_at) VALUES (?,?,'DRAFT',?,?,?,?)",[teamId,version,json,hash(json),user.id,now()]);
    return this.view((await q.get('SELECT * FROM team_versions WHERE team_id=? AND version=?',[teamId,version]))!);
  }
  async newVersion(user:Principal,teamId:string,definition:TeamDefinition){
    return this.service.db.transaction(async q=>{
      const loaded=await this.get(q,user,teamId,undefined,true);await this.service.org(q,user,loaded.team.org_id,['ADMIN']);
      return this.addVersion(q,user,teamId,loaded.version.version+1,definition);
    });
  }
  async list(user:Principal,orgId:string){
    await this.service.org(this.service.db,user,orgId);
    const rows=await this.service.db.all('SELECT * FROM teams WHERE org_id=? ORDER BY created_at,id',[orgId]);
    return Promise.all(rows.map(async row=>({id:row.id,name:row.name,versions:(await this.service.db.all('SELECT * FROM team_versions WHERE team_id=? ORDER BY version DESC',[row.id])).map(v=>this.view(v))})));
  }
  async status(user:Principal,teamId:string,version:number,status:'PUBLISHED'|'DISABLED'){
    return this.service.db.transaction(async q=>{
      const loaded=await this.get(q,user,teamId,version,true);await this.service.org(q,user,loaded.team.org_id,['ADMIN']);
      teamDefinitionSchema.parse(JSON.parse(loaded.version.definition_json));
      await q.run('UPDATE team_versions SET status=? WHERE team_id=? AND version=?',[status,teamId,version]);
      return this.view((await q.get('SELECT * FROM team_versions WHERE team_id=? AND version=?',[teamId,version]))!);
    });
  }
  async published(q:Query,user:Principal,orgId:string,scenario:string,teamId:string,version:number){
    const loaded=await this.get(q,user,teamId,version,true);
    requireThat(loaded.team.org_id===orgId,404,'NOT_FOUND','团队不属于当前组织');
    requireThat(loaded.version.status==='PUBLISHED',409,'TEAM_DISABLED','团队版本未发布或已停用');
    const definition=teamDefinitionSchema.parse(JSON.parse(loaded.version.definition_json));
    requireThat(definition.scenario===scenario,422,'SCENARIO_MISMATCH','团队场景不匹配');
    return {teamId,version,digest:loaded.version.digest,definition};
  }
  async initialize(q:Query,row:Row,runId:string,input:RunInput,userId:string){
    await q.run("INSERT INTO run_controls(run_id,revision,epoch,paused_nodes_json,model_calls,created_at) VALUES (?,1,1,'[]',0,?)",[runId,now()]);
    for(const node of input.team!.definition.nodes)await q.run("INSERT INTO run_nodes(run_id,node_id,status,attempt,generation) VALUES (?,?,'QUEUED',0,0)",[runId,node.id]);
    await this.checkpoint(q,row,runId,userId);
  }
  async graph(q:Query,runId:string){
    const run=await q.get('SELECT * FROM runs WHERE id=?',[runId]);requireThat(run,404,'NOT_FOUND','运行不存在');
    const input:RunInput=JSON.parse(run.input_json);requireThat(input.team,409,'NOT_TEAM_RUN','该运行不是团队运行');
    const control=(await q.get('SELECT * FROM run_controls WHERE run_id=?',[runId]))!;
    const nodes=await q.all('SELECT * FROM run_nodes WHERE run_id=? ORDER BY node_id',[runId]);
    const budget=await this.service.branches.budget(q,runId),reused=await this.service.branches.reusedNodes(q,runId);
    return {runId,teamId:input.team.teamId,teamVersion:input.team.version,teamDigest:input.team.digest,coordinatorVersion:'coordinator@1',
      controlRevision:control.revision,controlEpoch:control.epoch,pausedNodes:JSON.parse(control.paused_nodes_json),modelCalls:control.model_calls,
      rootModelCalls:budget.used_calls,budget:{scope:'ROOT_RUN',maxModelCalls:Math.min(budget.max_calls,input.team.definition.maxModelCalls),maxAttempts:input.team.definition.maxAttempts,concurrency:input.team.definition.concurrency},route:input.team.route,
      nodes:input.team.definition.nodes.map(def=>{const state=nodes.find(n=>n.node_id===def.id)!;return {...def,agentVersion:def.agentVersion||agentVersions[def.role],status:state.status,attempt:state.attempt,generation:state.generation,reusedFrom:reused.find(r=>r.nodeId===def.id)??null,output:state.output_json?JSON.parse(state.output_json):null,error:state.error_message,startedAt:state.started_at,finishedAt:state.finished_at};})};
  }
  async checkpoint(q:Query,row:Row,runId:string,userId:string){
    const run=(await q.get('SELECT * FROM runs WHERE id=?',[runId]))!;
    const input:RunInput=JSON.parse(run.input_json),nodes=await q.all('SELECT * FROM run_nodes WHERE run_id=? ORDER BY node_id',[runId]);
    requireThat(nodes.every(n=>!['RUNNING','PAUSE_REQUESTED'].includes(n.status)),409,'CHECKPOINT_NOT_STABLE','活动节点尚未收尾');
    const control=(await q.get('SELECT * FROM run_controls WHERE run_id=?',[runId]))!;
    const sequence=Number((await q.get('SELECT MAX(seq) AS seq FROM events WHERE case_id=?',[row.id]))?.seq||0)+1;
    const documentVersions=input.model?[{documentId:input.model.documentId,version:input.model.baseVersion}]:[];
    for(const node of nodes.filter(n=>n.status==='COMPLETED'&&n.output_json)){
      const output=JSON.parse(node.output_json);
      if(output.documentId&&output.documentVersion&&!documentVersions.some(v=>v.documentId===output.documentId&&v.version===output.documentVersion))documentVersions.push({documentId:output.documentId,version:output.documentVersion});
    }
    const snapshot={runId,cacheVersion:nodeCacheVersion,lineage:await this.service.branches.lineage(q,runId),inputDigest:hash(run.input_json),evidenceDigest:evidenceDigest(input),caseRevision:input.revision,teamDigest:input.team!.digest,
      completedSteps:nodes.filter(n=>n.status==='COMPLETED'||n.status==='SKIPPED').map(n=>({nodeId:n.node_id,status:n.status,fingerprint:nodeFingerprint(input,input.team!.definition.nodes.find(def=>def.id===n.node_id)!),output:n.output_json?JSON.parse(n.output_json):null,outputDigest:hash(n.output_json||'null')})),
      documentVersions,controlEpoch:control.epoch,eventSeq:sequence};
    const json=JSON.stringify(snapshot),checkpointId=id();
    await q.run('INSERT INTO run_checkpoints(id,run_id,epoch,event_seq,snapshot_json,digest,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)',[checkpointId,runId,control.epoch,sequence,json,hash(json),userId,now()]);
    await this.service.event(q,row,'run.checkpoint',userId,{runId,checkpointId,eventSeq:sequence});
    return checkpointId;
  }
  async checkpoints(user:Principal,runId:string){
    const run=await this.service.db.get('SELECT * FROM runs WHERE id=?',[runId]);requireThat(run,404,'NOT_FOUND','运行不存在');
    await this.service.case(this.service.db,user,run.case_id);
    return (await this.service.db.all('SELECT * FROM run_checkpoints WHERE run_id=? ORDER BY event_seq DESC',[runId])).map(r=>({id:r.id,runId,controlEpoch:r.epoch,eventSeq:r.event_seq,digest:r.digest,snapshot:JSON.parse(r.snapshot_json),createdAt:r.created_at}));
  }
  async assertInputs(q:Query,row:Row,input:RunInput,user:Principal){
    this.service.ensureOpen(row);
    requireThat(row.revision===input.revision,409,'RESUME_INPUT_CHANGED','事项版本已变化，需要新计划，不能直接续办旧检查点');
    requireThat(evidenceDigest(await this.service.snapshot(q,row))===evidenceDigest(input),409,'RESUME_INPUT_CHANGED','材料、修正或制度已变化，需要重新核验');
    const published=await this.published(q,user,row.org_id,row.scenario,input.team!.teamId,input.team!.version);
    requireThat(published.digest===input.team!.digest,409,'TEAM_CHANGED','团队版本摘要已变化');
    if(input.model){
      await this.service.skills.published(q,user,row.org_id,row.scenario,input.model.skill.skillId,input.model.skill.version);
      const doc=await q.get('SELECT current_version FROM documents WHERE id=?',[input.model.documentId]);
      requireThat(doc?.current_version===input.model.baseVersion,409,'VERSION_CONFLICT','目标文档已变化，不能继续旧计划');
    }
  }
  async control(user:Principal,runId:string,input:TeamControl){
    const db=this.service.db,lookup=await db.get('SELECT case_id FROM runs WHERE id=?',[runId]);requireThat(lookup,404,'NOT_FOUND','运行不存在');
    return db.transaction(async q=>{
      const row=await this.service.case(q,user,lookup.case_id,['ADMIN','HANDLER'],true);
      const run=(await q.get('SELECT * FROM runs WHERE id=?'+db.lock,[runId]))!,snapshot:RunInput=JSON.parse(run.input_json);
      requireThat(snapshot.team,409,'NOT_TEAM_RUN','该操作只适用于 TEAM 运行');
      const requestDigest=hash(JSON.stringify(input)),previous=await q.get('SELECT * FROM control_receipts WHERE id=?',[input.controlId]);
      if(previous){requireThat(previous.run_id===runId&&previous.user_id===user.id&&previous.request_digest===requestDigest,409,'CONTROL_CONFLICT','控制标识已被其他请求使用');return JSON.parse(previous.receipt_json);}
      const head=await this.service.branches.head(q,row.id);
      requireThat(head?.run_id===runId,409,'BRANCH_SUPERSEDED','该分支已不是当前执行分支');
      const control=(await q.get('SELECT * FROM run_controls WHERE run_id=?'+db.lock,[runId]))!;
      requireThat(control.revision===input.expectedControlRevision,409,'CONTROL_VERSION_CONFLICT','控制状态已变化，请重新读取运行');
      const nodes=await q.all('SELECT * FROM run_nodes WHERE run_id=?',[runId]);
      if(input.nodeId)requireThat(snapshot.team.definition.nodes.some(n=>n.id===input.nodeId),422,'INVALID_NODE','目标节点不存在');
      const scope=input.action==='retry'?descendants(snapshot.team.definition,input.nodeId!):input.scope==='team'?snapshot.team.definition.nodes.map(n=>n.id):descendants(snapshot.team.definition,input.nodeId!);
      let paused:string[]=JSON.parse(control.paused_nodes_json),epoch=control.epoch,status=run.status;
      if(input.action==='pause'){
        requireThat(['QUEUED','RUNNING','PAUSED'].includes(status)&&nodes.some(n=>!['COMPLETED','SKIPPED'].includes(n.status)),409,'INVALID_STATE','当前状态不能暂停');
        paused=[...new Set([...paused,...scope])];if(input.scope==='team')epoch++;
        for(const node of nodes.filter(n=>scope.includes(n.node_id)&&!['COMPLETED','SKIPPED'].includes(n.status)))
          await q.run('UPDATE run_nodes SET status=?,generation=generation+1 WHERE run_id=? AND node_id=?',[node.status==='RUNNING'?'PAUSE_REQUESTED':'PAUSED',runId,node.node_id]);
        if(input.scope==='team')status=run.lease_owner?'PAUSE_REQUESTED':'PAUSED';
      }else if(input.action==='resume'||input.action==='retry'){
        requireThat(input.action==='retry'?status==='FAILED':status==='PAUSED',409,'INVALID_STATE','请等待暂停收尾，或从失败节点重试');
        await this.assertInputs(q,row,snapshot,user);
        const latest=await q.get('SELECT * FROM run_checkpoints WHERE run_id=? ORDER BY event_seq DESC LIMIT 1',[runId]);
        requireThat(latest&&(!input.checkpointId||input.checkpointId===latest.id),409,'CHECKPOINT_CONFLICT','本阶段仅支持最新稳定检查点续办');
        requireThat(hash(latest.snapshot_json)===latest.digest,409,'CHECKPOINT_CORRUPT','检查点摘要校验失败');
        const saved=JSON.parse(latest.snapshot_json);
        requireThat(saved.inputDigest===hash(run.input_json),409,'CHECKPOINT_CONFLICT','检查点引用的计划已变化');
        for(const completed of saved.completedSteps)requireThat(nodes.some(n=>n.node_id===completed.nodeId&&['COMPLETED','SKIPPED'].includes(n.status)&&hash(n.output_json||'null')===completed.outputDigest),409,'CHECKPOINT_CORRUPT','检查点产物引用不完整');
        for(const document of saved.documentVersions)requireThat(await q.get('SELECT document_id FROM document_versions WHERE document_id=? AND version=?',[document.documentId,document.version]),409,'CHECKPOINT_CORRUPT','检查点文档版本引用缺失');
        if(input.action==='retry'){
          const target=nodes.find(n=>n.node_id===input.nodeId)!;
          const failures=Number((await q.get("SELECT COUNT(*) AS count FROM node_attempts WHERE run_id=? AND node_id=? AND status='FAILED'",[runId,target.node_id]))!.count);
          requireThat(target.status==='FAILED'&&failures<snapshot.team.definition.maxAttempts,409,'RETRY_LIMIT','节点已达到失败尝试上限或无需重试');
          await q.run("UPDATE run_nodes SET status='QUEUED',error_message=NULL,generation=generation+1 WHERE run_id=? AND node_id=?",[runId,target.node_id]);
        }else{
          paused=paused.filter(nodeId=>!scope.includes(nodeId));
          for(const node of nodes.filter(n=>n.status==='PAUSED'&&!paused.includes(n.node_id)))await q.run("UPDATE run_nodes SET status='QUEUED',generation=generation+1 WHERE run_id=? AND node_id=?",[runId,node.node_id]);
        }
        epoch++;status='QUEUED';
      }else{
        requireThat(['QUEUED','RUNNING','PAUSED','PAUSE_REQUESTED','FAILED'].includes(status),409,'INVALID_STATE','当前运行已结束');
        epoch++;status='CANCELLED';
        await q.run("UPDATE run_nodes SET status='CANCELLED',generation=generation+1 WHERE run_id=? AND status NOT IN ('COMPLETED','SKIPPED')",[runId]);
        await q.run("UPDATE node_attempts SET status='CANCELLED',error_message=?,finished_at=? WHERE run_id=? AND status='RUNNING'",['团队已取消',now(),runId]);
      }
      await q.run('UPDATE run_controls SET revision=revision+1,epoch=?,paused_nodes_json=? WHERE run_id=?',[epoch,JSON.stringify(paused),runId]);
      await q.run('UPDATE runs SET status=?,error_message=NULL,lease_owner=?,lease_until=?,updated_at=? WHERE id=?',[status,['PAUSE_REQUESTED','RUNNING'].includes(status)?run.lease_owner:null,['PAUSE_REQUESTED','RUNNING'].includes(status)?run.lease_until:null,now(),runId]);
      if(status==='PAUSED'&&!nodes.some(n=>n.status==='RUNNING'))await this.checkpoint(q,row,runId,user.id);
      const receipt={receiptId:input.controlId,runId,controlRevision:control.revision+1,controlEpoch:epoch,state:status,scope:input.scope,affectedNodes:scope};
      await this.service.event(q,row,'run.control_received',user.id,receipt);
      await q.run('INSERT INTO control_receipts(id,run_id,user_id,request_digest,receipt_json,created_at) VALUES (?,?,?,?,?,?)',[input.controlId,runId,user.id,requestDigest,JSON.stringify(receipt),now()]);
      return receipt;
    });
  }
}
