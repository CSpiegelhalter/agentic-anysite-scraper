import { ScrapingEngine } from './core/automation/engine';
import { SchemaParser } from './schemas/parser';
import { ScrapingConfig } from './types';
import { Logger } from './utils/logger';

async function main() {
  const logger = new Logger();
  
  try {
    // Parse command line arguments
    const args = process.argv.slice(2);
    const schemaPath = args[0];
    
    if (!schemaPath) {
      console.error('Usage: npm start <schema-file>');
      process.exit(1);
    }
    
    // Parse schema
    const schema = SchemaParser.parse(schemaPath);
    logger.info('Schema loaded', { name: schema.name });
    
    // Configuration
    const config: ScrapingConfig = {
      browser: {
        headless: process.env.HEADLESS !== 'false',
        slowMo: 100,
        timeout: 30000
      },
      retry: {
        attempts: 3,
        delay: 1000
      },
      output: {
        directory: process.env.OUTPUT_DIR || './output',
        format: 'json'
      }
    };
    
    // Run scraping
    const engine = new ScrapingEngine(schema, config);
    const result = await engine.run();
    
    logger.info('Scraping completed', {
      items: result.data.length,
      pages: result.metadata.pageCount,
      duration: result.metadata.duration
    });
    
  } catch (error) {
    logger.error('Scraping failed', { error });
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export { ScrapingEngine, SchemaParser };