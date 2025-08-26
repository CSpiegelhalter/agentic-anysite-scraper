import { readFileSync } from 'fs';
import { ScrapingSchema } from '../types';
import { SchemaValidator } from './validator';

export class SchemaParser {
  static parse(filePath: string): ScrapingSchema {
    try {
      const content = readFileSync(filePath, 'utf-8');
      let schema: any;
      
      if (filePath.endsWith('.json')) {
        schema = JSON.parse(content);
      } else if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
        // You'd need to add yaml package: npm install yaml
        const { parse } = require('yaml');
        schema = parse(content);
      } else {
        throw new Error('Unsupported file format. Use .json or .yaml');
      }
      
      // Validate schema
      SchemaValidator.validate(schema);
      
      return schema;
    } catch (error) {
      throw new Error(`Failed to parse schema file: ${error}`);
    }
  }

  static parseFromString(content: string, format: 'json' | 'yaml'): ScrapingSchema {
    try {
      let schema: any;
      
      if (format === 'json') {
        schema = JSON.parse(content);
      } else if (format === 'yaml') {
        const { parse } = require('yaml');
        schema = parse(content);
      } else {
        throw new Error('Unsupported format. Use "json" or "yaml"');
      }
      
      SchemaValidator.validate(schema);
      return schema;
    } catch (error) {
      throw new Error(`Failed to parse schema content: ${error}`);
    }
  }
}