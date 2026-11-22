import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { verify,verifyFull,type RunInput } from '../src/verification.js';
import { parseFile } from '../src/parser.js';
import { checkEngineVersion } from '../src/incremental.js';
import { completeWeekly } from './helpers.js';

async function material(text:string,name='weekly.txt'){
  const id=randomUUID(),parsed=await parseFile(Buffer.from(text),name,id);parsed.records.forEach((r,i)=>{r.id=`${id}:${i}`;});return {id,name,purpose:'MATERIAL',sha256:'fixture',parsed};
}
function business(result:ReturnType<typeof verify>){const {decisions,verification,...rest}=result;return rest;}
function cached(input:RunInput):RunInput{return {...structuredClone(input),verificationCache:{sourceRunId:randomUUID(),checkpointId:randomUUID(),decisions:verify(input).decisions!}};}
function same(input:RunInput){const result=verify(input);assert.deepEqual(business(result),verifyFull(input));return result;}
async function weekly():Promise<RunInput>{return {caseId:randomUUID(),title:'周报',scenario:'WEEKLY_REPORT',businessDate:'2026-11-18',data:{},revision:1,verificationEngineVersion:checkEngineVersion,attachments:[await material(completeWeekly)],rules:[]};}

test('incremental checks match independent full traversal after value, source, membership and grouping changes',async()=>{
  let input=await weekly();same(input);
  input=cached(input);assert.equal(same(input).verification!.executed,0);
  input.attachments[0]!.parsed.records[0]!.fields.participants='非法';
  let result=same(input);assert.ok(result.verification!.reused>0&&result.verification!.executed>0);assert.ok(result.issues.some(i=>i.code==='INVALID_PARTICIPANTS'));
  input=cached(input);input.attachments.push(await material(completeWeekly.replace('B203','B204'),'second.txt'));
  result=same(input);assert.ok(result.issues.some(i=>i.code==='SOURCE_CONFLICT'&&i.field==='location'));
  input=cached(input);input.attachments[1]!.parsed.records[0]!.fields.activityName='另一个活动';
  result=same(input);assert.ok(!result.issues.some(i=>i.code==='SOURCE_CONFLICT'));assert.ok(result.verification!.executed>0);
  input=cached(input);input.attachments.splice(0,1);assert.ok(same(input).verification!.removed>0);
  input=cached(input);input.attachments[0]!.parsed.records[0]!.sources.location!.quote='原始引用文本更新';
  result=same(input);assert.ok(result.verification!.executed>0);
  input=cached(input);input.attachments=[];result=same(input);assert.ok(result.issues.some(i=>i.code==='NO_RECORDS'));
});

test('new rules and previously absent fields invalidate negative decisions',async()=>{
  let input=cached(await weekly());
  input.rules=[{id:randomUUID(),title:'新制度',version:1,content:{requiredFields:['组织者'],requirements:'须记录组织者'}}];
  let result=same(input);assert.ok(result.issues.some(i=>i.code==='MISSING_FIELD'&&i.field==='组织者'));assert.ok(!result.issues.some(i=>i.code==='NO_APPLICABLE_RULE'));
  input=cached(input);input.attachments[0]!.parsed.records[0]!.fields['组织者']='张三';result=same(input);assert.ok(!result.issues.some(i=>i.field==='组织者'));
  input=cached(input);input.rules[0]!.version=2;input.rules[0]!.content.requiredFields.push('审批编号');same(input);
});

test('onboarding candidate absence and material presence dependencies match full verification',async()=>{
  let input:RunInput={...await weekly(),scenario:'ONBOARDING',attachments:[await material('员工姓名：张三','员工.txt')],data:{requiredMaterials:['身份证明','学历证明']}};
  same(input);input=cached(input);input.data.position='开发';
  let result=same(input);assert.ok(result.verification!.reused>0);assert.ok(!result.issues.some(i=>i.field==='position'));
  input=cached(input);input.attachments.push(await material('岗位：文员\n入职日期：2026-11-18\n身份证明：已核对','证件.txt'));
  result=same(input);assert.ok(!result.issues.some(i=>i.field==='startDate'||i.field==='身份证明'));assert.ok(result.issues.some(i=>i.field==='学历证明'));
  input=cached(input);input.attachments[1]!.parsed.text+='\n学历证明：已提交';same(input);
  input=cached(input);input.attachments.splice(1,1);same(input);
  input=cached(input);input.data.requiredMaterials=['身份证明','身份证明'];same(input);
});

test('invalid or missing decision metadata falls back to full checks without changing facts',async()=>{
  const input=cached(await weekly());input.verificationCache!.decisions[0]!.outputDigest='corrupt';
  const result=same(input);assert.equal(result.verification!.mode,'FULL');assert.equal(result.verification!.reused,0);assert.equal(result.verification!.fallbackReason,'INVALID_DEPENDENCY_METADATA');
  delete input.verificationCache;assert.equal(same(input).verification!.mode,'FULL');
});
