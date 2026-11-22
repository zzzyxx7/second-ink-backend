import { z } from 'zod';
import * as c from './contracts.js';
import { uuid,revision,blocksSchema,ruleSchema,scenarioSchema } from './types.js';
import { teamDefinitionSchema,teamCreateSchema,teamControlSchema } from './team-contracts.js';
import { materialSelectionSchema,amendmentSchema,branchCommitSchema } from './branch-contracts.js';

const dateTime=z.string().datetime();
const success=(data:z.ZodType)=>z.object({code:z.literal(0),message:z.literal('success'),data});
const block=blocksSchema.element;
const organization=z.object({id:uuid,name:z.string(),role:z.string()});
const caseInfo=z.object({id:uuid,orgId:uuid,createdBy:uuid,submitterId:uuid.nullable(),title:z.string(),scenario:scenarioSchema,businessDate:z.string(),status:z.enum(['OPEN','PUBLISHED']),revision,data:z.record(z.string(),z.unknown()),createdAt:dateTime,updatedAt:dateTime});
const source=z.object({attachmentId:uuid,filename:z.string(),locator:z.record(z.string(),z.union([z.string(),z.number()])),quote:z.string()});
const record=z.object({id:z.string().optional(),fields:z.record(z.string(),z.string()),sources:z.record(z.string(),source),corrections:z.record(z.string(),z.object({id:uuid,originalValue:z.string().nullable(),value:z.string(),reason:z.string(),actorId:uuid,createdAt:dateTime})).optional()});
const attachment=z.object({id:uuid,caseId:uuid,name:z.string(),sha256:z.string(),size:z.number().int(),purpose:z.enum(['MATERIAL','REFERENCE']),active:z.boolean(),parsed:z.object({text:z.string(),records:z.array(record),warnings:z.array(z.string())}),createdAt:dateTime});
const versionInfo=z.object({version:revision,parentVersion:revision.nullable(),digest:z.string(),authorId:uuid,restoredFrom:revision.nullable(),createdAt:dateTime});
const patchInfo=z.object({id:uuid,documentId:uuid,baseVersion:revision,replacements:c.replacementsSchema,reason:z.string(),evidenceRefs:z.array(z.string()),sourceRunId:uuid.nullable(),status:c.patchStatusSchema,acceptedVersion:revision.nullable(),actorId:uuid,createdAt:dateTime,decidedAt:dateTime.nullable()});
const skillVersionInfo=z.object({skillId:uuid,version:revision,status:z.enum(['DRAFT','PUBLISHED','DISABLED']),digest:z.string(),content:c.skillContentSchema,createdBy:uuid,createdAt:dateTime});
const ruleInfo=z.object({id:uuid,title:z.string(),scenario:scenarioSchema,version:revision,effectiveFrom:z.string(),effectiveTo:z.string().nullable(),requiredFields:z.array(z.string()),requirements:z.string()});
const issue=z.object({code:z.string(),field:z.string(),message:z.string(),severity:z.enum(['ERROR','WARNING']),sources:z.array(source)});
const verificationStats=z.object({mode:z.enum(['FULL','INCREMENTAL','REUSED_NODE']),reused:z.number().int().nonnegative(),executed:z.number().int().nonnegative(),total:z.number().int().nonnegative(),removed:z.number().int().nonnegative(),fallbackReason:z.string().nullable()});
const decision=z.object({key:z.string(),engineVersion:z.string(),fingerprint:z.string(),dependencies:z.array(z.object({ref:z.string(),digest:z.string()})),issues:z.array(issue),outputDigest:z.string()});
const checkResult=z.object({mode:z.literal('RULES'),ruleRefs:z.array(z.object({id:uuid,version:revision,title:z.string()})),issues:z.array(issue),records:z.array(record),summary:z.string(),documentId:uuid,documentVersion:revision,caseRevision:revision,decisions:z.array(decision).optional(),verification:verificationStats.optional()});
const lineage=z.object({runId:uuid,branchId:uuid,rootRunId:uuid,parentRunId:uuid.nullable(),sourceCheckpointId:uuid.nullable(),planVersion:revision,supersededRunId:uuid.nullable(),isCurrent:z.boolean(),currentRunId:uuid.nullable()});
const nodeReuse=z.object({nodeId:z.string(),sourceRunId:uuid,checkpointId:uuid,sourceDigest:z.string()});
const dispositions=z.array(z.object({nodeId:z.string(),role:z.string(),action:z.enum(['REUSE','RECOMPUTE']),reason:z.string()}));
const preview=z.object({previewId:uuid,previewDigest:z.string(),expiresAt:dateTime,kind:z.enum(['AMEND','HISTORY']),sourceRunId:uuid,checkpointId:uuid,rootRunId:uuid,proposedPlanVersion:revision,caseRevision:revision,nextCaseRevision:revision,nodes:dispositions,verification:verificationStats,budget:z.object({scope:z.literal('ROOT_RUN'),used:z.number().int(),max:revision,remaining:z.number().int()}),requiresNewConfirmation:z.literal(true)});
const teamVersion=z.object({teamId:uuid,version:revision,status:z.enum(['DRAFT','PUBLISHED','DISABLED']),digest:z.string(),definition:teamDefinitionSchema,createdBy:uuid,createdAt:dateTime});
const teamGraph=z.object({runId:uuid,teamId:uuid,teamVersion:revision,teamDigest:z.string(),coordinatorVersion:z.string(),controlRevision:revision,controlEpoch:revision,pausedNodes:z.array(z.string()),modelCalls:z.number().int(),rootModelCalls:z.number().int(),budget:z.object({scope:z.literal('ROOT_RUN'),maxModelCalls:revision,maxAttempts:revision,concurrency:revision}),route:z.record(z.string(),z.unknown()),nodes:z.array(z.object({id:z.string(),role:z.enum(['POLICY','MATERIALS','VERIFY','REPORT']),agentVersion:z.string(),dependsOn:z.array(z.string()),required:z.boolean(),timeoutMs:z.number(),status:z.enum(['QUEUED','RUNNING','COMPLETED','SKIPPED','FAILED','PAUSED','PAUSE_REQUESTED','CANCELLED']),attempt:z.number().int(),generation:z.number().int(),reusedFrom:nodeReuse.nullable(),output:z.unknown().nullable(),error:z.string().nullable(),startedAt:dateTime.nullable(),finishedAt:dateTime.nullable()}))});
const controlReceipt=z.object({receiptId:uuid,runId:uuid,controlRevision:revision,controlEpoch:revision,state:c.runStatusSchema,scope:z.enum(['team','branch']),affectedNodes:z.array(z.string())});
export const responseSchemas={
  Error:z.object({code:z.string(),message:z.string(),requestId:z.string().optional(),details:z.unknown().optional()}),
  Success:success(z.unknown()),
  Session:success(z.object({user:z.object({id:uuid,username:z.string()}),token:z.string(),expiresAt:dateTime})),
  Case:success(caseInfo),
  CaseDetail:success(caseInfo.extend({attachments:z.array(attachment),documents:z.array(z.object({id:uuid,title:z.string(),currentVersion:revision,createdAt:dateTime})),runs:z.array(z.object({id:uuid,status:c.runStatusSchema,createdAt:dateTime})),currentRunId:uuid.nullable()})),
  CaseList:success(z.array(caseInfo)),
  Organizations:success(z.array(organization)),
  Organization:success(organization),
  Profile:success(z.object({id:uuid,username:z.string(),organizations:z.array(organization)})),
  Membership:success(z.object({userId:uuid,username:z.string(),role:z.string()})),
  LoggedOut:success(z.object({loggedOut:z.literal(true)})),
  Uploaded:success(z.object({attachments:z.array(attachment),caseRevision:revision})),
  Rules:success(z.array(ruleInfo)),
  RuleCreated:success(ruleInfo.omit({effectiveTo:true}).extend({effectiveTo:z.string().optional()})),
  Records:success(z.object({attachments:z.array(z.object({attachmentId:uuid,name:z.string(),purpose:z.enum(['MATERIAL','REFERENCE']),active:z.boolean(),records:z.array(record)})),correctionDigest:z.string()})),
  MaterialSelection:success(z.object({caseRevision:revision,activeAttachmentIds:z.array(uuid)})),
  Amendment:success(preview),
  Branch:success(z.object({runId:uuid,branchId:uuid,rootRunId:uuid,parentRunId:uuid,sourceCheckpointId:uuid,planVersion:revision,supersededRunId:uuid.nullable(),caseRevision:revision,status:z.literal('QUEUED'),reuse:dispositions})),
  Branches:success(z.array(lineage.extend({status:c.runStatusSchema,createdAt:dateTime}))),
  Corrected:success(z.object({correctionId:uuid,originalValue:z.string().nullable(),value:z.string(),caseRevision:revision})),
  SavedDocument:success(z.object({documentId:uuid,version:revision,blocks:blocksSchema,digest:z.string(),caseRevision:revision})),
  DocumentVersions:success(z.array(versionInfo)),
  Patches:success(z.array(patchInfo)),
  Diff:success(z.object({documentId:uuid,fromVersion:revision,toVersion:revision,changes:z.array(z.object({blockId:uuid,change:z.enum(['ADDED','DELETED','MODIFIED']),before:block.nullable(),after:block.nullable()}))})),
  Confirmation:success(z.object({confirmationId:uuid,expiresAt:dateTime,documentVersion:revision,caseRevision:revision})),
  Receipt:success(z.object({commandId:uuid,caseId:uuid,status:z.literal('PUBLISHED'),documentId:uuid,documentVersion:revision,digest:z.string(),confirmationId:uuid,caseRevision:revision,publishedAt:dateTime})),
  Events:success(z.array(z.object({id:uuid,seq:revision,type:z.string(),caseId:uuid,actorId:uuid,data:z.record(z.string(),z.unknown()),createdAt:dateTime}))),
  SkillTemplates:success(z.array(c.skillCreateSchema)),
  Skills:success(z.array(z.object({id:uuid,name:z.string(),versions:z.array(skillVersionInfo)}))),
  Trial:success(z.object({trialId:uuid,passed:z.boolean(),kind:z.literal('OFFLINE_CONTRACT'),actualTools:z.array(z.string()),modelCalled:z.literal(false),contentDigest:z.string(),issueCount:z.number().optional(),error:z.string().optional()})),
  Cancelled:success(z.object({id:uuid,status:z.literal('CANCELLED')})),
  Control:success(z.union([z.object({id:uuid,status:z.literal('CANCELLED')}),controlReceipt])),
  TeamVersion:success(teamVersion),
  Teams:success(z.array(z.object({id:uuid,name:z.string(),versions:z.array(teamVersion)}))),
  TeamTemplates:success(z.array(teamCreateSchema)),
  Checkpoints:success(z.array(z.object({id:uuid,runId:uuid,controlEpoch:revision,eventSeq:revision,digest:z.string(),snapshot:z.object({runId:uuid,cacheVersion:z.string().optional(),lineage:lineage.nullable().optional(),inputDigest:z.string(),evidenceDigest:z.string(),caseRevision:revision,teamDigest:z.string(),completedSteps:z.array(z.object({nodeId:z.string(),status:z.enum(['COMPLETED','SKIPPED']),fingerprint:z.string().nullable().optional(),output:z.unknown().nullable(),outputDigest:z.string()})),documentVersions:z.array(z.object({documentId:uuid,version:revision})),controlEpoch:revision,eventSeq:revision}),createdAt:dateTime}))),
  Health:success(z.object({status:z.literal('UP'),version:z.string(),database:z.enum(['sqlite','mysql']),executionMode:z.literal('RULES'),modelConfigured:z.boolean(),embeddedWorker:z.boolean(),capabilities:z.array(z.string()),pending:z.array(z.string())})),
  Document:success(z.object({id:uuid,caseId:uuid,title:z.string(),currentVersion:revision,version:revision,parentVersion:revision.nullable(),blocks:blocksSchema,digest:z.string(),authorId:uuid,sourceRunId:uuid.nullable(),restoredFrom:revision.nullable(),createdAt:dateTime})),
  Run:success(z.object({id:uuid,caseId:uuid,status:c.runStatusSchema,mode:z.enum(['RULES','MODEL','TEAM']),inputRevision:revision,definition:z.object({agentVersion:z.string(),skillId:uuid,skillVersion:revision,skillDigest:z.string()}).nullable(),usage:z.object({attempts:z.array(z.object({attempt:z.number().int(),model:z.string(),status:z.string(),latencyMs:z.number().int(),promptTokens:z.number().int().nullable(),completionTokens:z.number().int().nullable(),totalTokens:z.number().int().nullable(),createdAt:dateTime})),cost:z.null()}),steps:z.array(z.looseObject({name:z.string(),status:z.string()})),lineage:lineage.nullable().optional(),reuse:z.object({nodes:z.array(nodeReuse),verification:verificationStats.nullable()}).optional(),team:teamGraph.optional(),output:z.union([checkResult,z.object({mode:z.literal('MODEL'),patchId:uuid,documentId:uuid,baseVersion:revision,actualTools:z.array(z.string())}),checkResult.omit({mode:true}).extend({mode:z.literal('TEAM'),execution:z.literal('RULES_DRAFT')}),z.object({mode:z.literal('TEAM'),execution:z.literal('MODEL_PATCH'),patchId:uuid,documentId:uuid,baseVersion:revision})]).nullable(),error:z.string().nullable(),createdAt:dateTime,updatedAt:dateTime})),
  Patch:success(z.object({id:uuid,documentId:uuid,baseVersion:revision,replacements:c.replacementsSchema,reason:z.string(),evidenceRefs:z.array(z.string()),sourceRunId:uuid.nullable(),status:c.patchStatusSchema,acceptedVersion:revision.nullable(),actorId:uuid,createdAt:dateTime,decidedAt:dateTime.nullable()})),
  SkillVersion:success(z.object({skillId:uuid,version:revision,status:z.enum(['DRAFT','PUBLISHED','DISABLED']),digest:z.string(),content:c.skillContentSchema,createdBy:uuid,createdAt:dateTime})),
  RequestedRun:success(z.object({runId:uuid,status:z.literal('QUEUED'),mode:z.enum(['RULES','MODEL','TEAM']),steps:z.array(z.object({name:z.string(),status:z.string()}))}))
};
type Endpoint={method:string;path:string;summary:string;body?:z.ZodType;response?:keyof typeof responseSchemas;status?:number;public?:boolean;query?:{name:string;required?:boolean;type?:string}[];file?:boolean;multipart?:boolean};
export const endpoints:Endpoint[]=[
  {method:'get',path:'/api/health',summary:'健康状态、能力与模型配置状态',public:true},
  {method:'get',path:'/api/openapi.json',summary:'OpenAPI 3.1 原始规范',public:true},
  {method:'post',path:'/api/auth/register',summary:'注册',body:c.credentials,response:'Session',status:201,public:true},
  {method:'post',path:'/api/auth/login',summary:'登录',body:c.credentials,response:'Session',public:true},
  {method:'post',path:'/api/auth/logout',summary:'撤销当前会话'},
  {method:'get',path:'/api/auth/profile',summary:'当前用户与组织'},
  {method:'get',path:'/api/organizations',summary:'当前用户组织列表'},
  {method:'post',path:'/api/organizations',summary:'创建组织',body:c.organizationSchema,status:201},
  {method:'post',path:'/api/organizations/{id}/members',summary:'管理员添加已注册成员',body:c.memberSchema,status:201},
  {method:'post',path:'/api/cases',summary:'管理员或经办人创建事项',body:c.createCaseSchema,response:'Case',status:201},
  {method:'get',path:'/api/cases',summary:'按组织查询可见事项',query:[{name:'orgId',required:true}]},
  {method:'get',path:'/api/cases/{id}',summary:'读取事项及材料、文档与运行',response:'Case'},
  {method:'patch',path:'/api/cases/{id}',summary:'按预期版本修改事项',body:c.updateCaseSchema,response:'Case'},
  {method:'post',path:'/api/cases/{id}/attachments',summary:'上传原件和解析，每次 5 件、每件 5 MB',multipart:true,status:201},
  {method:'get',path:'/api/attachments/{id}/download',summary:'下载授权附件',file:true},
  {method:'post',path:'/api/organizations/{id}/rules',summary:'管理员登记不可变制度',body:ruleSchema,status:201},
  {method:'get',path:'/api/rules',summary:'按组织及有效日期检索制度',query:[{name:'orgId',required:true},{name:'date',required:true},{name:'q'}]},
  {method:'post',path:'/api/agent/requests',summary:'创建 RULES 核验或 MODEL 修订运行；MODEL 需六项额外参数',body:c.runRequestSchema,response:'RequestedRun',status:202},
  {method:'get',path:'/api/runs/{id}',summary:'运行状态、定义版本、产物及调用统计',response:'Run'},
  {method:'post',path:'/api/runs/{id}/control',summary:'兼容取消；TEAM 使用幂等控制标识和版本暂停、续办、重试或取消',body:z.union([c.controlSchema,teamControlSchema])},
  {method:'get',path:'/api/runs/{id}/checkpoints',summary:'查询稳定检查点及已完成节点产物',response:'Checkpoints'},
  {method:'post',path:'/api/cases/{id}/material-selection',summary:'经办人或管理员选择生效业务材料；原件与历史记录保留',body:materialSelectionSchema,response:'MaterialSelection'},
  {method:'post',path:'/api/runs/{id}/amendments',summary:'经办人或管理员预览微调或历史分支；预览有效五分钟',body:amendmentSchema,response:'Amendment',status:201},
  {method:'post',path:'/api/runs/{id}/branches',summary:'幂等确认预览并切换唯一执行分支；不重放发布命令',body:branchCommitSchema,response:'Branch',status:202},
  {method:'get',path:'/api/runs/{id}/branches',summary:'查询同根运行的分支谱系',response:'Branches'},
  {method:'post',path:'/api/cases/{id}/documents',summary:'创建手工文档',body:c.documentCreateSchema,status:201},
  {method:'get',path:'/api/documents/{id}',summary:'读取当前文档',response:'Document'},
  {method:'get',path:'/api/documents/{id}/versions',summary:'文档版本元信息'},
  {method:'get',path:'/api/documents/{id}/versions/{version}',summary:'读取历史文档',response:'Document'},
  {method:'put',path:'/api/documents/{id}',summary:'保存新版本',body:c.documentSaveSchema},
  {method:'post',path:'/api/documents/{id}/restore',summary:'恢复内容为新版本',body:c.restoreSchema},
  {method:'get',path:'/api/documents/{id}/export',summary:'导出指定版本 TXT',file:true,query:[{name:'version',type:'integer'}]},
  {method:'post',path:'/api/cases/{id}/confirmations',summary:'审核人确认当前文档；待审提案或过期证据阻止确认',body:c.confirmationSchema,status:201},
  {method:'post',path:'/api/commands',summary:'审核人幂等发布；确认绑定当前用户与版本',body:c.commandSchema},
  {method:'get',path:'/api/events',summary:'事项事件；stream=true 使用 SSE，Last-Event-ID 优先于 after',query:[{name:'caseId',required:true},{name:'after',type:'integer'},{name:'stream',type:'boolean'}]},
  {method:'get',path:'/api/cases/{id}/records',summary:'生效字段、稳定记录 ID、原始来源和修正记录'},
  {method:'post',path:'/api/cases/{id}/field-corrections',summary:'经办人记录字段修正并增加事项版本',body:c.correctionSchema,status:201},
  {method:'get',path:'/api/documents/{id}/diff',summary:'按区块比较文档版本',query:[{name:'fromVersion',required:true,type:'integer'},{name:'toVersion',required:true,type:'integer'}]},
  {method:'get',path:'/api/documents/{id}/patches',summary:'文档修订提案列表'},
  {method:'post',path:'/api/documents/{id}/patches',summary:'经办人创建待审修订',body:c.patchSchema,response:'Patch',status:201},
  ...['accept','reject'].map(action=>({method:'post',path:`/api/patches/{id}/${action}`,summary:`${action==='accept'?'接受':'拒绝'}提案；重复处理返回原结果`,body:c.decisionSchema,response:'Patch' as const})),
  {method:'get',path:'/api/skill-templates',summary:'周报和入职 Skill 样例'},
  {method:'get',path:'/api/organizations/{id}/skills',summary:'组织 Skill 及版本列表'},
  {method:'post',path:'/api/organizations/{id}/skills',summary:'管理员创建 Skill 草稿',body:c.skillCreateSchema,response:'SkillVersion',status:201},
  {method:'post',path:'/api/skills/{id}/versions',summary:'以新版本编辑，不覆盖历史',body:c.skillContentSchema,response:'SkillVersion',status:201},
  {method:'get',path:'/api/skills/{id}/versions/{version}',summary:'查询具体 Skill 版本',response:'SkillVersion'},
  {method:'post',path:'/api/skills/{id}/versions/{version}/trials',summary:'离线工具及产物契约试跑，不调用模型',body:c.trialSchema,status:201},
  ...['publish','disable'].map(action=>({method:'post',path:`/api/skills/{id}/versions/{version}/${action}`,summary:action==='publish'?'管理员发布已通过试跑的版本':'管理员停用版本',body:z.object({}).strict(),response:'SkillVersion' as const})),
  {method:'get',path:'/api/team-templates',summary:'固定四角色协作团队样例',response:'TeamTemplates'},
  {method:'get',path:'/api/organizations/{id}/teams',summary:'组织内团队及版本',response:'Teams'},
  {method:'post',path:'/api/organizations/{id}/teams',summary:'创建经过 DAG 校验的团队草稿',body:teamCreateSchema,response:'TeamVersion',status:201},
  {method:'post',path:'/api/teams/{id}/versions',summary:'编辑团队为新版本',body:teamDefinitionSchema,response:'TeamVersion',status:201},
  {method:'get',path:'/api/teams/{id}/versions/{version}',summary:'读取固定团队版本',response:'TeamVersion'},
  ...['publish','disable'].map(action=>({method:'post',path:`/api/teams/{id}/versions/{version}/${action}`,summary:action==='publish'?'管理员发布已校验团队':'管理员停用团队',body:z.object({}).strict(),response:'TeamVersion' as const}))
];
const responseByOperation:Record<string,keyof typeof responseSchemas>={
  'get /api/health':'Health','post /api/auth/logout':'LoggedOut','get /api/auth/profile':'Profile',
  'get /api/organizations':'Organizations','post /api/organizations':'Organization','post /api/organizations/{id}/members':'Membership',
  'get /api/cases':'CaseList','get /api/cases/{id}':'CaseDetail','post /api/cases/{id}/attachments':'Uploaded',
  'post /api/organizations/{id}/rules':'RuleCreated','get /api/rules':'Rules','post /api/runs/{id}/control':'Control',
  'post /api/cases/{id}/documents':'SavedDocument','get /api/documents/{id}/versions':'DocumentVersions','put /api/documents/{id}':'SavedDocument','post /api/documents/{id}/restore':'SavedDocument',
  'post /api/cases/{id}/confirmations':'Confirmation','post /api/commands':'Receipt','get /api/events':'Events',
  'get /api/cases/{id}/records':'Records','post /api/cases/{id}/field-corrections':'Corrected','get /api/documents/{id}/diff':'Diff','get /api/documents/{id}/patches':'Patches',
  'get /api/skill-templates':'SkillTemplates','get /api/organizations/{id}/skills':'Skills','post /api/skills/{id}/versions/{version}/trials':'Trial'
};
function json(schema:z.ZodType){return z.toJSONSchema(schema,{io:'input',unrepresentable:'any'});}
const paths:Record<string,Record<string,unknown>>={};
for(const endpoint of endpoints){
  const parameters:Record<string,unknown>[]=[...endpoint.path.matchAll(/\{([^}]+)\}/g)].map(match=>({name:match[1],in:'path',required:true,schema:match[1]==='version'?{type:'integer',minimum:1}:{type:'string',format:'uuid'}}));
  parameters.push(...(endpoint.query||[]).map(q=>({name:q.name,in:'query',required:q.required||false,schema:{type:q.type||'string'}})) as any[]);
  if(endpoint.path==='/api/events')parameters.push({name:'Last-Event-ID',in:'header',required:false,schema:{type:'string'}});
  const content:Record<string,unknown>=endpoint.file?{[endpoint.path.includes('attachments')?'application/octet-stream':'text/plain']:{schema:{type:'string'}}}:{'application/json':{schema:{$ref:`#/components/schemas/${responseByOperation[`${endpoint.method} ${endpoint.path}`]||endpoint.response||'Success'}`}}};
  if(endpoint.path==='/api/events')content['text/event-stream']={schema:{type:'string'},example:'id: 2\nevent: field.corrected\ndata: {"seq":2}\n\n'};
  const responses:Record<string,unknown>={[endpoint.status||200]:{description:'成功',content}};
  for(const status of [400,401,403,404,409,413,415,422,429,500])responses[status]={description:status===409?'版本冲突、待审修订、配置缺失或状态不允许':'请求失败',content:{'application/json':{schema:{$ref:'#/components/schemas/Error'}}}};
  const operation:Record<string,unknown>={operationId:endpoint.method+endpoint.path.replace(/[^a-zA-Z0-9]/g,'_'),summary:endpoint.summary,parameters,security:endpoint.public?[]:[{bearerAuth:[]},{cookieAuth:[]}],responses};
  if(endpoint.body)operation.requestBody={required:true,content:{'application/json':{schema:json(endpoint.body)}}};
  if(endpoint.multipart)operation.requestBody={
    required:true,content:{'multipart/form-data':{schema:{
      type:'object',required:['files','expectedRevision'],properties:{
        expectedRevision:{type:'integer',minimum:1},
        purpose:{type:'string',enum:['MATERIAL','REFERENCE'],default:'MATERIAL'},
        files:{type:'array',minItems:1,maxItems:5,items:{type:'string',format:'binary'}}
      }
    }}}
  };
  if(endpoint.path==='/api/openapi.json')operation.responses={200:{description:'OpenAPI 原始 JSON',content:{'application/json':{schema:{type:'object'}}}}};
  (paths[endpoint.path]??={})[endpoint.method]=operation;
}
export const openapi={openapi:'3.1.0',info:{title:'Second Ink backend',version:'0.4.0',description:'业务角色与资源归属由服务端校验。TEAM 支持固定 DAG、暂停续办、材料选择、五分钟微调预览和历史分支。分支共享根模型预算，按依赖复验，不重放发布命令。模型模式仅提交待审修订。'},servers:[{url:'http://127.0.0.1:3080'}],paths,components:{securitySchemes:{bearerAuth:{type:'http',scheme:'bearer'},cookieAuth:{type:'apiKey',in:'cookie',name:'second_ink_session'}},schemas:Object.fromEntries(Object.entries(responseSchemas).map(([name,schema])=>[name,json(schema)]))}};
