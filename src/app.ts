import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { z, ZodError } from 'zod';
import { randomBytes } from 'node:crypto';
import { ApiError, requireThat } from './errors.js';
import { authenticate, hash, id, newSession, now, passwordHash, rejectDuplicate, requestToken, verifyPassword, type Principal } from './auth.js';
import { Store } from './db.js';
import { Service } from './service.js';
import type { Config } from './config.js';
import { blocksSchema, dataSchema, dateSchema, revision, roleSchema, ruleSchema, scenarioSchema, uuid } from './types.js';
import { credentials,createCaseSchema,updateCaseSchema,memberSchema,correctionSchema,patchSchema,skillCreateSchema,skillContentSchema,runRequestSchema,documentCreateSchema,documentSaveSchema,confirmationSchema,commandSchema,organizationSchema,uploadSchema,controlSchema,restoreSchema,trialSchema,decisionSchema } from './contracts.js';
import { skillTemplates } from './skills.js';
import { openapi } from './openapi.js';
import { teamCreateSchema,teamDefinitionSchema,teamControlSchema,template } from './team-contracts.js';
import { materialSelectionSchema,amendmentSchema,branchCommitSchema } from './branch-contracts.js';
import { materialIds,materialActive } from './materials.js';

const param=(req:Request,name:string) => uuid.parse(req.params[name]);
const numeric=z.coerce.number().int().min(0).max(2147483647);
const actor=(res:Response) => res.locals.user as Principal;
const ok=(res:Response,data:unknown,status=200) => res.status(status).json({code:0,message:'success',data});

export async function createApp(config:Config) {
  const db=await new Store(config).open();
  const service=new Service(db,config);
  const app=express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use((req,res,next) => {
    const requestId=randomBytes(8).toString('hex'); res.setHeader('X-Request-ID',requestId);
    res.locals.requestId=requestId;
    const origin=req.get('origin');
    if (origin) {
      const ownOrigin=`${req.protocol}://${req.get('host')}`;
      if (origin!==ownOrigin && origin!==config.frontendOrigin) return next(new ApiError(403,'ORIGIN_FORBIDDEN','请求来源未获允许'));
      res.setHeader('Access-Control-Allow-Origin',origin); res.setHeader('Vary','Origin');
      res.setHeader('Access-Control-Allow-Credentials','true');
      res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, Last-Event-ID');
      res.setHeader('Access-Control-Allow-Methods','GET, POST, PATCH, PUT, OPTIONS');
    }
    if (req.method==='OPTIONS') { res.sendStatus(204); return; }
    next();
  });
  app.use(express.json({limit:'1mb'}));
  app.get('/api/health',async (_req,res) => {
    await db.get('SELECT 1 AS healthy');
    ok(res,{status:'UP',version:'0.4.0',database:db.dialect,executionMode:'RULES',modelConfigured:Boolean(config.model),embeddedWorker:config.embeddedWorker,
      capabilities:['organizations','cases','uploads','rules','verification','field_corrections','document_versions','document_diff','patches','skills','configurable_single_agent','fixed_agent_teams','dag_scheduling','pause_resume','checkpoints','material_selection','amendments','historical_branches','incremental_verification','root_model_budget','confirmed_publication','events'],
      pending:['natural_language_routing','harness','ocr','pdf','docx_export']});
  });
  app.get('/api/openapi.json',(_req,res)=>res.json(openapi));
  const authLimiter=rateLimit({windowMs:15*60000,limit:30,standardHeaders:'draft-8',legacyHeaders:false,
    handler:(_req,res)=>res.status(429).json({code:'RATE_LIMIT',message:'登录或注册请求过于频繁'})});
  function cookie(req:Request,res:Response,token:string,expiresAt:string) {
    res.cookie('second_ink_session',token,{httpOnly:true,sameSite:'strict',secure:req.secure || process.env.NODE_ENV==='production',path:'/',expires:new Date(expiresAt)});
  }
  app.post('/api/auth/register',authLimiter,async(req,res) => {
    const data=credentials.parse(req.body),userId=id(),password=await passwordHash(data.password);
    try { await db.run('INSERT INTO users(id,username,password_hash,created_at) VALUES (?,?,?,?)',[userId,data.username,password,now()]); }
    catch(error) { rejectDuplicate(error); }
    const session=await newSession(db,userId,config.sessionHours); cookie(req,res,session.token,session.expiresAt);
    ok(res,{user:{id:userId,username:data.username},...session},201);
  });
  app.post('/api/auth/login',authLimiter,async(req,res) => {
    const data=credentials.parse(req.body),user=await db.get('SELECT * FROM users WHERE username=?',[data.username]);
    // Match the password cost even when the username is absent.
    const valid=user ? await verifyPassword(data.password,user.password_hash) : (await passwordHash(data.password),false);
    requireThat(valid,401,'INVALID_CREDENTIALS','用户名或密码错误');
    const session=await newSession(db,user!.id,config.sessionHours); cookie(req,res,session.token,session.expiresAt);
    ok(res,{user:{id:user!.id,username:user!.username},...session});
  });
  app.use('/api',async(req,res,next) => { res.locals.user=await authenticate(db,req); next(); });
  app.get('/api/auth/profile',async(_req,res) => ok(res,{...actor(res),organizations:await service.listOrgs(actor(res))}));
  app.post('/api/auth/logout',async(req,res) => {
    await db.run('DELETE FROM sessions WHERE token_hash=?',[hash(requestToken(req)!)]);
    res.clearCookie('second_ink_session',{path:'/'}); ok(res,{loggedOut:true});
  });
  app.get('/api/organizations',async(_req,res)=>ok(res,await service.listOrgs(actor(res))));
  app.post('/api/organizations',async(req,res)=>{
    const {name}=organizationSchema.parse(req.body);
    ok(res,await service.createOrg(actor(res),name),201);
  });
  app.post('/api/organizations/:id/members',async(req,res)=>{
    const input=memberSchema.parse(req.body);
    ok(res,await service.addMember(actor(res),param(req,'id'),input.username,input.role),201);
  });
  app.post('/api/cases',async(req,res)=>{
    const input=createCaseSchema.parse(req.body);
    ok(res,await service.createCase(actor(res),input),201);
  });
  app.get('/api/cases',async(req,res)=>ok(res,await service.listCases(actor(res),uuid.parse(req.query.orgId))));
  app.get('/api/cases/:id',async(req,res)=>{
    const row=await service.case(db,actor(res),param(req,'id'));
    const attachments=await db.all('SELECT * FROM attachments WHERE case_id=? ORDER BY created_at,id',[row.id]);
    const documents=await db.all('SELECT id,title,current_version AS currentVersion,created_at AS createdAt FROM documents WHERE case_id=? ORDER BY created_at,id',[row.id]);
    const runs=await db.all('SELECT id,status,created_at AS createdAt FROM runs WHERE case_id=? ORDER BY created_at DESC LIMIT 50',[row.id]);
    const selection=await materialIds(db,row.id);
    ok(res,{...service.caseView(row),attachments:attachments.map(x=>service.attachmentView(x,materialActive(x,selection))),documents,runs,currentRunId:(await service.branches.head(db,row.id))?.run_id??null});
  });
  app.patch('/api/cases/:id',async(req,res)=>{
    const input=updateCaseSchema.parse(req.body);
    ok(res,await service.updateCase(actor(res),param(req,'id'),input));
  });
  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024,files:5,fields:2,parts:7}});
  const uploadLimiter=rateLimit({windowMs:60000,limit:15,standardHeaders:'draft-8',legacyHeaders:false,
    handler:(_req,res)=>res.status(429).json({code:'RATE_LIMIT',message:'上传请求过于频繁'})});
  app.post('/api/cases/:id/attachments',uploadLimiter,async(req,res,next)=>{
    await service.case(db,actor(res),param(req,'id'),['ADMIN','HANDLER','SUBMITTER']); next();
  },upload.array('files',5),async(req,res)=>{
    const input=uploadSchema.parse(req.body);
    const files=req.files as Express.Multer.File[];
    requireThat(files?.length,422,'FILE_REQUIRED','请上传至少一个文件');
    ok(res,await service.upload(actor(res),param(req,'id'),input.expectedRevision,files,input.purpose),201);
  });
  app.get('/api/attachments/:id/download',async(req,res)=>{
    const file=await service.download(actor(res),param(req,'id'));
    res.attachment(file.name).type('application/octet-stream').send(file.buffer);
  });
  app.post('/api/organizations/:id/rules',async(req,res)=>ok(res,await service.createRule(actor(res),param(req,'id'),ruleSchema.parse(req.body)),201));
  app.get('/api/rules',async(req,res)=>{
    const input=z.object({orgId:uuid,date:dateSchema,q:z.string().max(120).default('')}).parse(req.query);
    ok(res,await service.rules(actor(res),input.orgId,input.date,input.q));
  });
  app.post('/api/agent/requests',async(req,res)=>{
    const input=runRequestSchema.parse(req.body);
    ok(res,await service.requestRun(actor(res),input.caseId,input.expectedRevision,input),202);
  });
  app.get('/api/runs/:id',async(req,res)=>ok(res,await service.runView(actor(res),param(req,'id'))));
  app.post('/api/runs/:id/control',async(req,res)=>{
    const input=z.union([controlSchema,teamControlSchema]).parse(req.body);
    ok(res,'controlId' in input?await service.teams.control(actor(res),param(req,'id'),input):await service.cancel(actor(res),param(req,'id')));
  });
  app.get('/api/runs/:id/checkpoints',async(req,res)=>ok(res,await service.teams.checkpoints(actor(res),param(req,'id'))));
  app.post('/api/cases/:id/material-selection',async(req,res)=>ok(res,await service.selectMaterials(actor(res),param(req,'id'),materialSelectionSchema.parse(req.body))));
  app.post('/api/runs/:id/amendments',async(req,res)=>ok(res,await service.branches.preview(actor(res),param(req,'id'),amendmentSchema.parse(req.body)),201));
  app.post('/api/runs/:id/branches',async(req,res)=>ok(res,await service.branches.commit(actor(res),param(req,'id'),branchCommitSchema.parse(req.body)),202));
  app.get('/api/runs/:id/branches',async(req,res)=>ok(res,await service.branches.list(actor(res),param(req,'id'))));
  app.post('/api/cases/:id/documents',async(req,res)=>{
    const input=documentCreateSchema.parse(req.body);
    ok(res,await service.createDocument(actor(res),param(req,'id'),input.expectedRevision,input.title,input.blocks),201);
  });
  app.get('/api/documents/:id',async(req,res)=>ok(res,await service.getDocument(actor(res),param(req,'id'))));
  app.get('/api/documents/:id/versions',async(req,res)=>{
    const documentId=param(req,'id'); await service.document(db,actor(res),documentId);
    ok(res,await db.all('SELECT version,parent_version AS parentVersion,digest,author_id AS authorId,restored_from AS restoredFrom,created_at AS createdAt FROM document_versions WHERE document_id=? ORDER BY version DESC',[documentId]));
  });
  app.get('/api/documents/:id/versions/:version',async(req,res)=>ok(res,await service.getDocument(actor(res),param(req,'id'),revision.parse(Number(req.params.version)))));
  app.put('/api/documents/:id',async(req,res)=>{
    const input=documentSaveSchema.parse(req.body);
    ok(res,await service.saveDocument(actor(res),param(req,'id'),input.expectedVersion,input.blocks));
  });
  app.post('/api/documents/:id/restore',async(req,res)=>{
    const input=restoreSchema.parse(req.body);
    ok(res,await service.saveDocument(actor(res),param(req,'id'),input.expectedVersion,undefined,input.sourceVersion));
  });
  app.get('/api/documents/:id/export',async(req,res)=>{
    const v=req.query.version===undefined ? undefined : revision.parse(Number(req.query.version));
    const document=await service.getDocument(actor(res),param(req,'id'),v);
    res.attachment(`second-ink-${document.id}-v${document.version}.txt`).type('text/plain; charset=utf-8')
      .send(document.blocks.map(b=>b.text).join('\n\n'));
  });
  app.post('/api/cases/:id/confirmations',async(req,res)=>{
    const input=confirmationSchema.parse(req.body);
    ok(res,await service.confirm(actor(res),param(req,'id'),input.documentId,input.expectedRevision,input.note),201);
  });
  app.post('/api/commands',async(req,res)=>{
    const input=commandSchema.parse(req.body);
    const {action:_,...command}=input;
    ok(res,await service.publish(actor(res),command));
  });
  app.get('/api/events',async(req,res)=>{
    const caseId=uuid.parse(req.query.caseId);
    let after=numeric.parse(req.get('last-event-id') || req.query.after || 0);
    if (req.query.stream!=='true') { ok(res,await service.events(actor(res),caseId,after)); return; }
    await service.case(db,actor(res),caseId);
    res.status(200).set({'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});
    res.flushHeaders(); res.write('retry: 1000\n\n');
    let closed=false;
    res.on('close',()=>{closed=true;});
    try {
      while (!closed) {
        // Recheck the session as well as resource authorization for every batch.
        const user=await authenticate(db,req);
        const events=await service.events(user,caseId,after);
        for (const event of events) {
          if (closed) break;
          res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); after=event.seq;
        }
        if (!events.length) res.write(': heartbeat\n\n');
        await new Promise<void>(resolve=>{
          const onClose=()=>{clearTimeout(timer);resolve();};
          const timer=setTimeout(()=>{res.off('close',onClose);resolve();},1000);
          res.once('close',onClose);
        });
      }
    } catch { if (!closed) res.end(); }
  });
  app.get('/api/cases/:id/records',async(req,res)=>ok(res,await service.records(actor(res),param(req,'id'))));
  app.post('/api/cases/:id/field-corrections',async(req,res)=>ok(res,await service.correct(actor(res),param(req,'id'),correctionSchema.parse(req.body)),201));
  app.get('/api/documents/:id/diff',async(req,res)=>{
    const query=z.object({fromVersion:z.coerce.number().int().min(1),toVersion:z.coerce.number().int().min(1)}).parse(req.query);
    ok(res,await service.patches.diff(actor(res),param(req,'id'),query.fromVersion,query.toVersion));
  });
  app.get('/api/documents/:id/patches',async(req,res)=>ok(res,await service.patches.list(actor(res),param(req,'id'))));
  app.post('/api/documents/:id/patches',async(req,res)=>ok(res,await service.patches.create(actor(res),param(req,'id'),patchSchema.parse(req.body)),201));
  for(const action of ['accept','reject'] as const) app.post(`/api/patches/:id/${action}`,async(req,res)=>{
    const input=decisionSchema.parse(req.body);ok(res,await service.patches.decide(actor(res),param(req,'id'),action,input.expectedVersion));
  });
  app.get('/api/skill-templates',(_req,res)=>ok(res,skillTemplates));
  app.get('/api/organizations/:id/skills',async(req,res)=>ok(res,await service.skills.list(actor(res),param(req,'id'))));
  app.post('/api/organizations/:id/skills',async(req,res)=>{
    const {name,...content}=skillCreateSchema.parse(req.body);ok(res,await service.skills.create(actor(res),param(req,'id'),name,content),201);
  });
  app.post('/api/skills/:id/versions',async(req,res)=>ok(res,await service.skills.newVersion(actor(res),param(req,'id'),skillContentSchema.parse(req.body)),201));
  app.get('/api/skills/:id/versions/:version',async(req,res)=>{
    const loaded=await service.skills.get(db,actor(res),param(req,'id'),revision.parse(Number(req.params.version)));
    ok(res,service.skills.view(loaded.version));
  });
  app.post('/api/skills/:id/versions/:version/trials',async(req,res)=>{
    const input=trialSchema.parse(req.body);ok(res,await service.skills.trial(actor(res),param(req,'id'),revision.parse(Number(req.params.version)),input.caseId),201);
  });
  for(const [action,status] of [['publish','PUBLISHED'],['disable','DISABLED']] as const) app.post(`/api/skills/:id/versions/:version/${action}`,async(req,res)=>{
    z.object({}).strict().parse(req.body??{});
    ok(res,await service.skills.changeStatus(actor(res),param(req,'id'),revision.parse(Number(req.params.version)),status));
  });
  app.get('/api/team-templates',(_req,res)=>ok(res,[template('WEEKLY_REPORT'),template('ONBOARDING')]));
  app.get('/api/organizations/:id/teams',async(req,res)=>ok(res,await service.teams.list(actor(res),param(req,'id'))));
  app.post('/api/organizations/:id/teams',async(req,res)=>{
    const {name,...definition}=teamCreateSchema.parse(req.body);ok(res,await service.teams.create(actor(res),param(req,'id'),name,definition),201);
  });
  app.post('/api/teams/:id/versions',async(req,res)=>ok(res,await service.teams.newVersion(actor(res),param(req,'id'),teamDefinitionSchema.parse(req.body)),201));
  app.get('/api/teams/:id/versions/:version',async(req,res)=>{
    const loaded=await service.teams.get(db,actor(res),param(req,'id'),revision.parse(Number(req.params.version)));ok(res,service.teams.view(loaded.version));
  });
  for(const [action,status] of [['publish','PUBLISHED'],['disable','DISABLED']] as const)app.post(`/api/teams/:id/versions/:version/${action}`,async(req,res)=>{
    z.object({}).strict().parse(req.body??{});ok(res,await service.teams.status(actor(res),param(req,'id'),revision.parse(Number(req.params.version)),status));
  });
  app.use((_req,_res,next)=>next(new ApiError(404,'NOT_FOUND','接口不存在')));
  app.use((error:unknown,_req:Request,res:Response,_next:NextFunction)=>{
    if (res.headersSent) {res.end();return;}
    if (error instanceof ZodError) {res.status(422).json({code:'VALIDATION_ERROR',message:'请求参数无效',details:error.issues,requestId:res.locals.requestId});return;}
    if (error instanceof multer.MulterError) {res.status(413).json({code:error.code,message:'上传超出限制：每次最多 5 个文件，每个 5 MB'});return;}
    if (error instanceof ApiError) {res.status(error.status).json({code:error.code,message:error.message,details:error.details,requestId:res.locals.requestId});return;}
    if (error instanceof SyntaxError && 'body' in error) {res.status(400).json({code:'INVALID_JSON',message:'JSON 格式错误'});return;}
    if (typeof error==='object' && error && 'status' in error && error.status===413) {res.status(413).json({code:'BODY_TOO_LARGE',message:'请求体超过限制'});return;}
    console.error('Request failed:',res.locals.requestId,error instanceof Error ? error.message : error);
    res.status(500).json({code:'INTERNAL_ERROR',message:'服务暂时无法处理请求',requestId:res.locals.requestId});
  });
  return {app,db,service};
}
