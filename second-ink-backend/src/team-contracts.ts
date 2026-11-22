import { z } from 'zod';
import { revision, scenarioSchema, uuid } from './types.js';

export const teamRoles=['POLICY','MATERIALS','VERIFY','REPORT'] as const;
export const teamNodeSchema=z.object({
  id:z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/), role:z.enum(teamRoles),
  agentVersion:z.enum(['policy-agent@1','materials-agent@1','verification-agent@1','report-agent@1']).optional(),
  dependsOn:z.array(z.string().max(40)).max(4), required:z.boolean().default(true),
  timeoutMs:z.number().int().min(100).max(120000).default(30000)
}).strict();
export const teamDefinitionSchema=z.object({
  scenario:scenarioSchema,nodes:z.array(teamNodeSchema).length(4),
  concurrency:z.number().int().min(1).max(2).default(2),
  maxAttempts:z.number().int().min(1).max(2).default(2),
  maxModelCalls:z.number().int().min(1).max(8).default(4)
}).strict().superRefine((definition,ctx)=>{
  const fail=(message:string)=>ctx.addIssue({code:'custom',message});
  const nodes=new Map(definition.nodes.map(n=>[n.id,n]));
  if(nodes.size!==4||new Set(definition.nodes.map(n=>n.role)).size!==4){fail('四个角色及节点 ID 必须各不重复');return;}
  const visit=(nodeId:string,path:Set<string>):boolean=>{
    if(path.has(nodeId)){fail('节点依赖不能形成环');return false;}
    const node=nodes.get(nodeId);if(!node){fail('依赖节点不存在');return false;}
    return node.dependsOn.every(dep=>visit(dep,new Set([...path,nodeId])));
  };
  if(!definition.nodes.every(n=>visit(n.id,new Set())))return;
  const byRole=(role:string)=>definition.nodes.find(n=>n.role===role)!;
  const expected={POLICY:'policy-agent@1',MATERIALS:'materials-agent@1',VERIFY:'verification-agent@1',REPORT:'report-agent@1'};
  if(definition.nodes.some(n=>n.agentVersion&&n.agentVersion!==expected[n.role]))fail('Agent 版本必须与角色匹配');
  if(byRole('POLICY').dependsOn.length||byRole('MATERIALS').dependsOn.length)fail('制度和材料角色必须是独立读取节点');
  const verify=byRole('VERIFY'),report=byRole('REPORT');
  if(![byRole('POLICY').id,byRole('MATERIALS').id].every(id=>verify.dependsOn.includes(id)))fail('核验必须依赖制度和材料结果');
  if(!report.dependsOn.includes(verify.id))fail('报告必须依赖核验');
  if(!byRole('MATERIALS').required||!verify.required||!report.required)fail('材料、核验和报告必须为必需节点');
});
export const teamCreateSchema=teamDefinitionSchema.safeExtend({name:z.string().trim().min(1).max(120)});
export type TeamDefinition=z.infer<typeof teamDefinitionSchema>;
export type TeamNode=TeamDefinition['nodes'][number];
export const reportOptionsSchema=z.object({documentId:uuid,expectedDocumentVersion:revision,blockIds:z.array(uuid).min(1).max(100),goal:z.string().trim().min(1).max(2000),skillId:uuid,skillVersion:revision}).strict();
export const teamRequestSchema=z.object({caseId:uuid,expectedRevision:revision,mode:z.literal('TEAM'),teamId:uuid,teamVersion:revision,report:reportOptionsSchema.optional()}).strict();
export const teamControlSchema=z.object({
  action:z.enum(['pause','resume','cancel','retry']),scope:z.enum(['team','branch']).default('team'),nodeId:z.string().max(40).optional(),
  controlId:uuid,expectedControlRevision:revision,checkpointId:uuid.optional()
}).strict().superRefine((input,ctx)=>{
  if((input.scope==='branch'||input.action==='retry')&&!input.nodeId)ctx.addIssue({code:'custom',path:['nodeId'],message:'需要目标节点'});
  if(input.action==='cancel'&&input.scope!=='team')ctx.addIssue({code:'custom',message:'取消作用于整个团队'});
});
export type TeamControl=z.infer<typeof teamControlSchema>;
export const agentVersions={POLICY:'policy-agent@1',MATERIALS:'materials-agent@1',VERIFY:'verification-agent@1',REPORT:'report-agent@1'} as const;
export function template(scenario:'WEEKLY_REPORT'|'ONBOARDING'){
  return {name:scenario==='WEEKLY_REPORT'?'周报协作团队':'入职协作团队',...teamDefinitionSchema.parse({scenario,nodes:[
    {id:'policy',role:'POLICY',dependsOn:[]},{id:'materials',role:'MATERIALS',dependsOn:[]},
    {id:'verify',role:'VERIFY',dependsOn:['policy','materials']},{id:'report',role:'REPORT',dependsOn:['verify']}
  ]})};
}
export function descendants(definition:TeamDefinition,nodeId:string){
  const ids=new Set([nodeId]);let changed=true;
  while(changed){changed=false;for(const node of definition.nodes)if(node.dependsOn.some(dep=>ids.has(dep))&&!ids.has(node.id)){ids.add(node.id);changed=true;}}
  return [...ids];
}
