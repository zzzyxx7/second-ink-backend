import type { Service } from './service.js';
import type { Query, Row } from './db.js';
import type { Principal } from './auth.js';
import { id,hash,now } from './auth.js';
import { requireThat } from './errors.js';
import type { Block } from './types.js';
import type { PatchInput } from './contracts.js';

export class Patches {
  constructor(private service:Service){}
  view(row:Row){return {id:row.id,documentId:row.document_id,baseVersion:row.base_version,replacements:JSON.parse(row.replacements_json),reason:row.reason,evidenceRefs:JSON.parse(row.evidence_refs_json),sourceRunId:row.source_run_id,status:row.status,acceptedVersion:row.accepted_version,actorId:row.actor_id,createdAt:row.created_at,decidedAt:row.decided_at};}
  async assertNoPending(q:Query,documentId:string){
    requireThat(!await q.get("SELECT id FROM patches WHERE document_id=? AND status='PENDING'",[documentId]),409,'PATCH_REVIEW_REQUIRED','请先接受或拒绝文档中待审修订');
  }
  validate(blocks:Block[],input:PatchInput,allowedRefs:Set<string>){
    const blockIds=new Set(blocks.map(b=>b.id));
    requireThat(input.replacements.every(x=>blockIds.has(x.blockId)),422,'INVALID_BLOCK','修订目标区块不存在或未授权');
    requireThat(input.evidenceRefs.every(ref=>allowedRefs.has(ref)),422,'INVALID_EVIDENCE','修订引用的证据不存在或不可访问');
  }
  async insert(q:Query,row:Row,document:Row,userId:string,input:PatchInput,sourceRunId:string|null=null){
    requireThat(document.current_version===input.baseVersion,409,'VERSION_CONFLICT','修订基准版本已过期');
    const version=(await q.get('SELECT content_json FROM document_versions WHERE document_id=? AND version=?',[document.id,input.baseVersion]))!;
    const refs=await this.service.evidenceRefs(q,row.id);
    this.validate(JSON.parse(version.content_json),input,refs);
    const patchId=id();
    await q.run(`INSERT INTO patches(id,document_id,base_version,replacements_json,reason,evidence_refs_json,source_run_id,actor_id,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,'PENDING',?)`,[patchId,document.id,input.baseVersion,JSON.stringify(input.replacements),input.reason,JSON.stringify(input.evidenceRefs),sourceRunId,userId,now()]);
    // Pending proposals affect whether the case can be published, so invalidate old confirmations.
    await this.service.touch(q,row.id);
    await this.service.event(q,row,'patch.created',userId,{patchId,documentId:document.id,sourceRunId});
    return this.view((await q.get('SELECT * FROM patches WHERE id=?',[patchId]))!);
  }
  async create(user:Principal,documentId:string,input:PatchInput){
    return this.service.db.transaction(async q=>{
      const {row,document}=await this.service.document(q,user,documentId,['ADMIN','HANDLER'],true);
      this.service.ensureOpen(row);
      return this.insert(q,row,document,user.id,input);
    });
  }
  async list(user:Principal,documentId:string){
    await this.service.document(this.service.db,user,documentId);
    return (await this.service.db.all('SELECT * FROM patches WHERE document_id=? ORDER BY created_at,id',[documentId])).map(row=>this.view(row));
  }
  async decide(user:Principal,patchId:string,decision:'accept'|'reject',expectedVersion:number){
    const db=this.service.db,lookup=await db.get('SELECT document_id FROM patches WHERE id=?',[patchId]);
    requireThat(lookup,404,'NOT_FOUND','修订提案不存在');
    return db.transaction(async q=>{
      const {row,document}=await this.service.document(q,user,lookup.document_id,['ADMIN','HANDLER'],true);
      const patch=(await q.get('SELECT * FROM patches WHERE id=?'+db.lock,[patchId]))!;
      requireThat(patch.status!=='SUPERSEDED',409,'PATCH_SUPERSEDED','提案所属分支已被替代，请在当前分支重新生成');
      const status=decision==='accept'?'ACCEPTED':'REJECTED';
      if(patch.status===status)return this.view(patch);
      requireThat(patch.status==='PENDING',409,'PATCH_DECIDED','提案已经处理');
      this.service.ensureOpen(row);
      requireThat(document.current_version===expectedVersion,409,'VERSION_CONFLICT','文档已变化，请重新读取');
      let acceptedVersion:number|null=null;
      if(decision==='accept'){
        requireThat(patch.base_version===document.current_version,409,'VERSION_CONFLICT','提案基准已过期，请拒绝或重新生成');
        const version=(await q.get('SELECT * FROM document_versions WHERE document_id=? AND version=?',[document.id,document.current_version]))!;
        const replacements=new Map<string,string>(JSON.parse(patch.replacements_json).map((r:any)=>[r.blockId,r.text]));
        const blocks:Block[]=JSON.parse(version.content_json);
        const content=JSON.stringify(blocks.map(b=>({...b,text:replacements.get(b.id)??b.text})));
        acceptedVersion=document.current_version+1;
        await q.run('INSERT INTO document_versions(document_id,version,parent_version,content_json,digest,author_id,source_run_id,restored_from,created_at) VALUES (?,?,?,?,?,?,?,NULL,?)',
          [document.id,acceptedVersion,document.current_version,content,hash(content),user.id,patch.source_run_id||version.source_run_id,now()]);
        await q.run('UPDATE documents SET current_version=? WHERE id=?',[acceptedVersion,document.id]);
      }
      await q.run('UPDATE patches SET status=?,accepted_version=?,decided_at=? WHERE id=?',[status,acceptedVersion,now(),patchId]);
      await this.service.touch(q,row.id);
      await this.service.event(q,row,`patch.${decision==='accept'?'accepted':'rejected'}`,user.id,{patchId,documentId:document.id,version:acceptedVersion});
      return this.view((await q.get('SELECT * FROM patches WHERE id=?',[patchId]))!);
    });
  }
  async diff(user:Principal,documentId:string,fromVersion:number,toVersion:number){
    const from=await this.service.getDocument(user,documentId,fromVersion),to=await this.service.getDocument(user,documentId,toVersion);
    const before=new Map(from.blocks.map(b=>[b.id,b])),after=new Map(to.blocks.map(b=>[b.id,b]));
    return {documentId,fromVersion,toVersion,changes:[...new Set([...before.keys(),...after.keys()])].flatMap(blockId=>{
      const a=before.get(blockId),b=after.get(blockId);
      if(JSON.stringify(a)===JSON.stringify(b))return [];
      return [{blockId,change:!a?'ADDED':!b?'DELETED':'MODIFIED',before:a??null,after:b??null}];
    })};
  }
}
