import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { Runner } from '../src/runner.js';
import type { Config } from '../src/config.js';

export async function setup(overrides:Partial<Config>={}) {
  const dataDir=await mkdtemp(path.join(tmpdir(),'second-ink-test-'));
  const context=await createApp({dataDir,databaseUrl:process.env.TEST_DATABASE_URL || '',host:'127.0.0.1',port:3080,
    embeddedWorker:false,frontendOrigin:'',sessionHours:1,...overrides});
  const server=context.app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request(method:string,url:string,body?:unknown,token?:string) {
    const headers:Record<string,string>={};
    if(token)headers.Authorization=`Bearer ${token}`;
    if(body!==undefined)headers['Content-Type']='application/json';
    const response=await fetch(base+url,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json() as any};
  }
  async function register(username:string) {
    const response=await request('POST','/api/auth/register',{username,password:'test-password-1234'});
    if(response.status!==201)throw new Error(JSON.stringify(response));
    return response.body.data as {token:string;user:{id:string;username:string}};
  }
  async function fixture(scenario='WEEKLY_REPORT') {
    const account=await register(`user_${Math.random().toString(36).slice(2,12)}`);
    const organization=await request('POST','/api/organizations',{name:'测试组织'},account.token);
    const org=organization.body.data;
    const created=await request('POST','/api/cases',{orgId:org.id,title:'周报测试',scenario,businessDate:'2026-11-18',data:{}},account.token);
    if(created.status!==201)throw new Error(JSON.stringify(created));
    return {...account,org,case:created.body.data};
  }
  async function upload(token:string,caseId:string,expectedRevision:number,text:string,name='weekly.txt') {
    const form=new FormData();form.append('expectedRevision',String(expectedRevision));
    form.append('files',new Blob([text]),name);
    const response=await fetch(`${base}/api/cases/${caseId}/attachments`,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:form});
    return {status:response.status,body:await response.json() as any};
  }
  async function close() {
    server.closeAllConnections();
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    await context.db.close();await rm(dataDir,{recursive:true,force:true});
  }
  return {...context,base,server,request,register,fixture,upload,close,runner:new Runner(context.service),dataDir};
}
export const completeWeekly='活动名称：迎新活动\n活动日期：2026-11-18\n活动地点：B203\n参与人数：25\n活动总结：完成新成员介绍';
