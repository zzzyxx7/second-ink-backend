import path from 'node:path';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import yauzl from 'yauzl';
import { ApiError, requireThat } from './errors.js';
import type { ParsedFile, ParsedRecord, Source } from './types.js';

export const extensions = new Set(['.txt', '.md', '.csv', '.xlsx', '.docx']);
export const fieldLabels: Record<string, string> = {
  activityName: '活动名称', activityDate: '活动日期', location: '活动地点',
  participants: '参与人数', summary: '活动总结', employeeName: '员工姓名',
  position: '岗位', startDate: '入职日期', identity: '身份证明', education: '学历证明',
  bankAccount: '银行卡信息', healthCertificate: '体检证明'
};
const aliases: Record<string, string[]> = {
  activityName: ['活动名称', '活动名'], activityDate: ['活动日期', '活动时间'],
  location: ['活动地点', '场地', '地点'], participants: ['参与人数', '实到人数', '人数'],
  summary: ['活动总结', '总结', '活动内容'], employeeName: ['员工姓名', '姓名'],
  position: ['岗位', '职位'], startDate: ['入职日期', '入职时间']
};
export function canonicalField(value: string) {
  const name = value.trim();
  requireThat(!['__proto__','constructor','prototype'].includes(name),422,'INVALID_FIELD','字段名称不可使用保留名称');
  return Object.entries(aliases).find(([key, list]) => key === name || list.includes(name))?.[0] || name;
}
function officeGuard(buffer: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(new ApiError(422, 'INVALID_ARCHIVE', 'Office 文件不是有效压缩包'));
      let count = 0, bytes = 0, done = false;
      const fail = () => { if (done) return; done = true; zip.close(); reject(new ApiError(422, 'ARCHIVE_LIMIT', 'Office 文件解压规模或路径不符合限制')); };
      zip.on('entry', entry => {
        count++; bytes += entry.uncompressedSize;
        if (count > 2000 || bytes > 30 * 1024 * 1024 || entry.uncompressedSize > 12 * 1024 * 1024 || /(^\/|(^|\/)\.\.(\/|$)|\\|^[A-Za-z]:)/.test(entry.fileName)) return fail();
        zip.readEntry();
      });
      zip.on('error', () => { if (!done) { done = true; reject(new ApiError(422, 'INVALID_ARCHIVE', 'Office 文件读取失败')); } });
      zip.on('end', () => { if (!done) { done = true; resolve(); } });
      zip.readEntry();
    });
  });
}
function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  // Formula text is never executed. Require an explicit value for business evidence.
  if (cell.type === ExcelJS.ValueType.Formula) throw new ApiError(422, 'FORMULA_NOT_SUPPORTED', '首版不接受公式单元格，请粘贴为值后上传');
  return cell.text.trim().slice(0, 4000);
}
export async function parseFile(buffer: Buffer, filename: string, attachmentId: string): Promise<ParsedFile> {
  const ext = path.extname(filename).toLowerCase();
  requireThat(extensions.has(ext), 415, 'UNSUPPORTED_FILE', '首版支持 TXT、MD、CSV、XLSX、DOCX');
  if (ext === '.xlsx' || ext === '.docx') await officeGuard(buffer);
  const source = (quote: string, locator: Record<string, string | number>): Source => ({ attachmentId, filename, quote, locator });
  const records: ParsedRecord[] = [];
  let text = '';
  const warnings: string[] = [];
  if (ext === '.xlsx' || ext === '.csv') {
    const workbook = new ExcelJS.Workbook();
    if (ext === '.xlsx') await workbook.xlsx.load(buffer as any);
    else {
      const { Readable } = await import('node:stream');
      await workbook.csv.read(Readable.from([buffer]));
    }
    let totalCells = 0;
    for (const sheet of workbook.worksheets) {
      requireThat(sheet.rowCount <= 2000 && sheet.columnCount <= 50, 422, 'SHEET_LIMIT', '单表最多 2000 行、50 列');
      const header = sheet.getRow(1);
      const keys: { column: number; key: string }[] = [];
      header.eachCell((cell, column) => { const key = canonicalField(cellText(cell)); if (key) keys.push({ column, key }); });
      requireThat(new Set(keys.map(x => x.key)).size === keys.length, 422, 'DUPLICATE_HEADERS', '存在重复或含义相同的列名，请明确字段口径');
      sheet.eachRow((row, rowIndex) => {
        if (rowIndex === 1) return;
        const record: ParsedRecord = { fields: {}, sources: {} };
        for (const { column, key } of keys) {
          const cell = row.getCell(column), value = cellText(cell);
          if (!value) continue;
          totalCells++;
          requireThat(totalCells <= 20000, 422, 'SHEET_LIMIT', '有效单元格超过首版限制');
          record.fields[key] = value;
          record.sources[key] = source(value, { sheet: sheet.name, row: rowIndex, column, cell: cell.address });
        }
        if (Object.keys(record.fields).length) records.push(record);
      });
    }
    text = records.map(r => Object.entries(r.fields).map(([k,v]) => `${k}: ${v}`).join(' | ')).join('\n');
  } else {
    if (ext === '.docx') {
      const extracted = await mammoth.extractRawText({ buffer });
      text = extracted.value;
      warnings.push(...extracted.messages.map(x => x.message));
      warnings.push('DOCX 来源定位使用提取文本行号，不代表 Word 页码或原版式位置');
    } else {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
      catch { throw new ApiError(422, 'INVALID_ENCODING', '文本文件请使用 UTF-8 编码'); }
      requireThat(!text.includes('\0'), 422, 'INVALID_TEXT', '文件包含二进制内容');
    }
    requireThat(text.length <= 200000, 422, 'TEXT_LIMIT', '提取文本超过 20 万字符限制');
    const record: ParsedRecord = { fields: {}, sources: {} };
    text.split(/\r?\n/).forEach((line, i) => {
      const match = line.match(/^\s*([^:：]{1,80})[:：]\s*(.+)$/);
      if (!match) return;
      const key = canonicalField(match[1]!), value = match[2]!.trim().slice(0, 4000);
      // A repeated key starts a new record instead of silently overwriting evidence.
      if (Object.hasOwn(record.fields,key)) {
        records.push({ fields: { ...record.fields }, sources: { ...record.sources } });
        record.fields = {}; record.sources = {};
      }
      record.fields[key] = value;
      record.sources[key] = source(line.slice(0, 4200), { line: i + 1 });
    });
    if (Object.keys(record.fields).length) records.push(record);
  }
  requireThat(text.trim(), 422, 'EMPTY_DOCUMENT', '没有可读取内容，请检查模板或文件');
  requireThat(text.length <= 200000, 422, 'TEXT_LIMIT', '提取文本超过 20 万字符限制');
  return { text, records, warnings };
}
