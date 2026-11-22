import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Service } from './service.js';
import type { Query,Row } from './db.js';
import type { Principal } from './auth.js';
import { hash,id,now } from './auth.js';
import { ApiError,requireThat } from './errors.js';
import { fingerprint } from './fingerprint.js';
import { nodeCacheVersion,nodeFingerprint } from './reuse.js';
import { verify,type RunInput } from './verification.js';
import { evidenceDigest } from './teams.js';
import type { Amendment } from './branch-contracts.js';
import type { Decision } from './incremental.js';
import { checkEngineVersion } from './incremental.js';
import { reportOptionsSchema } from './team-contracts.js';

export class Branches {
  constructor(readonly service:Service){}
  async head(q:Query,caseId:string){return q.get('SELECT * FROM case_heads WHERE case_id=?',[caseId]);}
  async lineage(q:Query,runId:string){
    const row=await q.get('SELECT l.*,r.case_id FROM run_lineage l JOIN runs r ON r.id=l.run_id WHERE l.run_id=?',[runId]);
    if(!row)return null;const head=await this.head(q,row.case_id);
    return {runId,branchId:row.branch_id,rootRunId:row.root_run_id,parentRunId:row.parent_run_id,sourceCheckpointId:row.checkpoint_id,planVersion:row.plan_version,supersededRunId:row.superseded_run_id,isCurrent:head?.run_id===runId,currentRunId:head?.run_id??null};
  }
  async reusedNodes(q:Query,runId:string){return q.all('SELECT node_id AS nodeId,source_run_id AS sourceRunId,checkpoint_id AS checkpointId,source_digest AS sourceDigest FROM node_reuse WHERE run_id=? ORDER BY node_id',[runId]);}
  async budget(q:Query,runId:string){
    const row=await q.get('SELECT b.* FROM root_budgets b JOIN run_lineage l ON l.root_run_id=b.root_run_id WHERE l.run_id=?'+this.service.db.lock,[runId]);
    requireThat(row,409,'BRANCH_METADATA_MISSING','缺少分支预算信息');return row;
  }
  async reserve(q:Query,runId:string,maxCalls:number){
    const budget=await this.budget(q,runId);
    requireThat(budget.used_calls<Math.min(budget.max_calls,maxCalls),409,'MODEL_BUDGET_EXCEEDED','根运行的模型调用预算已耗尽');
    await q.run('UPDATE root_budgets SET used_calls=used_calls+1 WHERE root_run_id=?',[budget.root_run_id]);
  }
  private async supersede(q:Query,row:Row,oldRunId:string,userId:string){
    await q.run("UPDATE runs SET status='SUPERSEDED',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?",[now(),oldRunId]);
    await q.run('UPDATE run_controls SET revision=revision+1,epoch=epoch+1 WHERE run_id=?',[oldRunId]);
    await q.run("UPDATE run_nodes SET status='CANCELLED',generation=generation+1 WHERE run_id=? AND status NOT IN ('COMPLETED','SKIPPED')",[oldRunId]);
    await q.run("UPDATE node_attempts SET status='CANCELLED',finished_at=? WHERE run_id=? AND status='RUNNING'",[now(),oldRunId]);
    await q.run("UPDATE patches SET status='SUPERSEDED',decided_at=? WHERE source_run_id=? AND status='PENDING'",[now(),oldRunId]);
    await this.service.event(q,row,'run.superseded',userId,{runId:oldRunId});
  }
  async initializeRoot(q:Query,row:Row,runId:string,input:RunInput,userId:string){
    const previous=await this.head(q,row.id);
    if(previous){
      await this.supersede(q,row,previous.run_id,userId);
      await q.run('UPDATE confirmations SET expires_at=? WHERE case_id=?',[now(),row.id]);
    }
    await q.run('INSERT INTO run_lineage(run_id,branch_id,root_run_id,parent_run_id,checkpoint_id,plan_version,superseded_run_id,created_by,created_at) VALUES (?,?,?,NULL,NULL,1,?,?,?)',
      [runId,id(),runId,previous?.run_id??null,userId,now()]);
    await q.run('INSERT INTO root_budgets(root_run_id,max_calls,used_calls) VALUES (?,?,0)',[runId,input.team!.definition.maxModelCalls]);
    if(previous)await q.run('UPDATE case_heads SET run_id=?,revision=revision+1 WHERE case_id=?',[runId,row.id]);
    else await q.run('INSERT INTO case_heads(case_id,run_id,revision) VALUES (?,?,1)',[row.id,runId]);
  }
  private async validateCheckpoint(q:Query,source:Row,checkpoint:Row){
    requireThat(hash(checkpoint.snapshot_json)===checkpoint.digest,409,'CHECKPOINT_CORRUPT','检查点摘要校验失败');
    const snapshot=JSON.parse(checkpoint.snapshot_json),input:RunInput=JSON.parse(source.input_json);
    requireThat(snapshot.runId===source.id&&Array.isArray(snapshot.completedSteps)&&Array.isArray(snapshot.documentVersions)
      &&snapshot.inputDigest===hash(source.input_json)&&snapshot.evidenceDigest===evidenceDigest(input)&&snapshot.teamDigest===input.team!.digest,409,'CHECKPOINT_CORRUPT','检查点计划引用不完整');
    for(const completed of snapshot.completedSteps)requireThat(completed.outputDigest===hash(JSON.stringify(completed.output)),409,'CHECKPOINT_CORRUPT','检查点产物摘要校验失败');
    for(const document of snapshot.documentVersions){
      const version=await q.get('SELECT content_json,digest FROM document_versions WHERE document_id=? AND version=?',[document.documentId,document.version]);
      requireThat(version&&hash(version.content_json)===version.digest,409,'CHECKPOINT_CORRUPT','检查点文档版本缺失或摘要不匹配');
    }
    for(const attachment of input.attachments){
      const file=await q.get('SELECT * FROM attachments WHERE id=? AND case_id=?',[attachment.id,source.case_id]);
      requireThat(file&&file.sha256===attachment.sha256,409,'CHECKPOINT_CORRUPT','检查点原件引用失效');
      let buffer:Buffer;try{buffer=await readFile(path.join(this.service.config.dataDir,'attachments',file.stored_name));}catch{throw new ApiError(409,'CHECKPOINT_CORRUPT','检查点原件缺失');}
      requireThat(hash(buffer)===attachment.sha256,409,'CHECKPOINT_CORRUPT','原件摘要不匹配');
    }
    return snapshot;
  }
  private async build(q:Query,user:Principal,sourceRunId:string,request:Amendment){
    const source=await q.get('SELECT * FROM runs WHERE id=?',[sourceRunId]);requireThat(source,404,'NOT_FOUND','来源运行不存在');
    const row=await this.service.case(q,user,source.case_id,['ADMIN','HANDLER'],true);this.service.ensureOpen(row);this.service.expect(row,request.expectedRevision);
    const oldInput:RunInput=JSON.parse(source.input_json);requireThat(oldInput.team,409,'NOT_TEAM_RUN','分支功能只适用于 TEAM');
    const lineage=await this.lineage(q,sourceRunId);requireThat(lineage,409,'BRANCH_METADATA_MISSING','来源运行缺少分支信息');
    const head=await this.head(q,row.id);
    const active=await q.get("SELECT * FROM runs WHERE case_id=? AND status IN ('QUEUED','RUNNING','PAUSE_REQUESTED','PAUSED')",[row.id]);
    requireThat(!active||active.status==='PAUSED',409,'PAUSE_REQUIRED','请先暂停当前运行并等待收尾');
    if(request.kind==='AMEND')requireThat(head?.run_id===sourceRunId&&source.status==='PAUSED',409,'PAUSE_REQUIRED','微调必须基于当前已暂停的分支');
    const latest=await q.get('SELECT * FROM run_checkpoints WHERE run_id=? ORDER BY event_seq DESC LIMIT 1',[sourceRunId]);
    const checkpoint=request.checkpointId?await q.get('SELECT * FROM run_checkpoints WHERE id=? AND run_id=?',[request.checkpointId,sourceRunId]):latest;
    requireThat(checkpoint,404,'NOT_FOUND','稳定检查点不存在');
    if(request.kind==='AMEND')requireThat(checkpoint.id===latest?.id,409,'CHECKPOINT_CONFLICT','微调需使用最新稳定检查点');
    const saved=await this.validateCheckpoint(q,source,checkpoint);
    const next=await this.service.snapshot(q,row);next.mode='TEAM';next.revision=row.revision+1;
    requireThat(next.attachments.some(a=>a.purpose==='MATERIAL'),422,'MATERIAL_REQUIRED','至少选择一份生效业务材料');
    const team=await this.service.teams.published(q,user,row.org_id,row.scenario,request.teamId||oldInput.team.teamId,request.teamVersion||oldInput.team.version);
    next.team={...team,route:{...oldInput.team.route,identity:{orgId:row.org_id,principalId:user.id},reasonCode:request.kind==='AMEND'?'BREAKPOINT_AMENDMENT':'HISTORICAL_BRANCH',inputRevision:next.revision,
      layers:[{layer:'L0',decision:'AUTHORIZED_CASE_SCOPE',orgId:row.org_id,principalId:user.id},{layer:'L1',decision:'CURRENT_BUSINESS_FACTS',caseId:row.id,businessDate:row.business_date},{layer:'L2',decision:'VERIFY_AND_DRAFT',formalBusinessWrites:false},{layer:'L3',decision:'PINNED_TEAM',teamId:team.teamId,teamVersion:team.version,teamDigest:team.digest},{layer:'L4',decision:'ROOT_BUDGET',maxModelCalls:team.definition.maxModelCalls},{layer:'L5',decision:'NEW_HUMAN_CONFIRMATION_REQUIRED',inputRevision:next.revision}]}};
    const inherited=oldInput.model?{documentId:oldInput.model.documentId,expectedDocumentVersion:oldInput.model.baseVersion,blockIds:oldInput.model.blocks.map(b=>b.id),goal:oldInput.model.goal,skillId:oldInput.model.skill.skillId,skillVersion:oldInput.model.skill.version}:null;
    const report=request.report===undefined?inherited:request.report;
    if(report){
      requireThat(this.service.config.model,409,'MODEL_NOT_CONFIGURED','模型未配置');
      const checked=reportOptionsSchema.parse(report),target=await this.service.document(q,user,checked.documentId);
      requireThat(target.row.id===row.id,404,'NOT_FOUND','报告文档不属于当前事项');
      requireThat(target.document.current_version===checked.expectedDocumentVersion,409,'VERSION_CONFLICT','报告文档基准过期，请显式选择当前版本');
      const version=(await q.get('SELECT content_json FROM document_versions WHERE document_id=? AND version=?',[checked.documentId,checked.expectedDocumentVersion]))!;
      const blocks=JSON.parse(version.content_json);
      requireThat(checked.blockIds.every(blockId=>blocks.some((b:any)=>b.id===blockId)),422,'INVALID_BLOCK','报告目标区块不存在');
      const skill=await this.service.skills.published(q,user,row.org_id,row.scenario,checked.skillId,checked.skillVersion);
      next.model={documentId:checked.documentId,baseVersion:checked.expectedDocumentVersion,blocks:blocks.filter((b:any)=>checked.blockIds.includes(b.id)),goal:checked.goal,skill,agentVersion:'report-agent@1'};
    }
    next.team.route.execution=next.model?'MODEL_PATCH':'RULES_DRAFT';next.team.route.scene=row.scenario;next.team.route.objectIds=[row.id];
    const legacy=saved.cacheVersion!==nodeCacheVersion||oldInput.verificationEngineVersion!==checkEngineVersion;
    const cached:Record<string,any>={},dispositions:{nodeId:string;role:string;action:string;reason:string}[]=[];
    const available=new Map<string,any>(saved.completedSteps.map((step:any)=>[step.nodeId,step]));
    let changed=true;while(changed){changed=false;for(const node of next.team.definition.nodes){
      const entry=available.get(node.id),digest=nodeFingerprint(next,node);
      if(legacy||cached[node.id]||node.role==='REPORT'||!entry||entry.status!=='COMPLETED'||!digest||entry.fingerprint!==digest||!node.dependsOn.every(dep=>cached[dep]))continue;
      cached[node.id]={output:structuredClone(entry.output),sourceDigest:entry.outputDigest};changed=true;
    }}
    const verificationNode=oldInput.team.definition.nodes.find(n=>n.role==='VERIFY')!;
    const prior=available.get(verificationNode.id);
    next.verificationCache={sourceRunId,checkpointId:checkpoint.id,decisions:!legacy&&prior?.status==='COMPLETED'?(prior.output?.decisions as Decision[]||[]):[],fallbackReason:legacy?'LEGACY_DEPENDENCIES':prior?'': 'NO_SOURCE_VERIFICATION'};
    for(const node of next.team.definition.nodes){
      const entry=available.get(node.id);
      dispositions.push({nodeId:node.id,role:node.role,action:cached[node.id]?'REUSE':'RECOMPUTE',reason:cached[node.id]?'FINGERPRINT_MATCH':node.role==='REPORT'?'NEW_ARTIFACT_REQUIRED':legacy?'LEGACY_DEPENDENCIES':!entry||entry.status!=='COMPLETED'?'NO_COMPLETED_OUTPUT':entry.fingerprint!==nodeFingerprint(next,node)?'INPUT_OR_DEFINITION_CHANGED':'DEPENDENCY_CHANGED'});
    }
    const budget=await this.budget(q,sourceRunId),effectiveMax=Math.min(budget.max_calls,team.definition.maxModelCalls);
    requireThat(!next.model||budget.used_calls<effectiveMax,409,'MODEL_BUDGET_EXCEEDED','根运行模型预算已耗尽，分支不会重置预算');
    const maxVersion=await q.get('SELECT MAX(plan_version) AS version FROM run_lineage WHERE root_run_id=?',[lineage.rootRunId]);
    const control=active?await q.get('SELECT revision,epoch FROM run_controls WHERE run_id=?',[active.id]):undefined;
    const verification=cached[verificationNode.id]?.output?.verification;
    const stats=verify(next).verification!;
    const summary={kind:request.kind,sourceRunId,checkpointId:checkpoint.id,rootRunId:lineage.rootRunId,proposedPlanVersion:Number(maxVersion?.version||1)+1,caseRevision:row.revision,nextCaseRevision:next.revision,
      nodes:dispositions,verification:verification?{...verification,mode:'REUSED_NODE',executed:0,reused:verification.total}:stats,
      budget:{scope:'ROOT_RUN',used:budget.used_calls,max:effectiveMax,remaining:Math.max(0,effectiveMax-budget.used_calls)},requiresNewConfirmation:true};
    const base={caseRevision:row.revision,head:head?{runId:head.run_id,revision:head.revision}:null,active:active?{id:active.id,status:active.status,control}:null,checkpointDigest:checkpoint.digest,sourceInputDigest:hash(source.input_json),evidenceDigest:evidenceDigest(next),teamDigest:team.digest,model:next.model?{target:next.model,modelName:this.service.config.model!.name,providerDigest:fingerprint(this.service.config.model!)}:null,budget:{used:budget.used_calls,max:budget.max_calls},planVersion:summary.proposedPlanVersion};
    return {row,base,plan:{request:{...request,checkpointId:checkpoint.id},input:next,cached,summary}};
  }
  async preview(user:Principal,sourceRunId:string,request:Amendment){
    return this.service.db.transaction(async q=>{
      const {row,base,plan}=await this.build(q,user,sourceRunId,request),previewId=id(),expiresAt=new Date(Date.now()+5*60000).toISOString();
      const digest=fingerprint({base,plan});
      await q.run('INSERT INTO amendment_previews(id,case_id,source_run_id,created_by,base_json,plan_json,digest,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)',[previewId,row.id,sourceRunId,user.id,JSON.stringify(base),JSON.stringify(plan),digest,expiresAt,now()]);
      return {previewId,previewDigest:digest,expiresAt,...plan.summary};
    });
  }
  async commit(user:Principal,sourceRunId:string,input:{previewId:string;previewDigest:string;commandId:string}){
    const db=this.service.db;
    return db.transaction(async q=>{
      const preview=await q.get('SELECT * FROM amendment_previews WHERE id=? AND source_run_id=? AND created_by=?',[input.previewId,sourceRunId,user.id]);requireThat(preview,404,'NOT_FOUND','预览不存在或不可访问');
      const row=await this.service.case(q,user,preview.case_id,['ADMIN','HANDLER'],true),requestDigest=fingerprint({sourceRunId,...input});
      const previous=await q.get('SELECT * FROM branch_receipts WHERE id=?',[input.commandId]);
      if(previous){requireThat(previous.user_id===user.id&&previous.request_digest===requestDigest,409,'COMMAND_CONFLICT','分支命令标识已被其他请求使用');return JSON.parse(previous.receipt_json);}
      const base=JSON.parse(preview.base_json),plan=JSON.parse(preview.plan_json);
      requireThat(preview.digest===input.previewDigest&&fingerprint({base,plan})===preview.digest,409,'PREVIEW_CONFLICT','预览摘要不匹配');
      requireThat(preview.expires_at>now(),409,'PREVIEW_EXPIRED','预览已过期，请重新预览');
      const rebuilt=await this.build(q,user,sourceRunId,plan.request);
      requireThat(fingerprint(rebuilt.base)===fingerprint(base)&&fingerprint(rebuilt.plan)===fingerprint(plan),409,'PREVIEW_STALE','版本、输入或配置已变化，请重新预览');
      const head=await this.head(q,row.id),runId=id(),branchId=id(),next:RunInput=plan.input;
      if(head)await this.supersede(q,row,head.run_id,user.id);
      await this.service.touch(q,row.id);
      const steps=next.team!.definition.nodes.map(node=>({name:node.id,status:'QUEUED'}));
      await q.run("INSERT INTO runs(id,case_id,requested_by,status,input_revision,input_json,steps_json,created_at,updated_at) VALUES (?,?,?,'QUEUED',?,?,?,?,?)",[runId,row.id,user.id,next.revision,JSON.stringify(next),JSON.stringify(steps),now(),now()]);
      await q.run('INSERT INTO run_lineage(run_id,branch_id,root_run_id,parent_run_id,checkpoint_id,plan_version,superseded_run_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)',[runId,branchId,plan.summary.rootRunId,sourceRunId,plan.summary.checkpointId,plan.summary.proposedPlanVersion,head?.run_id??null,user.id,now()]);
      if(head)await q.run('UPDATE case_heads SET run_id=?,revision=revision+1 WHERE case_id=?',[runId,row.id]);else await q.run('INSERT INTO case_heads(case_id,run_id,revision) VALUES (?,?,1)',[row.id,runId]);
      await this.service.teams.initialize(q,row,runId,next,user.id);
      for(const [nodeId,entry] of Object.entries(plan.cached) as [string,any][]){
        const output=entry.output;
        if(output?.verification)output.verification={...output.verification,mode:'REUSED_NODE',executed:0,reused:output.verification.total};
        await q.run("UPDATE run_nodes SET status='COMPLETED',output_json=?,finished_at=? WHERE run_id=? AND node_id=?",[JSON.stringify(output),now(),runId,nodeId]);
        await q.run('INSERT INTO node_reuse(run_id,node_id,source_run_id,checkpoint_id,source_digest) VALUES (?,?,?,?,?)',[runId,nodeId,sourceRunId,plan.summary.checkpointId,entry.sourceDigest]);
      }
      await this.service.teams.checkpoint(q,row,runId,user.id);
      const receipt={runId,branchId,rootRunId:plan.summary.rootRunId,parentRunId:sourceRunId,sourceCheckpointId:plan.summary.checkpointId,planVersion:plan.summary.proposedPlanVersion,supersededRunId:head?.run_id??null,caseRevision:next.revision,status:'QUEUED',reuse:plan.summary.nodes};
      await q.run('INSERT INTO branch_receipts(id,case_id,user_id,request_digest,receipt_json,created_at) VALUES (?,?,?,?,?,?)',[input.commandId,row.id,user.id,requestDigest,JSON.stringify(receipt),now()]);
      await this.service.event(q,row,'run.branch_created',user.id,receipt);
      return receipt;
    });
  }
  async list(user:Principal,runId:string){
    const run=await this.service.db.get('SELECT case_id FROM runs WHERE id=?',[runId]);requireThat(run,404,'NOT_FOUND','运行不存在');await this.service.case(this.service.db,user,run.case_id);
    const source=await this.lineage(this.service.db,runId);requireThat(source,409,'NOT_TEAM_RUN','仅 TEAM 具有分支');
    const rows=await this.service.db.all('SELECT l.run_id,r.status,r.created_at FROM run_lineage l JOIN runs r ON r.id=l.run_id WHERE l.root_run_id=? ORDER BY l.plan_version',[source.rootRunId]);
    return Promise.all(rows.map(async row=>({...await this.lineage(this.service.db,row.run_id),status:row.status,createdAt:row.created_at})));
  }
}
