import { canonicalField,fieldLabels } from './parser.js';
import { fingerprint } from './fingerprint.js';
import type { RunInput } from './verification.js';
import type { CheckResult,ParsedRecord } from './types.js';

export const checkEngineVersion='checks@1';
type Issue=CheckResult['issues'][number];
export interface Decision {key:string;engineVersion:string;fingerprint:string;dependencies:{ref:string;digest:string}[];issues:Issue[];outputDigest:string}
export interface VerificationStats {mode:'FULL'|'INCREMENTAL'|'REUSED_NODE';reused:number;executed:number;total:number;removed:number;fallbackReason:string|null}
export function incrementalVerify(input:RunInput,useCache=true):CheckResult {
  const provided=useCache?input.verificationCache?.decisions:undefined;
  const valid=Array.isArray(provided)&&provided.every(d=>d&&d.engineVersion===checkEngineVersion&&typeof d.key==='string'
    &&Array.isArray(d.dependencies)&&d.dependencies.every(dep=>dep&&typeof dep.ref==='string'&&typeof dep.digest==='string')
    &&Array.isArray(d.issues)&&d.outputDigest===fingerprint(d.issues)
    &&d.fingerprint===fingerprint({engineVersion:d.engineVersion,key:d.key,dependencies:d.dependencies}));
  const cache=new Map((valid?provided:[])?.map(d=>[d.key,d]));
  const decisions:Decision[]=[],keys=new Set<string>(),issues:Issue[]=[];
  let reused=0,executed=0,cacheLimit=false,cacheBytes=0;
  const check=(key:string,dependencies:Record<string,unknown>,evaluate:()=>Issue[])=>{
    keys.add(key);
    const deps=Object.entries(dependencies).sort(([a],[b])=>a.localeCompare(b)).map(([ref,value])=>({ref,digest:fingerprint(value)}));
    const digest=fingerprint({engineVersion:checkEngineVersion,key,dependencies:deps});
    const prior=cache.get(key);let result:Issue[];
    if(prior?.fingerprint===digest){reused++;result=structuredClone(prior.issues);}else{executed++;result=evaluate();}
    issues.push(...result);
    if(!cacheLimit){
      const decision={key,engineVersion:checkEngineVersion,fingerprint:digest,dependencies:deps,issues:result,outputDigest:fingerprint(result)};
      cacheBytes+=Buffer.byteLength(JSON.stringify(decision));decisions.push(decision);
      if(decisions.length>5000||cacheBytes>1024*1024){decisions.length=0;cacheLimit=true;}
    }
  };
  const requirements=input.rules.map(r=>({id:r.id,version:r.version,content:r.content}));
  const required=[...new Set([...(input.scenario==='WEEKLY_REPORT'?['activityName','activityDate','location','participants','summary']:['employeeName','position','startDate']),...input.rules.flatMap(r=>r.content.requiredFields.map(canonicalField))])];
  const files=input.attachments.filter(a=>a.purpose==='MATERIAL'),parsed=files.flatMap(a=>a.parsed.records);
  const field=(record:ParsedRecord,key:string)=>({value:Object.hasOwn(record.fields,key)?record.fields[key]:null,source:record.sources[key]??null,correction:record.corrections?.[key]??null});
  const recordId=(record:ParsedRecord,index:number)=>record.id||`unidentified:${index}`;
  let records:ParsedRecord[];
  if(input.scenario==='WEEKLY_REPORT'){
    records=parsed;
    check('weekly:records',{'materials:record-membership':parsed.map((r,i)=>recordId(r,i))},()=>parsed.length?[]:[{code:'NO_RECORDS',field:'',message:'未识别到周报记录，请使用首行为字段名的标准表格或键值文本',severity:'ERROR',sources:[]}]);
    parsed.forEach((record,index)=>{
      const key=recordId(record,index),firstSource=Object.values(record.sources).slice(0,1);
      for(const name of required)check(`missing:${key}:${name}`,{[`field:${key}:${name}`]:field(record,name),'rules:required':requirements,'record:display':{index,firstSource}},()=>{
        return Object.hasOwn(record.fields,name)&&record.fields[name]?.trim()?[]:[{code:'MISSING_FIELD',field:name,message:`第 ${index+1} 条记录缺少${fieldLabels[name]||name}`,severity:'ERROR',sources:firstSource}];
      });
      check(`participants:${key}`,{[`field:${key}:participants`]:field(record,'participants'),'record:index':index},()=>{
        const value=record.fields.participants;
        return value&&(!/^\d+$/.test(value)||Number(value)<1||Number(value)>100000)?[{code:'INVALID_PARTICIPANTS',field:'participants',message:`第 ${index+1} 条记录的参与人数应为 1–100000 的整数`,severity:'ERROR',sources:record.sources.participants?[record.sources.participants]:[]}]:[];
      });
      check(`date:${key}`,{[`field:${key}:activityDate`]:field(record,'activityDate'),'record:index':index},()=>{
        const value=record.fields.activityDate,date=new Date(`${value}T00:00:00Z`);
        const good=value&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
        return value&&!good?[{code:'INVALID_DATE',field:'activityDate',message:`第 ${index+1} 条记录的活动日期格式应为 YYYY-MM-DD`,severity:'ERROR',sources:record.sources.activityDate?[record.sources.activityDate]:[]}]:[];
      });
    });
    const groups=new Map<string,ParsedRecord[]>();
    for(const record of parsed){const {activityName,activityDate}=record.fields;if(activityName&&activityDate){const key=JSON.stringify([activityName,activityDate]);groups.set(key,[...(groups.get(key)||[]),record]);}}
    for(const [group,members] of groups)for(const name of required)check(`conflict:${group}:${name}`,{
      [`group-membership:${group}`]:members.map((r,i)=>recordId(r,i)),[`group-field:${group}:${name}`]:members.map(r=>field(r,name)),'rules:required':requirements
    },()=>{
      const values=members.filter(r=>r.fields[name]);
      return new Set(values.map(r=>r.fields[name])).size>1?[{code:'SOURCE_CONFLICT',field:name,message:`${members[0]!.fields.activityName}的${fieldLabels[name]||name}存在不同取值，需要人工核实`,severity:'ERROR',sources:values.flatMap(r=>r.sources[name]?[r.sources[name]!]:[])}]:[];
    });
  }else{
    const fields:Record<string,string>={};for(const [key,value] of Object.entries(input.data))if(typeof value==='string')fields[key]=value;
    records=[{fields,sources:{}},...parsed];
    for(const name of required)check(`onboarding:missing:${name}`,{[`case:${name}`]:Object.hasOwn(fields,name)?fields[name]:null,[`candidates:${name}`]:parsed.map((r,i)=>({id:recordId(r,i),...field(r,name)})),'rules:required':requirements},()=>
      (Object.hasOwn(fields,name)&&fields[name]?.trim())||parsed.some(r=>Object.hasOwn(r.fields,name)&&r.fields[name]?.trim())?[]:[{code:'MISSING_FIELD',field:name,message:`缺少${fieldLabels[name]||name}`,severity:'ERROR',sources:[]}]);
    const list=Array.isArray(input.data.requiredMaterials)?input.data.requiredMaterials as string[]:['身份证明','学历证明'];
    for(const label of list)check(`onboarding:material:${label}`,{[`material-presence:${label}`]:files.map(f=>({id:f.id,name:f.name,textDigest:fingerprint(f.parsed.text)}))},()=>files.some(f=>f.name.includes(label)||f.parsed.text.includes(label))?[]:[{code:'MISSING_MATERIAL',field:label,message:`尚未提交可识别的${label}材料`,severity:'ERROR',sources:[]}]);
    check('onboarding:authenticity',{scenario:input.scenario},()=>[{code:'MANUAL_AUTHENTICITY',field:'',message:'首版只检查材料清单与可读字段，身份真实性及材料有效性需要人工审核',severity:'WARNING',sources:[]}]);
  }
  check('common:rules',{'rules:membership':requirements,'case:businessDate':input.businessDate},()=>input.rules.length?[]:[{code:'NO_APPLICABLE_RULE',field:'',message:'当前业务日期没有已登记的适用制度，使用内置模板检查，请人工核实制度要求',severity:'WARNING',sources:[]}]);
  const errors=issues.filter(i=>i.severity==='ERROR').length;
  const fallbackReason=cacheLimit?'DECISION_CACHE_LIMIT':!useCache?'AUDIT_FULL':input.verificationCache?.fallbackReason||(!provided?'NO_PREVIOUS_DECISIONS':!valid?'INVALID_DEPENDENCY_METADATA':null);
  return {mode:'RULES',ruleRefs:input.rules.map(({id,version,title})=>({id,version,title})),issues,records,
    summary:`规则核验完成：${files.length} 份业务材料，${records.length} 条记录，${errors} 项待处理问题，${issues.length-errors} 项提示。`,decisions,
    verification:{mode:valid&&provided?.length?'INCREMENTAL':'FULL',reused,executed,total:reused+executed,removed:[...cache.keys()].filter(k=>!keys.has(k)).length,fallbackReason}};
}
