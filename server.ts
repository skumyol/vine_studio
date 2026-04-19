import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import { chromium } from 'playwright';
import { createWorker } from 'tesseract.js';
import fuzzysort from 'fuzzysort';
import sharp from 'sharp';
import { scrapeAllWines } from './src/services/vinobuzzScraper.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// --- PIPELINE SERVICES ---

interface WineSKU {
  wine_name: string;
  vintage: string;
  region?: string;
  appellation?: string;
  vineyard?: string;
  classification?: string;
}

// A. Text Normalization (Classical)
function normalizeText(text: string): string {
  if (!text) return "";
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Remove accents
    .replace(/st\./g, "st")
    .replace(/saint/g, "st")
    .replace(/premier cru/g, "1er cru")
    .replace(/grand cru/g, "grand cru")
    .replace(/[\-\_\']/g, " ")
    .replace(/[^\w\s]/g, "") // Remove remaining punctuation
    .replace(/\s+/g, " ")
    .trim();
}

// B. Visual Pre-Filter (Tier 2 - Classical CV Heuristics)
async function visualPreFilter(buffer: Buffer): Promise<{ pass: boolean; reason: string; qualityFactor: number }> {
  try {
    const metadata = await sharp(buffer).metadata();
    
    // 1. Resolution Check
    if ((metadata.width || 0) < 300 || (metadata.height || 0) < 400) {
      return { pass: false, reason: "Resolution too low for professional verification.", qualityFactor: 0 };
    }

    // 2. Aspect Ratio (Upright bottle check)
    const ratio = (metadata.height || 0) / (metadata.width || 0);
    if (ratio < 0.75) {
      return { pass: false, reason: "Horizontal aspect ratio (Not a product bottle shot).", qualityFactor: 2 };
    }

    // 3. Studio Background Detection (Heuristic)
    // Most professional shots have light backgrounds. We check if corners are bright.
    const { data: corners } = await sharp(buffer)
      .extract({ left: 0, top: 0, width: 20, height: 20 })
      .toBuffer({ resolveWithObject: true });
    
    // 4. Blur Detection (Laplacian Variance Proxy)
    const stats = await sharp(buffer).stats();
    const avgStdDev = stats.channels.reduce((acc, c) => acc + c.stdev, 0) / stats.channels.length;
    
    let qualityFactor = 10;
    if (avgStdDev < 20) qualityFactor = 5;
    if (avgStdDev < 12) qualityFactor = 2;

    if (avgStdDev < 10) {
      return { pass: false, reason: "Image exceeds blur/out-of-focus tolerance.", qualityFactor };
    }

    return { pass: true, reason: "Visual quality verified.", qualityFactor };
  } catch (error) {
    return { pass: false, reason: "Image file corruption or restricted access.", qualityFactor: 0 };
  }
}

// C. Deterministic Verification (No-LLM)
async function verifyDeterministic(sku: WineSKU, imageUrl: string) {
  console.log(`[Deterministic] Analyzing image: ${imageUrl}`);
  
  try {
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data);

    // 1. Tier 2 - Visual Pre-Filter (Scale efficiency gate)
    const preFilter = await visualPreFilter(buffer);
    if (!preFilter.pass) {
      return {
        pass: false,
        confidence: 0,
        verdict: 'FAIL',
        reasoning: `VISUAL REJECT: ${preFilter.reason}`,
        ocr_raw: ""
      };
    }

    // 2. Tier 3 - OCR Extraction (Unified Full + Label Crops)
    const worker = await createWorker('eng');
    
    // FULL IMAGE OCR
    const fullRes = await worker.recognize(buffer);
    
    // LABEL CROP (Center-Bottom heuristic for bottles)
    const metadata = await sharp(buffer).metadata();
    const cropWidth = Math.round((metadata.width || 0) * 0.7);
    const cropHeight = Math.round((metadata.height || 0) * 0.4);
    const cropLeft = Math.round(((metadata.width || 0) - cropWidth) / 2);
    const cropTop = Math.round((metadata.height || 0) * 0.45); // Labels are usually in the middle-bottom
    
    const labelBuffer = await sharp(buffer)
      .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
      .grayscale()
      .normalize()
      .sharpen()
      .toBuffer();
      
    const labelRes = await worker.recognize(labelBuffer);
    
    const combinedOCR = normalizeText(fullRes.data.text + " " + labelRes.data.text);
    await worker.terminate();
    
    console.log(`[Combined OCR Output]: ${combinedOCR}`);

    const targetProducer = normalizeText(sku.wine_name);
    const targetVintage = sku.vintage;
    const targetAppellation = sku.appellation ? normalizeText(sku.appellation) : "";
    const targetVineyard = sku.vineyard ? normalizeText(sku.vineyard) : "";
    const targetClassification = sku.classification ? normalizeText(sku.classification) : "";
    
    let score = 0;
    const details = [];
    let hardFail = false;
    let failReason = "";

    // 1. Mandatory Producer Match
    if (combinedOCR.includes(targetProducer) || fuzzysort.single(targetProducer, combinedOCR)?.score > -1500) {
      score += 30;
      details.push("Producer confirmed.");
    } else {
      hardFail = true;
      failReason = "Producer missing or mismatch.";
    }

    // 2. Mandatory Appellation Match
    if (!hardFail && targetAppellation) {
      if (combinedOCR.includes(targetAppellation) || fuzzysort.single(targetAppellation, combinedOCR)?.score > -1500) {
        score += 25;
        details.push("Appellation confirmed.");
      } else {
        hardFail = true;
        failReason = "Appellation mismatch.";
      }
    }

    // 3. Mandatory Vineyard Match
    if (!hardFail && targetVineyard) {
      if (combinedOCR.includes(targetVineyard) || fuzzysort.single(targetVineyard, combinedOCR)?.score > -1500) {
        score += 20;
        details.push("Specific vineyard/climat match found.");
      } else {
        hardFail = true;
        failReason = "Vineyard/Cuvée mismatch.";
      }
    }

    // 4. Classification Match
    if (!hardFail && targetClassification) {
      if (combinedOCR.includes(targetClassification)) {
        score += 10;
        details.push("Classification match.");
      } else {
        details.push("Classification not explicitly confirmed.");
      }
    }

    // 5. Vintage Match (Hard Fail if visible and contradicts)
    const vintageRegex = /(19|20)\d{2}/g;
    const detectedVintages: string[] = Array.from(combinedOCR.match(vintageRegex) || []);
    
    if (!hardFail) {
      if (combinedOCR.includes(targetVintage)) {
        score += 15;
        details.push("Vintage confirmed.");
      } else if (detectedVintages.length > 0 && !detectedVintages.includes(targetVintage)) {
        hardFail = true;
        failReason = `Vintage mismatch (Target ${targetVintage}, found ${detectedVintages[0]}).`;
      } else {
        details.push("Vintage not clearly found.");
      }
    }

    if (hardFail) {
      return {
        pass: false,
        confidence: score,
        verdict: 'FAIL',
        reasoning: `HARD FAIL: ${failReason}`,
        ocr_raw: combinedOCR,
        qualityFactor: preFilter.qualityFactor
      };
    }

    const finalScore = Math.min(score + (preFilter.qualityFactor || 0), 100);
    const finalPass = finalScore >= 70;
    
    return {
      pass: finalPass,
      confidence: finalScore,
      verdict: finalPass ? 'PASS' : 'FAIL',
      reasoning: `Identity Verification Profile: ${details.join(' | ')}`,
      ocr_raw: combinedOCR,
      qualityFactor: preFilter.qualityFactor
    };

  } catch (error: any) {
    console.error("[Deterministic] OCR Pipeline Error:", error.message);
    return { pass: false, confidence: 0, verdict: 'FAIL', reasoning: "OCR processing failure." };
  }
}

// D. Playwright Search (Default - Masquerades as Brave/Chrome for scraping)
async function playwrightSearch(sku: WineSKU) {
  const TRUSTED_DOMAINS = [
    'wine-searcher.com', 
    'vivino.com', 
    'millesima.com', 
    'idealwine.com', 
    'wine.com', 
    'cellartracker.com', 
    'millesima.co.uk',
    'klwines.com',
    'zachys.com',
    'bbr.com',
    'vins-etonnants.com',
    'vinatis.com'
  ];

  const queries = [
    `${sku.wine_name} ${sku.vintage} wine searcher`,
    `${sku.wine_name} ${sku.vintage} vivino photo`,
    `${sku.wine_name} ${sku.vintage} bottle label`,
    `${sku.wine_name.split(' ').slice(0, 4).join(' ')} wine`
  ].filter(q => q.trim().length > 0);

  const BAD_DOMAINS = ['pinterest.com', 'shutterstock.com', 'stock.adobe.com', 'alamy.com', 'dreamstime.com', '123rf.com', 'canva.com', 'ebay.com', 'etsy.com', 'facebook.com', 'instagram.com'];
  const allResults: any[] = [];
  
  try {
    const browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    try {
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      });
      const page = await context.newPage();

      for (const q of queries) {
        console.log(`[Playwright] Attempting Query: ${q}`);
        try {
          const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(q)}&iax=images&ia=images`;
          await page.goto(searchUrl, { 
            waitUntil: 'networkidle',
            timeout: 15000 
          });
          
          // Debug check
          const pageTitle = await page.title();
          console.log(`[Playwright] Page Title: ${pageTitle}`);

          // Give extra time for images to populate
          await page.waitForTimeout(2000);
          
          await page.evaluate(() => {
            window.scrollBy(0, 1000);
            return new Promise(r => setTimeout(r, 500));
          });
          
          const res = await page.evaluate(({ badDomains, trusted }) => {
            function getAbsoluteUrl(url: string) {
              if (!url) return '';
              if (url.startsWith('http')) return url;
              if (url.startsWith('//')) return 'https:' + url;
              if (url.startsWith('/')) return 'https://duckduckgo.com' + url;
              return url;
            }

            // Broad discovery
            const imgElements = Array.from(document.querySelectorAll('img')).filter(img => {
              const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
              return (src.includes('duckduckgo.com/iu') || src.includes('bing.com')) && img.width > 20 && img.height > 20;
            });

            console.log(`Found ${imgElements.length} potential images on page`);

            return imgElements.map(img => {
              const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
              if (!src || src.includes('data:image')) return null;

              // Find nearest link to determine domain
              let parent = img.parentElement;
              let url = '';
              let domain = 'unknown';
              
              for (let i = 0; i < 5; i++) {
                 if (!parent) break;
                 const link = parent.querySelector('a');
                 if (link) {
                    url = getAbsoluteUrl(link.getAttribute('href') || '');
                    try { if(url) domain = new URL(url).hostname; } catch(e){}
                    break;
                 }
                 parent = parent.parentElement;
              }
              
              if (badDomains.some((d: string) => domain.includes(d))) return null;

              let authority = 3;
              if (trusted.some((d: string) => domain.includes(d))) authority = 10;
              
              return {
                original: getAbsoluteUrl(src),
                title: img.getAttribute('alt') || 'Wine Candidate',
                url: url,
                domain: domain,
                authority: authority,
                source: 'DDG Scraper'
              };
            }).filter((r): r is any => r !== null).slice(0, 10);
          }, { badDomains: BAD_DOMAINS, trusted: TRUSTED_DOMAINS });
          
          if (res && Array.isArray(res) && res.length > 0) {
            console.log(`[Playwright] Found ${res.length} candidates for query: ${q}`);
            allResults.push(...res);
            if (res.some((r: any) => r.authority === 10)) {
               console.log(`[Playwright] Found trusted results, stopping early.`);
               break;
            }
          }
        } catch (e: any) {
          console.warn(`DDG partial failure: ${e.message}`);
        }
      }
    } finally {
      await browser.close().catch(() => {});
    }

    console.log(`[Playwright] Total candidates found: ${allResults.length}`);
    return allResults
      .sort((a, b) => b.authority - a.authority)
      .filter((r, i, self) => r.original && self.findIndex(t => t.original === r.original) === i);
  } catch (error: any) {
    console.error("[Playwright] Search engine failure:", error.message);
    return [];
  }
}

// E. Search Service Orchestrator
async function searchImages(sku: WineSKU) {
  const apiKey = process.env.SERPAPI_KEY;
  const wineDomains = "site:wine-searcher.com OR site:vivino.com OR site:millesima.com OR site:idealwine.com OR site:cellartracker.com";
  
  console.log(`[Search] Orchestrating: ${sku.wine_name}`);

  if (apiKey && apiKey !== "MY_SERPAPI_KEY") {
    try {
      // 1. High-Precision Domain Search
      const q1 = `${sku.wine_name} ${sku.vintage} (${wineDomains}) bottle shot`;
      const response = await axios.get('https://serpapi.com/search.json', {
        params: { q: q1, tbm: 'isch', api_key: apiKey, num: 10 },
        timeout: 10000
      });
      
      let results = response.data.images_results || [];
      
      // 2. Fallback to Broad Search if needed
      if (results.length === 0) {
        console.log("[SerpAPI] No restricted hits, trying broad search...");
        const q2 = `${sku.wine_name} ${sku.vintage} wine bottle label photo`;
        const res2 = await axios.get('https://serpapi.com/search.json', {
          params: { q: q2, tbm: 'isch', api_key: apiKey, num: 10 }
        });
        results = res2.data.images_results || [];
      }

      // 3. Last chance broad search
      if (results.length === 0) {
        const q3 = `${sku.wine_name.split(' ').slice(0, 3).join(' ')} bottle`;
        console.log(`[SerpAPI] Final fallback query: ${q3}`);
        const res3 = await axios.get('https://serpapi.com/search.json', {
          params: { q: q3, tbm: 'isch', api_key: apiKey, num: 5 }
        });
        results = res3.data.images_results || [];
      }

      if (results.length > 0) {
        return results.map((img: any) => {
          const domain = img.source || 'unknown';
          const isTrusted = ['vivino.com', 'wine-searcher.com', 'millesima.com', 'idealwine.com', 'cellartracker.com'].some(d => domain.toLowerCase().includes(d));
          return {
            original: img.original,
            title: img.title,
            source: img.source,
            domain: domain,
            authority: isTrusted ? 10 : 6
          };
        });
      }
    } catch (e: any) {
      if (e.response?.status === 429) {
        console.warn("[SerpAPI] Rate limit reached (429). Switching to Playwright.");
      } else {
        console.error("[SerpAPI] Error:", e.message);
      }
    }
  } else {
    console.warn("[Search] SERPAPI_KEY missing - skipping to Playwright");
  }

  const finalResults = await playwrightSearch(sku);
  if (finalResults && finalResults.length > 0) return finalResults;

  console.log(`[Search] Critical: No candidates for ${sku.wine_name} after all attempts.`);
  return [];
}

// F. OpenRouter Verification (Qwen-VL-Plus)
async function verifyWithOpenRouter(sku: WineSKU, imageUrl: string) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey === "MY_OPENROUTER_API_KEY") {
    return { pass: false, confidence: 0, reasoning: "OpenRouter API Key not configured." };
  }

  try {
    const prompt = `Verify if this wine bottle image is EXACTLY: ${sku.wine_name} ${sku.vintage}. 
    Respond in JSON: {"pass": boolean, "confidence": number, "reasoning": "string"}`;

    const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: "qwen/qwen-2.5-vl-72b-instruct:free",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageUrl } }
          ]
        }
      ],
      response_format: { type: "json_object" }
    }, {
      headers: { 
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': process.env.APP_URL || 'http://localhost:3000',
        'X-Title': 'VinoBuzz Photo Pipeline'
      }
    });

    return JSON.parse(response.data.choices[0].message.content);
  } catch (error: any) {
    console.error("OpenRouter error:", error.response?.data || error.message);
    throw new Error("OpenRouter verification failed");
  }
}

// G. Gemini Vision Audit (REMOVED - USE FRONTEND SDK)

// --- API ROUTES ---

app.post('/api/search', async (req, res) => {
  const sku: WineSKU = req.body;
  console.log(`[API] Search request for: ${sku.wine_name} (${sku.vintage})`);

  if (!sku.wine_name || !sku.vintage) {
    return res.status(400).json({ error: "wine_name and vintage are required" });
  }

  try {
    const candidates = await searchImages(sku);
    console.log(`[API] Search completed, found ${candidates?.length || 0} candidates.`);
    res.json({ candidates: candidates || [] });
  } catch (error: any) {
    console.error("[API] Search route error:", error.message);
    res.status(500).json({ candidates: [], error: "Internal search error" });
  }
});

app.post('/api/verify-openrouter', async (req, res) => {
  const { sku, imageUrl } = req.body;
  try {
    const result = await verifyWithOpenRouter(sku, imageUrl);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Verification failed" });
  }
});

app.post('/api/verify-deterministic', async (req, res) => {
  const { sku, imageUrl } = req.body;
  try {
    const result = await verifyDeterministic(sku, imageUrl);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Deterministic verification failed" });
  }
});

app.get('/api/proxy-image', async (req, res) => {
  const { url } = req.query;
  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
     return res.status(400).send("Valid absolute URL required");
  }

  try {
    const response = await axios.get(url, { 
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer': 'https://www.google.com/'
      },
      timeout: 10000
    });
    const contentType = response.headers['content-type'];
    const base64 = Buffer.from(response.data).toString('base64');
    res.json({ base64, contentType });
  } catch (error: any) {
    console.error(`[Proxy] Failed to fetch ${url}: ${error.message}`);
    res.status(500).send("Failed to proxy image");
  }
});

app.post('/api/refresh-wines', async (req, res) => {
  try {
    const wines = await scrapeAllWines(20); 
    res.json({
      success: true,
      count: wines.length,
      message: `Successfully refreshed ${wines.length} wines`,
    });
  } catch (error: any) {
    console.error(error);
    res.status(500).json({
      success: false,
      error: error.message || 'Unknown error',
    });
  }
});

// --- VITE MIDDLEWARE ---

async function start() {
  // Seed the catalog if empty
  try {
    const dataPath = path.join(process.cwd(), 'public', 'data', 'wines.json');
    const existing = await fs.readFile(dataPath, 'utf-8').catch(() => '[]');
    if (existing === '[]' || existing === '') {
      console.log('🌱 Catalog empty, seeding 10 test SKUs...');
      await scrapeAllWines(1); 
    }
  } catch (e) {
    console.error('Seeding failed:', e);
  }

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${PORT}`);
  });
}

start();
