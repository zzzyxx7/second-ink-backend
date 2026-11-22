import type { Service } from './service.js';
import type { Query,Row } from './db.js';
import type { Principal } from './auth.js';
import { hash,id,now } from './auth.js';
import { requireThat } from './errors.js';
import { skillContentSchema,tools,type SkillContent,modelOutputSchema } from './contracts.js';
import { verify,draft } from './verification.js';

export const agentVersion='report-agent@1';
export const skillTemplates=[
  {name:'周报补正草稿',scenario:'WEEKLY_REPORT',description:'根据核验问题和来源起草周报补正建议',instructions:'依据已经核验的事实和来源，对指定区块提出补正说明。保留冲突与待核实事项，不编造缺失数据。输出 JSON 修订提案。',toolBindings:[...tools]},
  {name:'入职材料说明',scenario:'ONBOARDING',description:'根据入职材料清单起草审阅说明',instructions:'依据员工字段、已提交材料与缺项清单，对指定区块提出入职说明修订。不得声称已经验证材料真实性。输出 JSON 修订提案。',toolBindings:[...tools]}
];
export class Skills {
  constructor(private service:Service){}
  view(row:Row){return {skillId:row.skill_id,version:row.version,status:row.status,digest:row.digest,content:JSON.parse(row.content_json),createdBy:row.created_by,createdAt:row.created_at};}
  async get(q:Query,user:Principal,skillId:string,version?:number,lock=false){
    const skill=await q.get('SELECT * FROM skills WHERE id=?'+(lock?this.service.db.lock:''),[skillId]);
    requireThat(skill,404,'NOT_FOUND','技能不存在');
    await this.service.org(q,user,skill.org_id);
    const suffix=lock?this.service.db.lock:'';
    const v=version===undefined?await q.get('SELECT * FROM skill_versions WHERE skill_id=? ORDER BY version DESC LIMIT 1'+suffix,[skillId]):await q.get('SELECT * FROM skill_versions WHERE skill_id=? AND version=?'+suffix,[skillId,version]);
    requireThat(v,404,'NOT_FOUND','技能版本不存在');
    return {skill,version:v};
  }
  async list(user:Principal,orgId:string){
    await this.service.org(this.service.db,user,orgId);
    const skills=await this.service.db.all('SELECT * FROM skills WHERE org_id=? ORDER BY created_at,id',[orgId]);
    return Promise.all(skills.map(async skill=>({id:skill.id,name:skill.name,versions:(await this.service.db.all('SELECT * FROM skill_versions WHERE skill_id=? ORDER BY version DESC',[skill.id])).map(r=>this.view(r))})));
  }
  async create(user:Principal,orgId:string,name:string,content:SkillContent){
    return this.service.db.transaction(async q=>{
      await this.service.org(q,user,orgId,['ADMIN']);
      const skillId=id();
      await q.run('INSERT INTO skills(id,org_id,name,created_at) VALUES (?,?,?,?)',[skillId,orgId,name,now()]);
      return this.addVersion(q,user,skillId,1,content);
    });
  }
  private async addVersion(q:Query,user:Principal,skillId:string,version:number,content:SkillContent){
    const json=JSON.stringify(skillContentSchema.parse(content));
    await q.run("INSERT INTO skill_versions(skill_id,version,status,content_json,digest,created_by,created_at) VALUES (?,?,'DRAFT',?,?,?,?)",[skillId,version,json,hash(json),user.id,now()]);
    return this.view((await q.get('SELECT * FROM skill_versions WHERE skill_id=? AND version=?',[skillId,version]))!);
  }
  async newVersion(user:Principal,skillId:string,content:SkillContent){
    return this.service.db.transaction(async q=>{
      const {skill,version}=await this.get(q,user,skillId,undefined,true);
      await this.service.org(q,user,skill.org_id,['ADMIN']);
      return this.addVersion(q,user,skillId,version.version+1,content);
    });
  }
  async trial(user:Principal,skillId:string,version:number,caseId:string){
    return this.service.db.transaction(async q=>{
      const row=await this.service.case(q,user,caseId,['ADMIN','HANDLER'],true);
      const skill=await this.get(q,user,skillId,version);
      requireThat(skill.skill.org_id===row.org_id,404,'NOT_FOUND','技能不属于当前组织');
      requireThat(skill.version.status!=='DISABLED',409,'SKILL_DISABLED','技能已停用');
      let result:Record<string,unknown>;
      const executed:string[]=[];
      try{
        const content=skillContentSchema.parse(JSON.parse(skill.version.content_json));
        requireThat(content.scenario===row.scenario,422,'SCENARIO_MISMATCH','技能场景不匹配');
        const snapshot=await this.service.snapshot(q,row);executed.push('get_case_snapshot','find_applicable_rules');
        requireThat(snapshot.attachments.some(a=>a.purpose==='MATERIAL'),422,'MATERIAL_REQUIRED','试跑事项需要业务材料');
        const checked=verify(snapshot);executed.push('get_verification_result');
        const blocks=draft(snapshot,checked);
        const refs=await this.service.evidenceRefs(q,caseId);
        const proposal=modelOutputSchema.parse({replacements:[{blockId:blocks[0]!.id,text:blocks[0]!.text}],reason:'离线契约验证',evidenceRefs:[[...refs][0]!]});
        this.service.patches.validate(blocks,{baseVersion:1,...proposal},refs);executed.push('propose_document_patch');
        result={passed:true,kind:'OFFLINE_CONTRACT',actualTools:executed,modelCalled:false,issueCount:checked.issues.length,contentDigest:skill.version.digest};
      }catch(error){result={passed:false,kind:'OFFLINE_CONTRACT',actualTools:executed,modelCalled:false,error:error instanceof Error?error.message:'试跑失败',contentDigest:skill.version.digest};}
      const trialId=id();
      await q.run('INSERT INTO skill_trials(id,skill_id,version,case_id,passed,result_json,created_at) VALUES (?,?,?,?,?,?,?)',[trialId,skillId,version,caseId,result.passed?1:0,JSON.stringify(result),now()]);
      return {trialId,...result};
    });
  }
  async changeStatus(user:Principal,skillId:string,version:number,status:'PUBLISHED'|'DISABLED'){
    return this.service.db.transaction(async q=>{
      const loaded=await this.get(q,user,skillId,version,true);
      await this.service.org(q,user,loaded.skill.org_id,['ADMIN']);
      if(status==='PUBLISHED'){
        const trial=await q.get('SELECT id FROM skill_trials WHERE skill_id=? AND version=? AND passed=1',[skillId,version]);
        requireThat(trial,409,'SKILL_TRIAL_REQUIRED','发布前需要通过离线契约试跑');
      }
      await q.run('UPDATE skill_versions SET status=? WHERE skill_id=? AND version=?',[status,skillId,version]);
      return this.view((await q.get('SELECT * FROM skill_versions WHERE skill_id=? AND version=?',[skillId,version]))!);
    });
  }
  async published(q:Query,user:Principal,orgId:string,scenario:string,skillId:string,version:number){
    const loaded=await this.get(q,user,skillId,version,true);
    requireThat(loaded.skill.org_id===orgId,404,'NOT_FOUND','技能不属于当前组织');
    requireThat(loaded.version.status==='PUBLISHED',409,'SKILL_DISABLED','技能版本未发布或已停用');
    const content=skillContentSchema.parse(JSON.parse(loaded.version.content_json));
    requireThat(content.scenario===scenario,422,'SCENARIO_MISMATCH','技能场景不匹配');
    return {skillId,version,digest:loaded.version.digest,content};
  }
}
