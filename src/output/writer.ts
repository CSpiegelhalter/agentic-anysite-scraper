import fs from 'node:fs';
import path from 'node:path';
import { OutputFormat, OutputTarget } from '../types';


export class OutputWriter {
  private filePath: string;
  private format: OutputFormat;
  private headerWritten = false;

  constructor(target: OutputTarget) {
    const dir = target.directory || 'data';
    const filename = target.filename || `scrape_${Date.now()}`;
    this.format = target.format ?? 'jsonl';
    this.filePath = path.join(dir, `${filename}.${this.format}`);
    fs.mkdirSync(dir, { recursive: true });
  }

  async write(result: unknown): Promise<void> {
    if (this.format === 'json') {
      fs.writeFileSync(this.filePath, JSON.stringify(result, null, 2));
      return;
    }

    if (this.format === 'jsonl') {
      const lines = Array.isArray((result as any).data)
        ? (result as any).data.map((row: any) => JSON.stringify(row)).join('\n') + '\n'
        : JSON.stringify(result) + '\n';
      fs.writeFileSync(this.filePath, lines);
      return;
    }

    if (this.format === 'csv') {
      const arr = Array.isArray((result as any).data) ? (result as any).data : [result];
      if (!arr.length) return;
      const keys = Object.keys(arr[0]);
      const lines = [keys.join(',')].concat(
        arr.map((row: any) => keys.map(k => csvEscape(row[k])).join(','))
      );
      fs.writeFileSync(this.filePath, lines.join('\n'));
      return;
    }
  }

  path() { return this.filePath; }
}

function csvEscape(v: any) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}