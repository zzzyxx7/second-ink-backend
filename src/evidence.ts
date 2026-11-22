import { hash } from './auth.js';
import type { Query, Row } from './db.js';
import type { ParsedFile } from './types.js';

export async function correctionRows(q:Query,caseId:string) {
  return q.all('SELECT * FROM field_corrections WHERE case_id=? ORDER BY case_revision,id',[caseId]);
}
export function correctionsDigest(rows:Row[]) {
  return hash(JSON.stringify(rows.map(r=>({id:r.id,recordId:r.record_id,field:r.field,value:r.value}))));
}
export function correctedFile(file:Row,rows:Row[]):ParsedFile {
  const parsed:ParsedFile=JSON.parse(file.parsed_json);
  parsed.records=parsed.records.map((record,index)=>({...record,id:`${file.id}:${index}`,fields:{...record.fields},sources:{...record.sources},corrections:{}}));
  for(const correction of rows.filter(r=>r.attachment_id===file.id)) {
    const record=parsed.records.find(r=>r.id===correction.record_id);
    if(!record)continue;
    record.fields[correction.field]=correction.value;
    record.corrections![correction.field]={id:correction.id,originalValue:correction.original_value,value:correction.value,reason:correction.reason,actorId:correction.actor_id,createdAt:correction.created_at};
  }
  return parsed;
}
