import { id, now } from './auth.js';
import type { Service } from './service.js';
import type { Row } from './db.js';
import { draft, verify, type RunInput } from './verification.js';
import { modelMessages,requestModel,type Attempt } from './model.js';
import { requireThat } from './errors.js';
import { tools } from './contracts.js';
import { TeamRunner } from './team-runner.js';

/** Durable fixed pipeline. This is deliberately not advertised as multi-agent execution. */
export class Runner {
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private active?: Promise<void>;
  private teamRunner:TeamRunner;
  constructor(private service: Service) {this.teamRunner=new TeamRunner(service);}
  async processOne(): Promise<boolean> {
    const {db}=this.service;
    const candidate=await db.get(`SELECT * FROM runs WHERE status='QUEUED' OR (status IN ('RUNNING','PAUSE_REQUESTED') AND (lease_until IS NULL OR lease_until<?)) ORDER BY created_at,id LIMIT 1`,[now()]);
    if (!candidate) return false;
    if(JSON.parse(candidate.input_json).team){await this.teamRunner.process(candidate);return true;}
    const owner=id();
    const claimed=await db.transaction(async q => {
      const row=(await q.get('SELECT * FROM cases WHERE id=?'+db.lock,[candidate.case_id]))!;
      const run=(await q.get('SELECT * FROM runs WHERE id=?'+db.lock,[candidate.id]))!;
      if (run.status!=='QUEUED' && !(run.status==='RUNNING' && run.lease_until<now())) return undefined;
      const input:RunInput=JSON.parse(run.input_json);
      const steps=['LOAD_EVIDENCE','VERIFY',input.mode==='MODEL'?'MODEL_PATCH':'DRAFT'].map(name => ({name,status:'QUEUED'}));
      await q.run("UPDATE runs SET status='RUNNING',lease_owner=?,lease_until=?,steps_json=?,error_message=NULL,updated_at=? WHERE id=?",
        [owner,new Date(Date.now()+60000).toISOString(),JSON.stringify(steps),now(),run.id]);
      await this.service.event(q,row,'run.started',run.requested_by,{runId:run.id,recovered:run.status==='RUNNING'});
      return run;
    });
    if (!claimed) return true;
    const input:RunInput=JSON.parse(claimed.input_json);
    try {
      if (!await this.step(claimed,owner,'LOAD_EVIDENCE','COMPLETED')) return true;
      if (!await this.step(claimed,owner,'VERIFY','RUNNING')) return true;
      const result=verify(input);
      if (!await this.step(claimed,owner,'VERIFY','COMPLETED')) return true;
      if(input.mode==='MODEL'){
        if(!await this.step(claimed,owner,'MODEL_PATCH','RUNNING'))return true;
        await this.modelPatch(claimed,owner,input,result);return true;
      }
      if (!await this.step(claimed,owner,'DRAFT','RUNNING')) return true;
      const blocks=draft(input,result);
      await db.transaction(async q => {
        const row=(await q.get('SELECT * FROM cases WHERE id=?'+db.lock,[claimed.case_id]))!;
        const live=(await q.get('SELECT * FROM runs WHERE id=?'+db.lock,[claimed.id]))!;
        if (live.status!=='RUNNING' || live.lease_owner!==owner || live.lease_until<now()) return;
        if (row.revision!==input.revision || row.status!=='OPEN') throw new Error('事项或材料已变化，请按最新事项版本重新核验');
        const document=await this.service.addDocument(q,row,claimed.requested_by,`${input.title}核验草稿`,blocks,claimed.id);
        const steps=JSON.parse(live.steps_json).map((s:any) => ({...s,status:'COMPLETED'}));
        await q.run("UPDATE runs SET status='WAITING_FOR_REVIEW',output_json=?,steps_json=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?",
          [JSON.stringify({...result,documentId:document.documentId,documentVersion:1,caseRevision:document.caseRevision}),JSON.stringify(steps),now(),claimed.id]);
        await this.service.event(q,row,'run.review_required',claimed.requested_by,{runId:claimed.id,documentId:document.documentId,issueCount:result.issues.length});
      });
    } catch (error) {
      await db.transaction(async q => {
        const row=(await q.get('SELECT * FROM cases WHERE id=?'+db.lock,[claimed.case_id]))!;
        const live=(await q.get('SELECT * FROM runs WHERE id=?'+db.lock,[claimed.id]))!;
        if (live.status!=='RUNNING' || live.lease_owner!==owner || live.lease_until<now()) return;
        const message=error instanceof Error ? error.message : '规则执行失败';
        const steps=JSON.parse(live.steps_json).map((s:any) => s.status==='RUNNING' ? {...s,status:'FAILED'} : s);
        await q.run("UPDATE runs SET status='FAILED',error_message=?,steps_json=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?",
          [message,JSON.stringify(steps),now(),claimed.id]);
        await this.service.event(q,row,'run.failed',claimed.requested_by,{runId:claimed.id,message});
      });
    }
    return true;
  }
  private async modelPatch(run:Row,owner:string,input:RunInput,result:ReturnType<typeof verify>){
    const {db}=this.service,controller=new AbortController();
    const user={id:run.requested_by,username:''};
    const check=async()=>db.transaction(async q=>{
      const row=await this.service.case(q,user,run.case_id,['ADMIN','HANDLER'],true);
      const live=(await q.get('SELECT * FROM runs WHERE id=?'+db.lock,[run.id]))!;
      requireThat(live.status==='RUNNING'&&live.lease_owner===owner&&live.lease_until>=now(),409,'LEASE_LOST','任务已取消或租约已失效');
      this.service.ensureOpen(row);this.service.expect(row,input.revision);
      const skill=await this.service.skills.published(q,user,row.org_id,row.scenario,input.model!.skill.skillId,input.model!.skill.version);
      requireThat(skill.digest===input.model!.skill.digest,409,'SKILL_CHANGED','技能版本摘要已变化');
      await q.run('UPDATE runs SET lease_until=? WHERE id=?',[new Date(Date.now()+60000).toISOString(),run.id]);
    });
    await check();
    let checking:Promise<void>|undefined;
    const timer=setInterval(()=>{
      if(checking)return;
      checking=check().catch(error=>controller.abort(error)).finally(()=>{checking=undefined;});
    },Math.min(1000,Math.max(25,Math.floor((this.service.config.model?.timeoutMs||30000)/4))));
    const logAttempt=async(attempt:Attempt)=>{
      await db.run('INSERT INTO model_attempts(id,run_id,attempt,model,status,latency_ms,prompt_tokens,completion_tokens,total_tokens,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [id(),run.id,attempt.attempt,attempt.model,attempt.status,attempt.latencyMs,attempt.promptTokens,attempt.completionTokens,attempt.totalTokens,now()]);
    };
    try{
      requireThat(this.service.config.model,409,'MODEL_NOT_CONFIGURED','模型未配置');
      const evidenceRefs=[...await this.service.evidenceRefs(db,run.case_id)];
      const proposal=await requestModel(this.service.config.model,modelMessages(input,result,evidenceRefs),controller.signal,logAttempt);
      controller.signal.throwIfAborted();
      this.service.patches.validate(input.model!.blocks,{baseVersion:input.model!.baseVersion,...proposal},new Set(evidenceRefs));
      await db.transaction(async q=>{
        const row=await this.service.case(q,user,run.case_id,['ADMIN','HANDLER'],true);
        const live=(await q.get('SELECT * FROM runs WHERE id=?'+db.lock,[run.id]))!;
        if(live.status!=='RUNNING'||live.lease_owner!==owner||live.lease_until<now())return;
        this.service.ensureOpen(row);this.service.expect(row,input.revision);
        await this.service.skills.published(q,user,row.org_id,row.scenario,input.model!.skill.skillId,input.model!.skill.version);
        const {document}=await this.service.document(q,user,input.model!.documentId);
        const patch=await this.service.patches.insert(q,row,document,user.id,{baseVersion:input.model!.baseVersion,...proposal},run.id);
        const steps=JSON.parse(live.steps_json).map((s:any)=>({...s,status:'COMPLETED'}));
        await q.run("UPDATE runs SET status='WAITING_FOR_REVIEW',output_json=?,steps_json=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?",
          [JSON.stringify({mode:'MODEL',patchId:patch.id,documentId:document.id,baseVersion:input.model!.baseVersion,actualTools:tools}),JSON.stringify(steps),now(),run.id]);
        await this.service.event(q,row,'run.review_required',user.id,{runId:run.id,patchId:patch.id});
      });
    }finally{clearInterval(timer);await checking;}
  }
  private async step(run:Row,owner:string,name:string,status:string) {
    const {db}=this.service;
    return db.transaction(async q => {
      const row=(await q.get('SELECT * FROM cases WHERE id=?'+db.lock,[run.case_id]))!;
      const live=(await q.get('SELECT * FROM runs WHERE id=?'+db.lock,[run.id]))!;
      if (live.status!=='RUNNING' || live.lease_owner!==owner || live.lease_until<now()) return false;
      const steps=JSON.parse(live.steps_json).map((s:any) => s.name===name ? {...s,status,updatedAt:now()} : s);
      await q.run('UPDATE runs SET steps_json=?,lease_until=?,updated_at=? WHERE id=?',[JSON.stringify(steps),new Date(Date.now()+60000).toISOString(),now(),run.id]);
      await this.service.event(q,row,'run.step',run.requested_by,{runId:run.id,name,status});
      return true;
    });
  }
  start() {
    this.stopping=false;
    this.teamRunner.start();
    const tick=() => {
      this.active=this.processOne().then(() => undefined).catch(error => console.error('Worker iteration failed:',error instanceof Error ? error.message : error)).finally(() => {
        if (!this.stopping) this.timer=setTimeout(tick,300);
      });
    };
    tick();
  }
  async stop() { this.stopping=true; this.teamRunner.stop(); clearTimeout(this.timer); await this.active; }
}
