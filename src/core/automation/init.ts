import { DOMExtractorRegistry } from "../../types/wepage";
import { FormExtractor, NavigationExtractor } from "../scraping/advanced";
import { MetaDescriptionExtractor, TitleExtractor, URLExtractor } from "../scraping/basic";
import { HeadingsExtractor, ListExtractor, TableExtractor, MainContentExtractor } from "../scraping/content";
import { ButtonExtractor, InputExtractor, LandmarkExtractor, LinkExtractor } from "../scraping/elements";
import { FrameExtractor, ImageExtractor } from "../scraping/media";
    
// Register all extractors
const extractors = [
  // Basic extractors
  new TitleExtractor(),
  new URLExtractor(),
  new MetaDescriptionExtractor(),
  
  // Element extractors - most important for interactive elements
  new ButtonExtractor(),
  new InputExtractor(),
  new LinkExtractor(),
  new LandmarkExtractor(),
  
  // Content extractors
  new HeadingsExtractor(),
  new MainContentExtractor(),
  new TableExtractor(),
  new ListExtractor(),
  
  // Media extractors
  new ImageExtractor(),
  new FrameExtractor(),
  
  // Advanced extractors
  new NavigationExtractor(),
  new FormExtractor()
];

// Register all extractors
extractors.forEach(extractor => {
  DOMExtractorRegistry.register(extractor);
});



export default DOMExtractorRegistry;
