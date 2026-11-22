import type { Query,Row } from './db.js';
export async function materialIds(q:Query,caseId:string):Promise<Set<string>|null>{
  const selection=await q.get('SELECT ids_json FROM material_selections WHERE case_id=?',[caseId]);
  return selection?new Set<string>(JSON.parse(selection.ids_json)):null;
}
export const materialActive=(file:Row,ids:Set<string>|null)=>file.purpose!=='MATERIAL'||ids===null||ids.has(file.id);
