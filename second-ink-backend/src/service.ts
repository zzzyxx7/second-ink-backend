import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Store, Query, Row } from './db.js';
import type { Config } from './config.js';
import { hash, id, now, type Principal } from './auth.js';
import { ApiError, requireThat } from './errors.js';
import { parseFile } from './parser.js';
import type { Block, Role, Scenario } from './types.js';
import type { RunInput } from './verification.js';
import { correctionRows,correctedFile,correctionsDigest } from './evidence.js';
import { Patches } from './patches.js';
import { Skills,agentVersion } from './skills.js';
import type { RunRequest } from './contracts.js';
import { Teams } from './teams.js';
import { Branches } from './branches.js';
import { materialIds,materialActive } from './materials.js';
import { checkEngineVersion } from './incremental.js';

const editors: Role[] = ['ADMIN','HANDLER'];
const reviewers: Role[] = ['ADMIN','REVIEWER'];
export class Service {
  readonly patches=new Patches(this);
  readonly skills=new Skills(this);
  readonly teams=new Teams(this);
  readonly branches=new Branches(this);
  constructor(readonly db: Store, readonly config: Config) {}
  async org(q: Query, user: Principal, orgId: string, roles?: Role[]) {
    const member = await q.get('SELECT role FROM memberships WHERE org_id=? AND user_id=?', [orgId,user.id]);
    requireThat(member, 404, 'NOT_FOUND', '组织不存在或没有访问权限');
    if (roles) requireThat(roles.includes(member.role), 403, 'FORBIDDEN', '当前角色无权执行该操作');
    return member;
  }
  async case(q: Query, user: Principal, caseId: string, roles?: Role[], lock = false) {
    const row = await q.get('SELECT * FROM cases WHERE id=?' + (lock ? this.db.lock : ''), [caseId]);
    requireThat(row, 404, 'NOT_FOUND', '事项不存在或没有访问权限');
    const membership = await this.org(q,user,row.org_id,roles);
    requireThat(membership.role !== 'SUBMITTER' || row.submitter_id === user.id, 404, 'NOT_FOUND', '事项不存在或没有访问权限');
    return row;
  }
  ensureOpen(row: Row) { requireThat(row.status === 'OPEN', 409, 'CASE_PUBLISHED', '事项已发布，首版不支持重新打开'); }
  expect(row: Row, expected: number) { requireThat(row.revision === expected, 409, 'VERSION_CONFLICT', '事项已变化，请重新获取版本'); }
  async touch(q: Query, caseId: string) { await q.run('UPDATE cases SET revision=revision+1,updated_at=? WHERE id=?', [now(),caseId]); }
  async event(q: Query, row: Row, type: string, actorId: string, data: unknown) {
    if(data&&typeof data==='object'){
      const payload=data as Record<string,unknown>,runId=payload.runId||payload.sourceRunId;
      if(typeof runId==='string'){
        const lineage=await q.get('SELECT branch_id,root_run_id,plan_version FROM run_lineage WHERE run_id=?',[runId]);
        if(lineage)data={...payload,branchId:lineage.branch_id,rootRunId:lineage.root_run_id,planVersion:lineage.plan_version};
      }
    }
    // The case row is the per-case event sequence lock on MySQL.
    await q.get('SELECT id FROM cases WHERE id=?' + this.db.lock, [row.id]);
    const previous = await q.get('SELECT MAX(seq) AS seq FROM events WHERE case_id=?', [row.id]);
    await q.run('INSERT INTO events(id,org_id,case_id,seq,type,actor_id,data_json,created_at) VALUES (?,?,?,?,?,?,?,?)',
      [id(),row.org_id,row.id,Number(previous?.seq || 0)+1,type,actorId,JSON.stringify(data),now()]);
  }
  caseView(row: Row) {
    return { id: row.id, orgId: row.org_id, createdBy: row.created_by, submitterId:row.submitter_id, title: row.title,
      scenario: row.scenario, businessDate: row.business_date, status: row.status,
      revision: row.revision, data: JSON.parse(row.data_json), createdAt: row.created_at, updatedAt: row.updated_at };
  }
  async createOrg(user: Principal, name: string) {
    const orgId = id();
    return this.db.transaction(async q => {
      await q.run('INSERT INTO organizations(id,name,created_at) VALUES (?,?,?)', [orgId,name,now()]);
      await q.run('INSERT INTO memberships(org_id,user_id,role) VALUES (?,?,?)', [orgId,user.id,'ADMIN']);
      return { id: orgId,name,role:'ADMIN' };
    });
  }
  async listOrgs(user: Principal) {
    return this.db.all('SELECT o.id,o.name,m.role FROM organizations o JOIN memberships m ON m.org_id=o.id WHERE m.user_id=? ORDER BY o.created_at', [user.id]);
  }
  async addMember(user: Principal, orgId: string, username: string, role: Role) {
    return this.db.transaction(async q => {
      await this.org(q,user,orgId,['ADMIN']);
      const target = await q.get('SELECT id,username FROM users WHERE username=?', [username]);
      requireThat(target, 404, 'USER_NOT_FOUND', '该用户尚未注册');
      const existing = await q.get('SELECT role FROM memberships WHERE org_id=? AND user_id=?', [orgId,target.id]);
      requireThat(!existing, 409, 'ALREADY_MEMBER', '该用户已加入组织');
      await q.run('INSERT INTO memberships(org_id,user_id,role) VALUES (?,?,?)', [orgId,target.id,role]);
      return { userId:target.id, username:target.username, role };
    });
  }
  async createCase(user: Principal, data: { orgId: string; title: string; scenario: Scenario; businessDate: string; data: unknown; submitterId?:string }) {
    return this.db.transaction(async q => {
      await this.org(q,user,data.orgId,editors);
      if (data.submitterId) {
        const member=await q.get('SELECT role FROM memberships WHERE org_id=? AND user_id=?',[data.orgId,data.submitterId]);
        requireThat(member?.role==='SUBMITTER',422,'INVALID_SUBMITTER','填报人必须是组织内的 SUBMITTER 成员');
      }
      const caseId = id(), at = now();
      await q.run(`INSERT INTO cases(id,org_id,created_by,submitter_id,title,scenario,business_date,status,revision,data_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,'OPEN',1,?,?,?)`, [caseId,data.orgId,user.id,data.submitterId ?? null,data.title,data.scenario,data.businessDate,JSON.stringify(data.data),at,at]);
      const row = (await q.get('SELECT * FROM cases WHERE id=?', [caseId]))!;
      await this.event(q,row,'case.created',user.id,{});
      return this.caseView(row);
    });
  }
  async listCases(user: Principal, orgId: string) {
    await this.org(this.db,user,orgId);
    const rows = await this.db.all(`SELECT c.* FROM cases c JOIN memberships m ON m.org_id=c.org_id
      WHERE c.org_id=? AND m.user_id=? AND (m.role<>'SUBMITTER' OR c.submitter_id=?) ORDER BY c.created_at DESC LIMIT 100`, [orgId,user.id,user.id]);
    return rows.map(row => this.caseView(row));
  }
  async updateCase(user: Principal, caseId: string, input: { expectedRevision: number; title?: string; businessDate?: string; data?: unknown }) {
    return this.db.transaction(async q => {
      const row = await this.case(q,user,caseId,editors,true);
      this.ensureOpen(row); this.expect(row,input.expectedRevision);
      await q.run('UPDATE cases SET title=?,business_date=?,data_json=?,revision=revision+1,updated_at=? WHERE id=?',
        [input.title ?? row.title,input.businessDate ?? row.business_date,input.data ? JSON.stringify(input.data) : row.data_json,now(),caseId]);
      await this.event(q,row,'case.updated',user.id,{ revision: row.revision+1 });
      return this.caseView((await q.get('SELECT * FROM cases WHERE id=?', [caseId]))!);
    });
  }
  attachmentView(row: Row,active=true) {
    return { id: row.id, caseId:row.case_id, name:row.name, sha256:row.sha256, size:row.size_bytes,
      purpose:row.purpose,active, parsed:JSON.parse(row.parsed_json), createdAt:row.created_at };
  }
  async upload(user: Principal, caseId: string, expected: number, files: Express.Multer.File[], purpose: string) {
    await this.case(this.db,user,caseId,[...editors,'SUBMITTER']);
    const parsed: { id: string; file: Express.Multer.File; parsed: unknown; stored: string }[] = [];
    for (const file of files) {
      const attachmentId = id();
      // Multer decodes multipart names as Latin-1; recover UTF-8 only when lossless.
      const decoded = Buffer.from(file.originalname,'latin1').toString('utf8');
      const name = decoded.includes('\uFFFD') ? file.originalname : decoded;
      file.originalname = path.basename(name).slice(0,240);
      try {
        parsed.push({ id:attachmentId,file,parsed:await parseFile(file.buffer,file.originalname,attachmentId),stored:`${attachmentId}${path.extname(file.originalname).toLowerCase()}` });
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(422,'PARSE_FAILED',`无法解析文件：${file.originalname}`);
      }
    }
    const directory = path.join(this.config.dataDir,'attachments');
    await mkdir(directory,{recursive:true});
    const written: string[] = [];
    try {
      for (const entry of parsed) {
        const target = path.join(directory,entry.stored);
        await writeFile(target,entry.file.buffer,{flag:'wx'}); written.push(target);
      }
      return await this.db.transaction(async q => {
        const row = await this.case(q,user,caseId,[...editors,'SUBMITTER'],true);
        this.ensureOpen(row); this.expect(row,expected);
        const count = await q.get('SELECT COUNT(*) AS count FROM attachments WHERE case_id=?',[caseId]);
        requireThat(Number(count!.count)+parsed.length <= 20,422,'ATTACHMENT_LIMIT','每个事项最多 20 个附件');
        for (const entry of parsed) await q.run(`INSERT INTO attachments(id,case_id,name,stored_name,sha256,size_bytes,purpose,parsed_json,created_at)
          VALUES (?,?,?,?,?,?,?,?,?)`,[entry.id,caseId,entry.file.originalname,entry.stored,hash(entry.file.buffer),entry.file.size,purpose,JSON.stringify(entry.parsed),now()]);
        const selected=await materialIds(q,caseId);
        if(selected&&purpose==='MATERIAL')await q.run('UPDATE material_selections SET ids_json=?,updated_at=? WHERE case_id=?',[JSON.stringify([...selected,...parsed.map(p=>p.id)]),now(),caseId]);
        await this.touch(q,caseId);
        await this.event(q,row,'attachments.added',user.id,{ ids:parsed.map(x => x.id),revision:row.revision+1 });
        const result = [];
        for (const entry of parsed) result.push(this.attachmentView((await q.get('SELECT * FROM attachments WHERE id=?',[entry.id]))!));
        return { attachments:result,caseRevision:row.revision+1 };
      });
    } catch (error) { await Promise.all(written.map(file => unlink(file).catch(() => {}))); throw error; }
  }
  async download(user: Principal, attachmentId: string) {
    const file = await this.db.get('SELECT * FROM attachments WHERE id=?',[attachmentId]);
    requireThat(file,404,'NOT_FOUND','附件不存在');
    await this.case(this.db,user,file.case_id);
    return { name:file.name as string,buffer:await readFile(path.join(this.config.dataDir,'attachments',file.stored_name)) };
  }
  async createRule(user: Principal, orgId: string, input: { scenario: Scenario; title:string; effectiveFrom:string; effectiveTo?:string; requiredFields:string[]; requirements:string }) {
    return this.db.transaction(async q => {
      await this.org(q,user,orgId,['ADMIN']);
      await q.get('SELECT id FROM organizations WHERE id=?'+this.db.lock,[orgId]);
      const ruleId = id();
      await q.run('INSERT INTO rules(id,org_id,scenario,title,version,effective_from,effective_to,content_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [ruleId,orgId,input.scenario,input.title,1,input.effectiveFrom,input.effectiveTo || null,JSON.stringify({requiredFields:input.requiredFields,requirements:input.requirements}),now()]);
      return { id:ruleId,version:1,...input };
    });
  }
  async rules(user: Principal, orgId:string, date:string, query:string) {
    await this.org(this.db,user,orgId);
    const rows = await this.db.all('SELECT * FROM rules WHERE org_id=? AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ORDER BY created_at DESC LIMIT 100',[orgId,date,date]);
    return rows.map(row => ({id:row.id,title:row.title,scenario:row.scenario,version:row.version,effectiveFrom:row.effective_from,effectiveTo:row.effective_to,...JSON.parse(row.content_json)}))
      .filter(row => !query || `${row.title} ${row.requirements}`.includes(query));
  }
  async records(user:Principal,caseId:string){
    await this.case(this.db,user,caseId);
    const files=await this.db.all('SELECT * FROM attachments WHERE case_id=? ORDER BY created_at,id',[caseId]);
    const corrections=await correctionRows(this.db,caseId);
    const selected=await materialIds(this.db,caseId);
    return {attachments:files.map(file=>({attachmentId:file.id,name:file.name,purpose:file.purpose,active:materialActive(file,selected),records:correctedFile(file,corrections).records})),correctionDigest:correctionsDigest(corrections)};
  }
  async selectMaterials(user:Principal,caseId:string,input:{expectedRevision:number;activeAttachmentIds:string[];reason:string}){
    return this.db.transaction(async q=>{
      const row=await this.case(q,user,caseId,editors,true);this.ensureOpen(row);this.expect(row,input.expectedRevision);
      const files=await q.all("SELECT id FROM attachments WHERE case_id=? AND purpose='MATERIAL'",[caseId]);
      requireThat(input.activeAttachmentIds.every(selected=>files.some(f=>f.id===selected)),422,'INVALID_MATERIAL_SELECTION','只能选择当前事项的业务材料');
      const existing=await q.get('SELECT case_id FROM material_selections WHERE case_id=?',[caseId]);
      if(existing)await q.run('UPDATE material_selections SET ids_json=?,actor_id=?,reason=?,updated_at=? WHERE case_id=?',[JSON.stringify(input.activeAttachmentIds),user.id,input.reason,now(),caseId]);
      else await q.run('INSERT INTO material_selections(case_id,ids_json,actor_id,reason,updated_at) VALUES (?,?,?,?,?)',[caseId,JSON.stringify(input.activeAttachmentIds),user.id,input.reason,now()]);
      await this.touch(q,caseId);await this.event(q,row,'materials.selected',user.id,{activeAttachmentIds:input.activeAttachmentIds,reason:input.reason});
      return {caseRevision:row.revision+1,activeAttachmentIds:input.activeAttachmentIds};
    });
  }
  async correct(user:Principal,caseId:string,input:{expectedRevision:number;attachmentId:string;recordId:string;field:string;value:string;reason:string}){
    return this.db.transaction(async q=>{
      const row=await this.case(q,user,caseId,editors,true);this.ensureOpen(row);this.expect(row,input.expectedRevision);
      const file=await q.get('SELECT * FROM attachments WHERE id=? AND case_id=?',[input.attachmentId,caseId]);
      requireThat(file?.purpose==='MATERIAL',404,'NOT_FOUND','业务材料不存在');
      const record=correctedFile(file,[]).records.find(r=>r.id===input.recordId);
      requireThat(record,404,'NOT_FOUND','解析记录不存在');
      const correctionId=id(),original=Object.hasOwn(record.fields,input.field)?record.fields[input.field]!:null;
      await q.run('INSERT INTO field_corrections(id,case_id,attachment_id,record_id,field,original_value,value,reason,actor_id,case_revision,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [correctionId,caseId,input.attachmentId,input.recordId,input.field,original,input.value,input.reason,user.id,row.revision+1,now()]);
      await this.touch(q,caseId);
      await this.event(q,row,'field.corrected',user.id,{correctionId,recordId:input.recordId,field:input.field,reason:input.reason});
      return {correctionId,originalValue:original,value:input.value,caseRevision:row.revision+1};
    });
  }
  async snapshot(q:Query,row:Row):Promise<RunInput>{
    const selected=await materialIds(q,row.id);
    const attachments=(await q.all('SELECT * FROM attachments WHERE case_id=? ORDER BY created_at,id',[row.id])).filter(f=>materialActive(f,selected));
    const corrections=(await correctionRows(q,row.id)).filter(c=>attachments.some(a=>a.id===c.attachment_id));
    const rules=await q.all('SELECT * FROM rules WHERE org_id=? AND scenario=? AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ORDER BY created_at,id',[row.org_id,row.scenario,row.business_date,row.business_date]);
    return {caseId:row.id,scenario:row.scenario,title:row.title,businessDate:row.business_date,data:JSON.parse(row.data_json),revision:row.revision,
      verificationEngineVersion:checkEngineVersion,correctionDigest:correctionsDigest(corrections),attachments:attachments.map(file=>({id:file.id,name:file.name,purpose:file.purpose,sha256:file.sha256,parsed:correctedFile(file,corrections)})),
      rules:rules.map(rule=>({id:rule.id,title:rule.title,version:rule.version,content:JSON.parse(rule.content_json)}))};
  }
  async evidenceRefs(q:Query,caseId:string){
    const row=(await q.get('SELECT * FROM cases WHERE id=?',[caseId]))!;
    const snapshot=await this.snapshot(q,row);
    return new Set([
      ...snapshot.attachments.flatMap(a=>[`attachment:${a.id}`,...a.parsed.records.map(r=>`record:${r.id}`)]),
      ...snapshot.rules.map(r=>`rule:${r.id}@${r.version}`),
      ...(await correctionRows(q,caseId)).filter(r=>snapshot.attachments.some(a=>a.id===r.attachment_id)).map(r=>`correction:${r.id}`)
    ]);
  }
  async requestRun(user: Principal, caseId:string, expected:number,options?:RunRequest) {
    return this.db.transaction(async q => {
      const row = await this.case(q,user,caseId,editors,true);
      this.ensureOpen(row); this.expect(row,expected);
      const active = await q.get("SELECT id FROM runs WHERE case_id=? AND status IN ('QUEUED','RUNNING','PAUSE_REQUESTED','PAUSED')",[caseId]);
      requireThat(!active,409,'RUN_ACTIVE','该事项已有排队或运行中的任务');
      const input=await this.snapshot(q,row);
      requireThat(input.attachments.some(x=>x.purpose==='MATERIAL'),422,'MATERIAL_REQUIRED','请先上传业务材料');
      input.mode=options?.mode||'RULES';
      const report=options?.mode==='MODEL'?options:options?.mode==='TEAM'?options.report:undefined;
      if(report){
        requireThat(this.config.model,409,'MODEL_NOT_CONFIGURED','请先配置模型服务地址、名称和密钥');
        const {document,row:documentCase}=await this.document(q,user,report.documentId);
        requireThat(documentCase.id===row.id,404,'NOT_FOUND','目标文档不属于当前事项');
        requireThat(document.current_version===report.expectedDocumentVersion,409,'VERSION_CONFLICT','文档基准版本已过期');
        const v=(await q.get('SELECT * FROM document_versions WHERE document_id=? AND version=?',[document.id,document.current_version]))!;
        await this.assertFreshEvidence(q,row,v);
        const blocks:Block[]=JSON.parse(v.content_json);
        requireThat(report.blockIds.every(blockId=>blocks.some(b=>b.id===blockId)),422,'INVALID_BLOCK','目标区块不存在');
        const skill=await this.skills.published(q,user,row.org_id,row.scenario,report.skillId,report.skillVersion);
        input.model={documentId:document.id,baseVersion:document.current_version,blocks:blocks.filter(b=>report.blockIds.includes(b.id)),goal:report.goal,skill,agentVersion};
      }
      if(options?.mode==='TEAM'){
        const team=await this.teams.published(q,user,row.org_id,row.scenario,options.teamId,options.teamVersion);
        input.team={...team,route:{routePolicyVersion:'fixed-team@1',identity:{orgId:row.org_id,principalId:user.id},scene:row.scenario,objectIds:[caseId],intent:'VERIFY_AND_DRAFT',
          capability:'TEAM',execution:input.model?'MODEL_PATCH':'RULES_DRAFT',routes:input.model?['R2','R3','R6']:['R2','R3'],reasonCode:'EXPLICIT_TEAM_TEMPLATE',requiresConfirmation:true,
          layers:[
            {layer:'L0',decision:'AUTHORIZED_CASE_SCOPE',orgId:row.org_id,principalId:user.id},
            {layer:'L1',decision:'EXPLICIT_CASE',scenario:row.scenario,caseId,businessDate:row.business_date},
            {layer:'L2',decision:'VERIFY_AND_DRAFT',formalBusinessWrites:false},
            {layer:'L3',decision:'PINNED_TEAM',teamId:team.teamId,teamVersion:team.version,teamDigest:team.digest,coordinatorVersion:'coordinator@1',agents:team.definition.nodes.map(n=>({nodeId:n.id,agentVersion:n.agentVersion}))},
            {layer:'L4',decision:input.model?'MODEL_REPORT':'RULE_TOOLS',concurrency:team.definition.concurrency,maxModelCalls:team.definition.maxModelCalls,maxAttempts:team.definition.maxAttempts},
            {layer:'L5',decision:'HUMAN_REVIEW_REQUIRED',inputRevision:row.revision,confirmationRequired:true}
          ]}};
      }
      const runId = id();
      const steps = input.team?input.team.definition.nodes.map(node=>({name:node.id,status:'QUEUED'})):['LOAD_EVIDENCE','VERIFY',input.mode==='MODEL'?'MODEL_PATCH':'DRAFT'].map(name => ({name,status:'QUEUED'}));
      await q.run(`INSERT INTO runs(id,case_id,requested_by,status,input_revision,input_json,steps_json,created_at,updated_at)
        VALUES (?,?,?,'QUEUED',?,?,?,?,?)`,[runId,caseId,user.id,row.revision,JSON.stringify(input),JSON.stringify(steps),now(),now()]);
      if(input.team)await this.branches.initializeRoot(q,row,runId,input,user.id);
      await this.event(q,row,'run.queued',user.id,{runId,mode:input.mode});
      if(input.team)await this.teams.initialize(q,row,runId,input,user.id);
      return {runId,status:'QUEUED',mode:input.mode,steps};
    });
  }
  async runView(user:Principal,runId:string) {
    const run = await this.db.get('SELECT * FROM runs WHERE id=?',[runId]);
    requireThat(run,404,'NOT_FOUND','运行不存在');
    await this.case(this.db,user,run.case_id);
    const input:RunInput=JSON.parse(run.input_json);
    const attempts=await this.db.all('SELECT attempt,model,status,latency_ms AS latencyMs,prompt_tokens AS promptTokens,completion_tokens AS completionTokens,total_tokens AS totalTokens,created_at AS createdAt FROM model_attempts WHERE run_id=? ORDER BY attempt,created_at',[runId]);
    const graph=input.team?await this.teams.graph(this.db,runId):undefined;
    return {id:run.id,caseId:run.case_id,status:run.status,mode:input.mode||'RULES',inputRevision:run.input_revision,
      definition:input.model?{agentVersion:input.model.agentVersion,skillId:input.model.skill.skillId,skillVersion:input.model.skill.version,skillDigest:input.model.skill.digest}:null,usage:{attempts,cost:null},
      ...(graph?{team:graph}:{}),
      ...(input.team?{lineage:await this.branches.lineage(this.db,runId),reuse:{nodes:await this.branches.reusedNodes(this.db,runId),verification:graph?.nodes.find(n=>n.role==='VERIFY')?.output?.verification??null}}:{}),
      steps:graph?graph.nodes.map(n=>({name:n.id,status:n.status})):JSON.parse(run.steps_json),output:run.output_json ? JSON.parse(run.output_json) : null,
      error:run.error_message,createdAt:run.created_at,updatedAt:run.updated_at};
  }
  async cancel(user:Principal,runId:string) {
    const lookup = await this.db.get('SELECT case_id,input_json FROM runs WHERE id=?',[runId]);
    requireThat(lookup,404,'NOT_FOUND','运行不存在');
    if(JSON.parse(lookup.input_json).team){
      const control=await this.db.get('SELECT revision FROM run_controls WHERE run_id=?',[runId]);
      await this.teams.control(user,runId,{action:'cancel',scope:'team',controlId:id(),expectedControlRevision:control!.revision});
      return {id:runId,status:'CANCELLED'};
    }
    return this.db.transaction(async q => {
      const row = await this.case(q,user,lookup.case_id,editors,true);
      const run = (await q.get('SELECT * FROM runs WHERE id=?'+this.db.lock,[runId]))!;
      if (run.status === 'CANCELLED') return {id:runId,status:'CANCELLED'};
      requireThat(['QUEUED','RUNNING'].includes(run.status),409,'INVALID_STATE','只有排队或运行中的任务可取消');
      const steps = JSON.parse(run.steps_json).map((s:any) => s.status==='COMPLETED' ? s : {...s,status:'CANCELLED'});
      await q.run("UPDATE runs SET status='CANCELLED',steps_json=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?",[JSON.stringify(steps),now(),runId]);
      await this.event(q,row,'run.cancelled',user.id,{runId});
      return {id:runId,status:'CANCELLED'};
    });
  }
  async document(q:Query,user:Principal,documentId:string,roles?:Role[],lock=false) {
    const lookup = await q.get('SELECT case_id FROM documents WHERE id=?',[documentId]);
    requireThat(lookup,404,'NOT_FOUND','文档不存在');
    const row = await this.case(q,user,lookup.case_id,roles,lock);
    const document = (await q.get('SELECT * FROM documents WHERE id=?'+(lock ? this.db.lock : ''),[documentId]))!;
    return { row,document };
  }
  async addDocument(q:Query,row:Row,userId:string,title:string,blocks:Block[],sourceRunId:string|null = null) {
    const documentId = id(),content=JSON.stringify(blocks),at=now();
    await q.run('INSERT INTO documents(id,case_id,current_version,title,created_at) VALUES (?,?,1,?,?)',[documentId,row.id,title,at]);
    await q.run(`INSERT INTO document_versions(document_id,version,parent_version,content_json,digest,author_id,source_run_id,restored_from,created_at)
      VALUES (?,1,NULL,?,?,?,?,NULL,?)`,[documentId,content,hash(content),userId,sourceRunId,at]);
    await this.touch(q,row.id);
    await this.event(q,row,'document.created',userId,{documentId,version:1});
    return {documentId,version:1,blocks,digest:hash(content),caseRevision:row.revision+1};
  }
  async createDocument(user:Principal,caseId:string,expected:number,title:string,blocks:Block[]) {
    return this.db.transaction(async q => {
      const row = await this.case(q,user,caseId,editors,true); this.ensureOpen(row); this.expect(row,expected);
      return this.addDocument(q,row,user.id,title,blocks);
    });
  }
  async getDocument(user:Principal,documentId:string,version?:number) {
    const {document} = await this.document(this.db,user,documentId);
    const v = await this.db.get('SELECT * FROM document_versions WHERE document_id=? AND version=?',[documentId,version ?? document.current_version]);
    requireThat(v,404,'NOT_FOUND','文档版本不存在');
    return {id:documentId,caseId:document.case_id,title:document.title,currentVersion:document.current_version,
      version:v.version,parentVersion:v.parent_version,blocks:JSON.parse(v.content_json) as Block[],digest:v.digest,
      authorId:v.author_id,sourceRunId:v.source_run_id,restoredFrom:v.restored_from,createdAt:v.created_at};
  }
  async saveDocument(user:Principal,documentId:string,expectedVersion:number,blocks?:Block[],restoreVersion?:number) {
    return this.db.transaction(async q => {
      const {row,document} = await this.document(q,user,documentId,editors,true); this.ensureOpen(row);
      requireThat(document.current_version===expectedVersion,409,'VERSION_CONFLICT','文档已变化，请比较最新版本');
      const previous = (await q.get('SELECT * FROM document_versions WHERE document_id=? AND version=?',[documentId,expectedVersion]))!;
      if (restoreVersion) {
        const old = await q.get('SELECT * FROM document_versions WHERE document_id=? AND version=?',[documentId,restoreVersion]);
        requireThat(old,404,'NOT_FOUND','历史版本不存在'); blocks=JSON.parse(old.content_json);
      }
      const content=JSON.stringify(blocks),version=expectedVersion+1;
      await q.run('INSERT INTO document_versions(document_id,version,parent_version,content_json,digest,author_id,source_run_id,restored_from,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [documentId,version,expectedVersion,content,hash(content),user.id,previous.source_run_id,restoreVersion ?? null,now()]);
      await q.run('UPDATE documents SET current_version=? WHERE id=?',[version,documentId]);
      await this.touch(q,row.id);
      await this.event(q,row,restoreVersion ? 'document.restored' : 'document.saved',user.id,{documentId,version,restoredFrom:restoreVersion ?? null});
      return {documentId,version,blocks,digest:hash(content),caseRevision:row.revision+1};
    });
  }
  async confirm(user:Principal,caseId:string,documentId:string,expected:number,note:string) {
    return this.db.transaction(async q => {
      const row = await this.case(q,user,caseId,reviewers,true); this.ensureOpen(row); this.expect(row,expected);
      const document = await q.get('SELECT * FROM documents WHERE id=? AND case_id=?',[documentId,caseId]);
      requireThat(document,404,'NOT_FOUND','文档不属于该事项');
      const version = (await q.get('SELECT * FROM document_versions WHERE document_id=? AND version=?',[documentId,document.current_version]))!;
      await this.patches.assertNoPending(q,documentId);
      await this.assertFreshEvidence(q,row,version);
      const confirmationId=id(),expiresAt=new Date(Date.now()+15*60000).toISOString();
      await q.run('INSERT INTO confirmations(id,case_id,document_id,document_version,digest,case_revision,user_id,note,expires_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [confirmationId,caseId,documentId,document.current_version,version.digest,row.revision,user.id,note,expiresAt]);
      await this.event(q,row,'publication.confirmed',user.id,{confirmationId,documentId,version:document.current_version,note});
      return {confirmationId,expiresAt,documentVersion:document.current_version,caseRevision:row.revision};
    });
  }
  async assertFreshEvidence(q:Query,row:Row,version:Row) {
    if (!version.source_run_id) return;
    await q.get('SELECT id FROM organizations WHERE id=?'+this.db.lock,[row.org_id]);
    const run = await q.get('SELECT input_json FROM runs WHERE id=?',[version.source_run_id]);
    const snapshot: RunInput = JSON.parse(run!.input_json);
    if(snapshot.team)requireThat((await this.branches.head(q,row.id))?.run_id===version.source_run_id,409,'EVIDENCE_STALE','文档属于历史分支，请使用当前分支生成的草稿');
    const selected=await materialIds(q,row.id);
    const currentFiles = (await q.all('SELECT id,purpose FROM attachments WHERE case_id=? ORDER BY id'+this.db.lock,[row.id])).filter(f=>materialActive(f,selected));
    const currentRules = await q.all('SELECT id,version FROM rules WHERE org_id=? AND scenario=? AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ORDER BY id'+this.db.lock,
      [row.org_id,row.scenario,row.business_date,row.business_date]);
    const snapshotRules=snapshot.rules.map(r=>({id:r.id,version:r.version})).sort((a,b)=>a.id.localeCompare(b.id));
    requireThat(JSON.stringify(currentFiles.map(x=>x.id))===JSON.stringify(snapshot.attachments.map(a=>a.id).sort())
      && JSON.stringify(currentRules.map(r=>({id:r.id,version:r.version})))===JSON.stringify(snapshotRules)
      && JSON.stringify(JSON.parse(row.data_json))===JSON.stringify(snapshot.data)
      && correctionsDigest((await correctionRows(q,row.id)).filter(c=>currentFiles.some(f=>f.id===c.attachment_id)))===(snapshot.correctionDigest||correctionsDigest([]))
      && row.business_date===snapshot.businessDate && row.title===snapshot.title,
      409,'EVIDENCE_STALE','材料、制度或业务字段已改变，请重新核验生成草稿');
  }
  async publish(user:Principal,input:{commandId:string;caseId:string;confirmationId:string;expectedRevision:number}) {
    const requestDigest=hash(JSON.stringify(input));
    return this.db.transaction(async q => {
      const row = await this.case(q,user,input.caseId,reviewers,true);
      const previous=await q.get('SELECT * FROM commands WHERE id=?',[input.commandId]);
      if (previous) {
        requireThat(previous.user_id===user.id && previous.request_digest===requestDigest,409,'COMMAND_CONFLICT','命令标识已被其他请求使用');
        return JSON.parse(previous.receipt_json);
      }
      this.ensureOpen(row); this.expect(row,input.expectedRevision);
      const confirmation=await q.get('SELECT * FROM confirmations WHERE id=? AND case_id=?',[input.confirmationId,input.caseId]);
      requireThat(confirmation && confirmation.user_id===user.id && confirmation.expires_at>now(),409,'CONFIRMATION_REQUIRED','需要当前用户重新确认发布');
      const document=await q.get('SELECT * FROM documents WHERE id=?',[confirmation.document_id]);
      requireThat(confirmation.case_revision===row.revision && document!.current_version===confirmation.document_version,409,'CONFIRMATION_STALE','确认后内容已变化，请重新确认');
      const version=(await q.get('SELECT * FROM document_versions WHERE document_id=? AND version=?',[document!.id,document!.current_version]))!;
      await this.patches.assertNoPending(q,document!.id);
      await this.assertFreshEvidence(q,row,version);
      const receipt={commandId:input.commandId,caseId:row.id,status:'PUBLISHED',documentId:document!.id,
        documentVersion:confirmation.document_version,digest:confirmation.digest,confirmationId:confirmation.id,caseRevision:row.revision+1,publishedAt:now()};
      await q.run("UPDATE cases SET status='PUBLISHED',revision=revision+1,updated_at=? WHERE id=?",[now(),row.id]);
      await q.run('INSERT INTO commands(id,case_id,user_id,request_digest,receipt_json,created_at) VALUES (?,?,?,?,?,?)',[input.commandId,row.id,user.id,requestDigest,JSON.stringify(receipt),now()]);
      await this.event(q,row,'case.published',user.id,receipt);
      return receipt;
    });
  }
  async events(user:Principal,caseId:string,after:number) {
    await this.case(this.db,user,caseId);
    const events=await this.db.all('SELECT * FROM events WHERE case_id=? AND seq>? ORDER BY seq LIMIT 100',[caseId,after]);
    return events.map(e => ({id:e.id,seq:e.seq,type:e.type,caseId:e.case_id,actorId:e.actor_id,data:JSON.parse(e.data_json),createdAt:e.created_at}));
  }
}
