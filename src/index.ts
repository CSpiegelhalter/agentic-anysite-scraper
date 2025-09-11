import { createPage, GraphContext, launchBrowser } from './core/browser/browserManager';
import { PageAnalyzer } from './core/scraping/PageAnalyzer';

async function main() {
  const ctx: GraphContext = { 
    history: [],
    userGoal: 'NA',
    successfulActions: [],
    lastActionSuccess: false,
    successCount: 0,
    milestones: [],
    recognizedMilestones: []
  };
  
  // Store context globally for cleanup
  // globalContext = ctx;
  
  try {
    // Use the extracted runStateMachine function
    ctx.history = [];
  ctx.actionHistory = [];
  ctx.startTime = Date.now();
  ctx.browser = await launchBrowser();
  ctx.page = await createPage(ctx.browser);

  const domSnapshot = await PageAnalyzer.extractSnapshot(ctx.page);
  console.log(domSnapshot);
  } finally {
    // Clear global context
    // globalContext = null;
  }
}

if (require.main === module) {
  main();
}

