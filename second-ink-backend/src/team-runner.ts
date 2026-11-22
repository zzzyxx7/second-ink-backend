import type { Service } from './service.js';
import type { Query,Row } from './db.js';
import { id,now } from './auth.js';
import { ApiError,requireThat } from './errors.js';
import { draft,verify,type RunInput } from './verification.js';
import { modelMessages,requestModel,type Attempt } from './model.js';
import { agentVersions,type TeamNode } from './team-contracts.js';

interface Task {runId:string;caseId:string;userId:string;owner:string;epoch:number;generation:number;attempt:number;node:TeamNode;input:RunInput;dependencies:Record<string,any>}
const terminal=(status:string)=>status==='COMPLETED'||status==='SKIPPED';
export class TeamRunner {
  private stopping=false;
  private controllers=new Set<AbortController>();
  constructor(readonly service:Service){}
  start(){this.stopping=false;}
  stop(){this.stopping=true;for(const controller of this.controllers)controller.abort(new ApiError(409,'WORKER_STOPPED','工作进程正在停止'));}
  async process(candidate:Row){
    const db=this.service.db,owner=id();
    const claimed=await db.transaction(async q=>{
      const row=(await q.get('SELECT * FROM cases WHERE id=?'+db.lock,[candidate.case_id]))!;
      const run=(await q.get('SELECT * FROM runs WHERE id=?'+db.lock,[candidate.id]))!;
      if(run.status!=='QUEUED'&&!(['RUNNING','PAUSE_REQUESTED'].includes(run.status)&&(!run.lease_until||run.lease_until<now())))return false;
      const control=(await q.get('SELECT * FROM run_controls WHERE run_id=?'+db.lock,[run.id]))!;
      const paused:string[]=JSON.parse(control.paused_nodes_json);
      const interrupted=await q.all("SELECT * FROM run_nodes WHERE run_id=? AND status IN ('RUNNING','PAUSE_REQUESTED')",[run.id]);
      for(const node of interrupted){
        await q.run('UPDATE run_nodes SET status=?,generation=generation+1 WHERE run_id=? AND node_id=?',[paused.includes(node.node_id)||run.status==='PAUSE_REQUESTED'?'PAUSED':'QUEUED',run.id,node.node_id]);
        await q.run("UPDATE node_attempts SET status='INTERRUPTED',finished_at=? WHERE run_id=? AND node_id=? AND status='RUNNING'",[now(),run.id,node.node_id]);
      }
      await q.run('UPDATE run_controls SET epoch=epoch+1 WHERE run_id=?',[run.id]);
      await q.run('UPDATE runs SET status=?,lease_owner=?,lease_until=?,updated_at=? WHERE id=?',[run.status==='PAUSE_REQUESTED'?'PAUSE_REQUESTED':'RUNNING',owner,new Date(Date.now()+60000).toISOString(),now(),run.id]);
      await this.service.event(q,row,'run.started',run.requested_by,{runId:run.id,mode:'TEAM',recovered:run.status!=='QUEUED',coordinatorVersion:'coordinator@1'});
      return true;
    });
    if(!claimed)return;
    try{
      while(!this.stopping){
        const batch=await this.prepare(candidate.id,owner);
        if(batch===null)return;
        if(batch.length)await Promise.all(batch.map(task=>this.execute(task)));
      }
      if(this.stopping)await db.run('UPDATE runs SET lease_until=? WHERE id=? AND lease_owner=? AND status=?',['2000-01-01T00:00:00.000Z',candidate.id,owner,'RUNNING']);
    }catch(error){await this.failRun(candidate.id,owner,error);}
  }
  private async prepare(runId:string,owner:string):Promise<Task[]|null>{
    const {db}=this.service;
    const lookup=(await db.get('SELECT case_id FROM runs WHERE id=?',[runId]))!;
    return db.transaction(async q=>{
      const row=(await q.get('SELECT * FROM cases WHERE id=?'+db.lock,[lookup.case_id]))!;
      const run=(await q.get('SELECT * FROM runs WHERE id=?'+db.lock,[runId]))!;
      if(run.lease_owner!==owner||!run.lease_until||run.lease_until<now()||!['RUNNING','PAUSE_REQUESTED'].includes(run.status))return null;
      const input:RunInput=JSON.parse(run.input_json),definition=input.team!.definition;
      const control=(await q.get('SELECT * FROM run_controls WHERE run_id=?'+db.lock,[runId]))!;
      // Called only after all tasks owned by this wave have settled.
      await q.run("UPDATE run_nodes SET status='PAUSED' WHERE run_id=? AND status='PAUSE_REQUESTED'",[runId]);
      const nodes=await q.all('SELECT * FROM run_nodes WHERE run_id=?',[runId]);
      if(run.status==='PAUSE_REQUESTED'){
        await q.run("UPDATE run_nodes SET status='PAUSED' WHERE run_id=? AND status NOT IN ('COMPLETED','SKIPPED','FAILED')",[runId]);
        await this.finish(q,row,run,'PAUSED',null);return null;
      }
      if(nodes.every(n=>terminal(n.status))){
        const report=definition.nodes.find(n=>n.role==='REPORT')!;
        const output=JSON.parse(nodes.find(n=>n.node_id===report.id)!.output_json);
        await this.finish(q,row,run,'WAITING_FOR_REVIEW',output);return null;
      }
      const failed=nodes.find(n=>n.status==='FAILED');
      if(failed){await this.finish(q,row,run,'FAILED',null,failed.error_message||'必需节点失败');return null;}
      const user={id:run.requested_by,username:''};
      requireThat((await this.service.branches.head(q,row.id))?.run_id===runId,409,'BRANCH_SUPERSEDED','旧分支已停止执行');
      await this.service.case(q,user,row.id,['ADMIN','HANDLER']);
      await this.service.teams.assertInputs(q,row,input,user);
      const paused:string[]=JSON.parse(control.paused_nodes_json);
      const ready=definition.nodes.filter(node=>!paused.includes(node.id)&&nodes.find(n=>n.node_id===node.id)!.status==='QUEUED'
        &&node.dependsOn.every(dep=>terminal(nodes.find(n=>n.node_id===dep)!.status))).slice(0,definition.concurrency);
      if(!ready.length){
        requireThat(nodes.some(n=>n.status==='PAUSED'),409,'DEPENDENCY_BLOCKED','依赖未满足，无法调度');
        await this.finish(q,row,run,'PAUSED',null);return null;
      }
      const tasks:Task[]=[];
      for(const node of ready){
        const state=nodes.find(n=>n.node_id===node.id)!;
        const failures=Number((await q.get("SELECT COUNT(*) AS count FROM node_attempts WHERE run_id=? AND node_id=? AND status='FAILED'",[runId,node.id]))!.count);
        if(failures>=definition.maxAttempts){await q.run("UPDATE run_nodes SET status='FAILED',error_message=? WHERE run_id=? AND node_id=?",['节点已达到失败尝试上限',runId,node.id]);continue;}
        const attempt=state.attempt+1,generation=state.generation+1;
        await q.run("UPDATE run_nodes SET status='RUNNING',attempt=?,generation=?,error_message=NULL,started_at=?,finished_at=NULL WHERE run_id=? AND node_id=?",[attempt,generation,now(),runId,node.id]);
        await q.run("INSERT INTO node_attempts(id,run_id,node_id,attempt,epoch,generation,status,started_at) VALUES (?,?,?,?,?,?,'RUNNING',?)",[id(),runId,node.id,attempt,control.epoch,generation,now()]);
        await this.service.event(q,row,'team.node_started',run.requested_by,{runId,nodeId:node.id,agentVersion:node.agentVersion||agentVersions[node.role],attempt,controlEpoch:control.epoch,dependsOn:node.dependsOn});
        tasks.push({runId,caseId:row.id,userId:run.requested_by,owner,epoch:control.epoch,generation,attempt,node,input,dependencies:Object.fromEntries(node.dependsOn.map(dep=>[dep,nodes.find(n=>n.node_id===dep)!.output_json?JSON.parse(nodes.find(n=>n.node_id===dep)!.output_json):null]))});
      }
      await q.run('UPDATE runs SET lease_until=?,updated_at=? WHERE id=?',[new Date(Date.now()+60000).toISOString(),now(),runId]);
      return tasks;
    });
  }
  private async state(q:Query,task:Task){
    const {db}=this.service;
    const row=(await q.get('SELECT * FROM cases WHERE id=?'+db.lock,[task.caseId]))!;
    const run=(await q.get('SELECT * FROM runs WHERE id=?'+db.lock,[task.runId]))!;
    const control=(await q.get('SELECT * FROM run_controls WHERE run_id=?'+db.lock,[task.runId]))!;
    const node=(await q.get('SELECT * FROM run_nodes WHERE run_id=? AND node_id=?',[task.runId,task.node.id]))!;
    const head=await this.service.branches.head(q,task.caseId);
    const valid=head?.run_id===task.runId&&run.status==='RUNNING'&&run.lease_owner===task.owner&&run.lease_until>=now()&&control.epoch===task.epoch&&node.generation===task.generation&&node.status==='RUNNING';
    return {row,run,control,node,valid};
  }
  private async execute(task:Task){
    const controller=new AbortController();this.controllers.add(controller);
    const timeout=setTimeout(()=>controller.abort(new ApiError(504,'NODE_TIMEOUT','节点执行超时')),task.node.timeoutMs);
    let checking:Promise<void>|undefined;
    const check=()=>this.service.db.transaction(async q=>{
      const state=await this.state(q,task);
      requireThat(state.valid,409,'EXECUTION_FENCED','暂停、取消或新执行代次已使旧节点失效');
      const user={id:task.userId,username:''};
      await this.service.case(q,user,task.caseId,['ADMIN','HANDLER']);
      this.service.expect(state.row,task.input.revision);
      await this.service.teams.published(q,user,state.row.org_id,state.row.scenario,task.input.team!.teamId,task.input.team!.version);
      if(task.input.model&&task.node.role==='REPORT')await this.service.skills.published(q,user,state.row.org_id,state.row.scenario,task.input.model.skill.skillId,task.input.model.skill.version);
      await q.run('UPDATE runs SET lease_until=? WHERE id=?',[new Date(Date.now()+60000).toISOString(),task.runId]);
    });
    const heartbeat=setInterval(()=>{
      if(checking)return;
      checking=check().catch(error=>controller.abort(error)).finally(()=>{checking=undefined;});
    },100);
    try{
      await check();
      let output:any;
      if(task.node.role==='POLICY')output={rules:task.input.rules,evidenceRefs:task.input.rules.map(r=>`rule:${r.id}@${r.version}`)};
      else if(task.node.role==='MATERIALS')output={attachments:task.input.attachments,evidenceRefs:task.input.attachments.map(a=>`attachment:${a.id}`)};
      else if(task.node.role==='VERIFY'){
        const policyId=task.input.team!.definition.nodes.find(n=>n.role==='POLICY')!.id,materialsId=task.input.team!.definition.nodes.find(n=>n.role==='MATERIALS')!.id;
        const policy=task.dependencies[policyId],materials=task.dependencies[materialsId];
        requireThat(Array.isArray(materials?.attachments),422,'INVALID_CHILD_RESULT','材料节点缺少结构化产物');
        output=verify({...task.input,rules:Array.isArray(policy?.rules)?policy.rules:[],attachments:materials.attachments});
      }else{
        const verificationId=task.input.team!.definition.nodes.find(n=>n.role==='VERIFY')!.id;
        const result=task.dependencies[verificationId];
        requireThat(result&&Array.isArray(result.records)&&Array.isArray(result.issues)&&typeof result.summary==='string',422,'INVALID_CHILD_RESULT','核验节点产物无效');
        if(task.input.model){
          requireThat(this.service.config.model,409,'MODEL_NOT_CONFIGURED','模型未配置');
          const refs=[...await this.service.evidenceRefs(this.service.db,task.caseId)];
          let callNumber=0;
          const onAttempt=async(attempt:Attempt)=>{
            await this.service.db.run('INSERT INTO model_attempts(id,run_id,attempt,model,status,latency_ms,prompt_tokens,completion_tokens,total_tokens,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
              [id(),task.runId,callNumber,attempt.model,attempt.status,attempt.latencyMs,attempt.promptTokens,attempt.completionTokens,attempt.totalTokens,now()]);
          };
          const reserve=()=>this.service.db.transaction(async q=>{
            const state=await this.state(q,task);requireThat(state.valid,409,'EXECUTION_FENCED','旧执行已失效');
            await this.service.branches.reserve(q,task.runId,task.input.team!.definition.maxModelCalls);
            callNumber=state.control.model_calls+1;
            await q.run('UPDATE run_controls SET model_calls=model_calls+1 WHERE run_id=?',[task.runId]);
          });
          output={proposal:await requestModel(this.service.config.model,modelMessages(task.input,result,refs),controller.signal,onAttempt,reserve)};
          this.service.patches.validate(task.input.model.blocks,{baseVersion:task.input.model.baseVersion,...output.proposal},new Set(refs));
        }else output={blocks:draft(task.input,result),verification:result};
      }
      controller.signal.throwIfAborted();
      await this.complete(task,output);
    }catch(error){await this.failNode(task,controller.signal.aborted?controller.signal.reason:error);}
    finally{clearTimeout(timeout);clearInterval(heartbeat);await checking;this.controllers.delete(controller);}
  }
  private async complete(task:Task,output:any){
    await this.service.db.transaction(async q=>{
      const state=await this.state(q,task);if(!state.valid)return;
      const user={id:task.userId,username:''};
      await this.service.case(q,user,task.caseId,['ADMIN','HANDLER']);
      await this.service.teams.assertInputs(q,state.row,task.input,user);
      if(task.node.role==='REPORT'){
        if(task.input.model){
          const {document}=await this.service.document(q,user,task.input.model.documentId);
          const patch=await this.service.patches.insert(q,state.row,document,user.id,{baseVersion:task.input.model.baseVersion,...output.proposal},task.runId);
          output={mode:'TEAM',execution:'MODEL_PATCH',patchId:patch.id,documentId:document.id,baseVersion:task.input.model.baseVersion};
        }else{
          const document=await this.service.addDocument(q,state.row,user.id,`${task.input.title}团队核验草稿`,output.blocks,task.runId);
          output={...output.verification,mode:'TEAM',execution:'RULES_DRAFT',documentId:document.documentId,documentVersion:1,caseRevision:document.caseRevision};
        }
      }
      await q.run("UPDATE run_nodes SET status='COMPLETED',output_json=?,finished_at=? WHERE run_id=? AND node_id=?",[JSON.stringify(output),now(),task.runId,task.node.id]);
      await q.run("UPDATE node_attempts SET status='COMPLETED',finished_at=? WHERE run_id=? AND node_id=? AND attempt=?",[now(),task.runId,task.node.id,task.attempt]);
      await this.service.event(q,state.row,'team.node_completed',task.userId,{runId:task.runId,nodeId:task.node.id,attempt:task.attempt});
    });
    // Save stable outputs after a wave, before scheduling any downstream nodes.
    await this.service.db.transaction(async q=>{
      const lookup=(await q.get('SELECT case_id FROM runs WHERE id=?',[task.runId]))!;
      const row=(await q.get('SELECT * FROM cases WHERE id=?'+this.service.db.lock,[lookup.case_id]))!;
      const run=(await q.get('SELECT * FROM runs WHERE id=?'+this.service.db.lock,[task.runId]))!;
      if(run.lease_owner!==task.owner||run.lease_until<now())return;
      const active=await q.get("SELECT node_id FROM run_nodes WHERE run_id=? AND status IN ('RUNNING','PAUSE_REQUESTED')",[task.runId]);
      if(!active)await this.service.teams.checkpoint(q,row,task.runId,task.userId);
    });
  }
  private async failNode(task:Task,error:unknown){
    const message=error instanceof Error?error.message:'节点执行失败';
    await this.service.db.transaction(async q=>{
      const state=await this.state(q,task);
      if(!state.valid){
        await q.run("UPDATE node_attempts SET status='INTERRUPTED',error_message=?,finished_at=? WHERE run_id=? AND node_id=? AND attempt=? AND status='RUNNING'",[message,now(),task.runId,task.node.id,task.attempt]);return;
      }
      if(this.stopping){
        await q.run("UPDATE run_nodes SET status='QUEUED',generation=generation+1 WHERE run_id=? AND node_id=?",[task.runId,task.node.id]);
        await q.run('UPDATE runs SET lease_until=? WHERE id=?',['2000-01-01T00:00:00.000Z',task.runId]);
      }else{
        await q.run('UPDATE run_nodes SET status=?,error_message=?,finished_at=? WHERE run_id=? AND node_id=?',[task.node.required?'FAILED':'SKIPPED',message,now(),task.runId,task.node.id]);
        await this.service.event(q,state.row,'team.node_failed',task.userId,{runId:task.runId,nodeId:task.node.id,error:message,required:task.node.required});
      }
      await q.run('UPDATE node_attempts SET status=?,error_message=?,finished_at=? WHERE run_id=? AND node_id=? AND attempt=?',[this.stopping?'INTERRUPTED':'FAILED',message,now(),task.runId,task.node.id,task.attempt]);
    });
  }
  private async finish(q:Query,row:Row,run:Row,status:string,output:unknown,error:string|null=null){
    const nodes=await q.all('SELECT * FROM run_nodes WHERE run_id=? ORDER BY node_id',[run.id]);
    const steps=nodes.map(n=>({name:n.node_id,status:n.status}));
    await q.run('UPDATE runs SET status=?,output_json=?,steps_json=?,error_message=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?',[status,output?JSON.stringify(output):null,JSON.stringify(steps),error,now(),run.id]);
    await this.service.teams.checkpoint(q,row,run.id,run.requested_by);
    await this.service.event(q,row,status==='PAUSED'?'run.paused':status==='FAILED'?'run.failed':'run.review_required',run.requested_by,{runId:run.id,state:status,error});
  }
  private async failRun(runId:string,owner:string,error:unknown){
    const db=this.service.db,lookup=(await db.get('SELECT case_id FROM runs WHERE id=?',[runId]))!;
    await db.transaction(async q=>{
      const row=(await q.get('SELECT * FROM cases WHERE id=?'+db.lock,[lookup.case_id]))!;
      const run=(await q.get('SELECT * FROM runs WHERE id=?'+db.lock,[runId]))!;
      if(run.lease_owner!==owner||run.lease_until<now()||!['RUNNING','PAUSE_REQUESTED'].includes(run.status))return;
      if(run.status==='PAUSE_REQUESTED'){
        await q.run("UPDATE run_nodes SET status='PAUSED' WHERE run_id=? AND status NOT IN ('COMPLETED','SKIPPED','FAILED')",[runId]);
        await this.finish(q,row,run,'PAUSED',null);return;
      }
      await q.run("UPDATE run_nodes SET status='FAILED',error_message=? WHERE run_id=? AND status='RUNNING'",[error instanceof Error?error.message:'团队执行失败',runId]);
      await this.finish(q,row,run,'FAILED',null,error instanceof Error?error.message:'团队执行失败');
    });
  }
}
