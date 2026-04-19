import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import { chromium } from 'playwright';
import { createWorker } from 'tesseract.js';
import fuzzysort from 'fuzzysort';
import sharp from 'sharp';
import { scrapeAllWines } from './src/services/vinobuzzScraper.js';

dotenv.config();

// Use process.cwd() for path resolution — works in both ESM (tsx dev) and CJS (bundled prod).
// import.meta.url is stripped to undefined when esbuild bundles ESM → CJS.
const APP_ROOT = process.cwd();

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// Health check for Docker/Production
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

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
// Gates in order of cheapest → most expensive. All pure sharp (no extra deps).
async function visualPreFilter(buffer: Buffer): Promise<{ pass: boolean; reason: string; qualityFactor: number }> {
  try {
    const metadata = await sharp(buffer).metadata();
    const W = metadata.width || 0;
    const H = metadata.height || 0;

    // 1. Resolution gate
    if (W < 300 || H < 400) {
      return { pass: false, reason: "Resolution too low for professional verification.", qualityFactor: 0 };
    }

    // 2. Aspect ratio — many retailers (Shopify etc.) host square 1:1 packshots of bottles on white.
    //    Only reject clearly horizontal/landscape images. Square is acceptable; tall portrait is preferred.
    const ratio = H / W;
    if (ratio < 0.85) {
      return { pass: false, reason: `Landscape aspect (${ratio.toFixed(2)}:1) — not a bottle shot.`, qualityFactor: 0 };
    }

    // 3. Background cleanness — sample 4 corners, each 24×24.
    //    A clean packshot has bright, uniform corners (white/cream/grey studio).
    const cornerSize = 24;
    const corners = await Promise.all([
      sharp(buffer).extract({ left: 0, top: 0, width: cornerSize, height: cornerSize }).greyscale().stats(),
      sharp(buffer).extract({ left: W - cornerSize, top: 0, width: cornerSize, height: cornerSize }).greyscale().stats(),
      sharp(buffer).extract({ left: 0, top: H - cornerSize, width: cornerSize, height: cornerSize }).greyscale().stats(),
      sharp(buffer).extract({ left: W - cornerSize, top: H - cornerSize, width: cornerSize, height: cornerSize }).greyscale().stats()
    ]);
    const cornerMeans = corners.map(s => s.channels[0].mean);
    const cornerStdevs = corners.map(s => s.channels[0].stdev);
    const avgCornerMean = cornerMeans.reduce((a, b) => a + b, 0) / 4;
    const maxCornerStdev = Math.max(...cornerStdevs);
    const meanSpread = Math.max(...cornerMeans) - Math.min(...cornerMeans);

    // Background penalty (soft — reduces qualityFactor but doesn't reject outright)
    let bgPenalty = 0;
    if (avgCornerMean < 80) bgPenalty += 3; // very dark bg (night shot / restaurant scene)
    if (maxCornerStdev > 40) bgPenalty += 3; // busy/textured bg (lifestyle shot with props)
    if (meanSpread > 60) bgPenalty += 2; // non-uniform lighting (not studio)
    const cleanBg = bgPenalty === 0;

    // Reject lifestyle/scene shots outright when all three background signals trip
    if (avgCornerMean < 60 && maxCornerStdev > 45 && meanSpread > 70) {
      return { pass: false, reason: "Busy non-studio background (lifestyle/scene shot).", qualityFactor: 1 };
    }

    // 4. Blur detection — Laplacian variance proxy via sharp convolve.
    //    Low variance of edge response = blurry. Run on a downsampled copy for speed.
    const laplacianKernel = {
      width: 3, height: 3,
      kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0]
    };
    const edgeStats = await sharp(buffer)
      .resize({ width: 400, withoutEnlargement: false })
      .greyscale()
      .convolve(laplacianKernel)
      .stats();
    const edgeVariance = edgeStats.channels[0].stdev ** 2;

    // 5. Overall contrast — used for composite scoring.
    const stats = await sharp(buffer).stats();
    const avgStdDev = stats.channels.reduce((acc, c) => acc + c.stdev, 0) / stats.channels.length;

    // Blur hard-fail
    if (edgeVariance < 30 || avgStdDev < 10) {
      return { pass: false, reason: `Image exceeds blur tolerance (edge var ${edgeVariance.toFixed(0)}, stddev ${avgStdDev.toFixed(1)}).`, qualityFactor: 0 };
    }

    // Composite quality factor (0–10)
    let qualityFactor = 10;
    if (avgStdDev < 20) qualityFactor -= 3;
    if (avgStdDev < 12) qualityFactor -= 3;
    if (edgeVariance < 80) qualityFactor -= 2; // soft-focus
    if (ratio < 1.1) qualityFactor -= 1; // square — acceptable but tall bottle shots preferred
    qualityFactor = Math.max(qualityFactor - bgPenalty, 0);

    return {
      pass: true,
      reason: `Visual OK (ratio ${ratio.toFixed(2)}, edge var ${edgeVariance.toFixed(0)}, cleanBg=${cleanBg}).`,
      qualityFactor
    };
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

    // 2. Tier 3 - OCR Extraction (multi-lang, upscaled, preprocessed — see runOCR)
    const rawOCR = await runOCR(buffer);
    const combinedOCR = normalizeText(rawOCR);

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

// D. Playwright Search (Bing Images - reliable image scraping)
async function playwrightSearch(sku: WineSKU) {
  const TRUSTED_DOMAINS = [
    'wine-searcher.com', 'vivino.com', 'millesima.com', 'idealwine.com', 'wine.com',
    'cellartracker.com', 'bbr.com', 'vinatis.com', 'klwines.com', 'totalwine.com',
    'decanter.com', 'wineaccess.com', 'berrybros.com'
  ];
  const BAD_DOMAINS = ['pinterest.com', 'shutterstock.com', 'alamy.com', 'facebook.com',
    'instagram.com', 'twitter.com', 'x.com', 'tiktok.com'];

  const candidates: any[] = [];
  const vintage = (sku.vintage || '').toString();
  const isNV = !vintage || /^nv$/i.test(vintage);

  // Multi-query strategy: quoted SKU + vintage, vintage-first, then vineyard focus
  const queries: string[] = [];
  if (isNV) {
    queries.push(`"${sku.wine_name}" NV bottle`);
    queries.push(`${sku.wine_name} NV wine bottle front label`);
  } else {
    queries.push(`"${sku.wine_name}" "${vintage}" bottle`);
    queries.push(`${vintage} ${sku.wine_name} wine bottle front label`);
    if (sku.vineyard) queries.push(`"${sku.vineyard}" "${vintage}" ${sku.wine_name.split(' ').slice(0, 2).join(' ')} bottle`);
  }

  // Token set for title-match scoring
  const targetTokens = sku.wine_name
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2);

  try {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
    });

    try {
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        locale: 'en-US'
      });

      // Fire Bing queries sequentially (avoid rate limits)
      for (const query of queries) {
        console.log(`[Search] Bing: ${query}`);
        const page = await context.newPage();
        try {
          const bingUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1`;
          await page.goto(bingUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await page.waitForTimeout(2000);

          const bingImages = await page.evaluate(({ trusted, bad }) => {
            const results: any[] = [];
            const seen = new Set();
            const tiles = document.querySelectorAll('a.iusc');
            tiles.forEach((tile) => {
              try {
                const mAttr = tile.getAttribute('m');
                if (!mAttr) return;
                const meta = JSON.parse(mAttr);
                const imgUrl = meta.murl;
                const pageUrl = meta.purl;
                const title = meta.t || '';
                if (!imgUrl || seen.has(imgUrl)) return;
                seen.add(imgUrl);

                let domain = 'unknown';
                try { domain = new URL(pageUrl || imgUrl).hostname.replace('www.', ''); } catch (e) {}
                if (bad.some((d: string) => domain.includes(d))) return;

                let score = 5;
                if (trusted.some((d: string) => domain.includes(d))) score = 10;
                results.push({
                  original: imgUrl,
                  pageUrl,
                  title: title || 'Wine bottle',
                  domain,
                  authority: score,
                  source: 'Bing Images',
                  width: meta.mw,
                  height: meta.mh
                });
              } catch (e) {}
            });
            return results.slice(0, 20);
          }, { trusted: TRUSTED_DOMAINS, bad: BAD_DOMAINS });

          if (bingImages?.length) {
            candidates.push(...bingImages);
            console.log(`[Search]   +${bingImages.length} from Bing`);
          }
        } catch (e) {
          console.log('[Search] Bing error:', (e as Error).message);
        } finally {
          await page.close();
        }
        if (candidates.length >= 25) break; // enough to score
      }

      // Google fallback only if Bing was weak
      if (candidates.length < 5) {
        const gPage = await context.newPage();
        try {
          const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(queries[0])}&tbm=isch&safe=active`;
          await gPage.goto(googleUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await gPage.waitForTimeout(2500);

          const googleImages = await gPage.evaluate(({ trusted, bad }) => {
            const results: any[] = [];
            const seen = new Set();
            const imgs = document.querySelectorAll('img[src^="https"], img[data-src^="https"]');
            imgs.forEach((img) => {
              const src = (img as HTMLImageElement).src || img.getAttribute('data-src');
              if (!src || src.length < 20 || seen.has(src)) return;
              if (src.includes('gstatic.com') || src.includes('google.com/logos')) return;
              seen.add(src);
              let domain = 'google-images';
              try { domain = new URL(src).hostname.replace('www.', ''); } catch (e) {}
              if (bad.some((d: string) => domain.includes(d))) return;
              let score = 4;
              if (trusted.some((d: string) => domain.includes(d))) score = 9;
              results.push({
                original: src,
                pageUrl: '',
                title: (img as HTMLImageElement).alt || 'Wine bottle',
                domain,
                authority: score,
                source: 'Google Images'
              });
            });
            return results.slice(0, 10);
          }, { trusted: TRUSTED_DOMAINS, bad: BAD_DOMAINS });

          if (googleImages?.length) candidates.push(...googleImages);
        } catch (e) {
          console.log('[Search] Google error:', (e as Error).message);
        } finally {
          await gPage.close();
        }
      }

    } finally {
      await browser.close().catch(() => {});
    }

  } catch (error: any) {
    console.error('[Search] Playwright error:', error.message);
  }

  // Rescore: vintage match in URL/title is heavily weighted, wrong vintage is penalized
  const vintageRegex = /\b(19|20)\d{2}\b/g;
  const scored = candidates.map(c => {
    const haystack = `${c.title || ''} ${c.pageUrl || ''} ${c.original || ''}`.toLowerCase();
    let score = c.authority;

    // Aspect ratio preference
    if (c.width && c.height) {
      if (c.height > c.width) score += 2;
      if (c.width >= 400 || c.height >= 600) score += 1;
      if (c.width < 200 || c.height < 250) score -= 3;
    }

    // Vintage-aware scoring
    if (!isNV) {
      if (haystack.includes(vintage)) {
        score += 8; // strong boost for correct vintage
      } else {
        const detected = Array.from(haystack.match(vintageRegex) || [])
          .map(y => String(y))
          .filter(y => y !== vintage && Number(y) >= 1950 && Number(y) <= new Date().getFullYear());
        if (detected.length > 0) score -= 6; // penalize wrong vintage
      }
    } else if (/\bnv\b|non[- ]vintage/.test(haystack)) {
      score += 4;
    }

    // Token-match on wine name
    const hits = targetTokens.filter(t => haystack.includes(t)).length;
    score += Math.min(hits, 5);

    // Bottle-shape hint
    if (/bottle|label/.test(haystack)) score += 1;

    return { ...c, authority: score };
  });

  const unique = scored
    .filter((r, i, self) =>
      r.original &&
      r.original.startsWith('http') &&
      self.findIndex(t => t.original === r.original) === i
    )
    .sort((a, b) => b.authority - a.authority)
    .slice(0, 10);

  console.log(`[Search] Returning ${unique.length} ranked candidates (vintage=${vintage || 'NV'})`);
  unique.slice(0, 3).forEach((c, i) => console.log(`[Search]   #${i + 1} [${c.authority}] ${c.domain} — ${c.title?.slice(0, 80)}`));
  return unique;
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
      model: "qwen/qwen3.5-27b",
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

// G. VLM Text Extraction (Qwen-VL) - Replaces OCR for better accuracy
async function extractTextWithVLM(imageUrl: string): Promise<{ text: string; structured: any }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OpenRouter API Key not configured for VLM extraction");
  }

  const prompt = `Extract all readable text from this wine bottle label image. 
  Focus on: producer name, vintage year, appellation, vineyard/climat, classification (Grand Cru, 1er Cru, etc.).
  Return JSON format: { "full_text": "all text concatenated", "producer": "...", "vintage": "...", "appellation": "...", "vineyard": "...", "classification": "..." }`;

  try {
    const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: "qwen/qwen3.5-27b",
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
        'X-Title': 'VinoBuzz VLM Extraction'
      },
      timeout: 30000
    });

    const result = JSON.parse(response.data.choices[0].message.content);
    const fullText = result.full_text || [
      result.producer,
      result.vintage,
      result.appellation,
      result.vineyard,
      result.classification
    ].filter(Boolean).join(' ');

    return { text: fullText, structured: result };
  } catch (error: any) {
    console.error("VLM extraction error:", error.response?.data || error.message);
    throw new Error("VLM text extraction failed");
  }
}

// OCR worker singleton — expensive to init, keep one per process
let ocrWorker: any = null;
const TESSDATA_PATH = path.join(process.cwd(), 'tessdata');
async function getOCRWorker() {
  if (ocrWorker) return ocrWorker;
  ocrWorker = await createWorker(['eng', 'fra', 'ita', 'deu'], 1, {
    langPath: TESSDATA_PATH,
    cachePath: TESSDATA_PATH,
    gzip: false
  });
  // Tune parameters for wine labels: single block, high DPI hint
  await ocrWorker.setParameters({
    tessedit_pageseg_mode: '3', // Auto layout — handles varied wine label geometries
    preserve_interword_spaces: '1',
    user_defined_dpi: '300'
  });
  return ocrWorker;
}

// H1. Quick OCR — Tesseract with multi-lang + adaptive preprocessing (NO hard threshold)
async function runOCR(buffer: Buffer): Promise<string> {
  try {
    const worker = await getOCRWorker();
    const metadata = await sharp(buffer).metadata();
    const W = metadata.width || 0;
    const H = metadata.height || 0;

    // Skip absurdly small images — nothing to OCR
    if (W < 120 || H < 120) return "";

    // Upscale small images — Tesseract needs ~300dpi equivalent. Use Lanczos for quality.
    const targetWidth = Math.max(W * 2, 1400);

    // Pass 1: Full image, grayscale + CLAHE-style normalize + sharpen. NO threshold.
    const fullPre = await sharp(buffer)
      .resize({ width: targetWidth, withoutEnlargement: false, kernel: 'lanczos3' })
      .grayscale()
      .normalize({ lower: 2, upper: 98 }) // contrast stretch, clip 2% tails
      .sharpen({ sigma: 1.0 })
      .toBuffer();

    // Pass 2: Label crop (center, looser vertical range 20-75% — covers both top and center labels)
    const cropWidth = Math.round(W * 0.8);
    const cropHeight = Math.round(H * 0.55);
    const cropLeft = Math.round((W - cropWidth) / 2);
    const cropTop = Math.round(H * 0.2);
    const labelPre = await sharp(buffer)
      .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
      .resize({ width: Math.max(cropWidth * 3, 1600), kernel: 'lanczos3' })
      .grayscale()
      .normalize({ lower: 2, upper: 98 })
      .sharpen({ sigma: 1.5 })
      .toBuffer();

    // Pass 3: Inverted variant — catches light-text-on-dark-label bottles (e.g. Rayas, some Champagnes)
    const invertedPre = await sharp(buffer)
      .resize({ width: targetWidth, withoutEnlargement: false, kernel: 'lanczos3' })
      .grayscale()
      .normalize({ lower: 2, upper: 98 })
      .negate()
      .sharpen({ sigma: 1.0 })
      .toBuffer();

    const [fullRes, labelRes, invRes] = await Promise.all([
      worker.recognize(fullPre),
      worker.recognize(labelPre),
      worker.recognize(invertedPre)
    ]);

    // Pick the pass with the most alphabetic content (reject garbage)
    const texts = [fullRes.data.text, labelRes.data.text, invRes.data.text].map(t => t || '');
    const alphaCount = (t: string) => (t.match(/[A-Za-zÀ-ÿ]{3,}/g) || []).length;
    texts.sort((a, b) => alphaCount(b) - alphaCount(a));

    const combined = texts.join(' ')
      .replace(/[\u0000-\u001F]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return combined;
  } catch (e: any) {
    console.error('[OCR] Error:', e.message);
    return "";
  }
}

// H2. VLM Decision Maker - takes OCR hint + target SKU and renders final verdict
async function vlmDecide(sku: WineSKU, imageUrl: string, ocrHint: string) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OpenRouter API Key not configured");

  const prompt = `You are verifying whether a wine bottle photo matches a target SKU. You are the FINAL DECISION MAKER.

TARGET SKU:
- Wine name: ${sku.wine_name}
- Vintage: ${sku.vintage}
- Appellation: ${sku.appellation || 'N/A'}
- Vineyard/Climat: ${sku.vineyard || 'N/A'}
- Classification: ${sku.classification || 'N/A'}
- Region: ${sku.region || 'N/A'}

OCR HINT (noisy Tesseract output from the image, use as evidence — producers often appear as owner names or domaine variations):
"""
${ocrHint.slice(0, 500)}
"""

INSTRUCTIONS:
1. Read the label in the image directly (do not rely solely on the OCR).
2. Treat owner/producer name variants as matches (e.g., "Stéphane Robert" = "Domaine du Tunnel", "Colette Faller" = "Domaine Weinbach").
3. VINTAGE is critical — if a different year is clearly visible, it is NO_MATCH. "NV" matches non-vintage champagnes.
4. APPELLATION + VINEYARD/CLIMAT must align with the target (Burgundy climats are strict — "Latricières" ≠ "Mazis").
5. Reject lifestyle shots, watermarks, stock images, or images where the label is not readable.

Return strict JSON:
{
  "verdict": "MATCH" | "PARTIAL" | "NO_MATCH",
  "confidence": 0-100,
  "matched_fields": { "producer": boolean, "vintage": boolean, "appellation": boolean, "vineyard": boolean },
  "detected": { "producer": "string", "vintage": "string", "appellation": "string", "vineyard": "string" },
  "has_watermark": boolean,
  "is_professional": boolean,
  "reasoning": "one concise sentence explaining the verdict"
}`;

  const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
    model: "qwen/qwen3.5-27b",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: imageUrl } }
      ]
    }],
    response_format: { type: "json_object" }
  }, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': process.env.APP_URL || 'http://localhost:3000',
      'X-Title': 'VinoBuzz VLM Decision'
    },
    timeout: 45000
  });

  return JSON.parse(response.data.choices[0].message.content);
}

// H. VLM-Based Verification (VLM is the final decision maker, OCR provides hint context)
async function verifyWithVLM(sku: WineSKU, imageUrl: string) {
  console.log(`[VLM Verify] Analyzing image: ${imageUrl}`);

  try {
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data);

    // 1. Visual Pre-Filter (only absolute rejects — too blurry / wrong aspect)
    const preFilter = await visualPreFilter(buffer);
    if (!preFilter.pass) {
      return {
        pass: false,
        confidence: 0,
        verdict: 'FAIL',
        reasoning: `VISUAL REJECT: ${preFilter.reason}`,
        ocr_hint: "",
        vlm_decision: null
      };
    }

    // 2. OCR (as evidence / hint, NOT a gate)
    const ocrHint = await runOCR(buffer);
    console.log(`[OCR Hint]: ${ocrHint.slice(0, 200)}`);

    // 3. VLM final decision
    const decision = await vlmDecide(sku, imageUrl, ocrHint);
    console.log(`[VLM Decision]:`, decision);

    // Strict gates — VLM's own verdicts
    if (decision.has_watermark) {
      return {
        pass: false,
        confidence: Math.min(decision.confidence, 30),
        verdict: 'FAIL',
        reasoning: `Watermark detected: ${decision.reasoning}`,
        ocr_hint: ocrHint,
        vlm_decision: decision,
        qualityFactor: preFilter.qualityFactor
      };
    }

    // Score composition — VLM confidence is the backbone (×0.9), quality 0–10, soft penalty for unprofessional shots.
    // Classical preFilter already rejected truly bad images (blur/aspect/bg). Don't double-gate on VLM's professional
    // opinion — it would block legitimate CellarTracker / retailer label-only crops that are perfect identity matches.
    const profPenalty = decision.is_professional === false ? 5 : 0;
    const finalScore = Math.min(
      Math.max(Math.round((decision.confidence || 0) * 0.9) + (preFilter.qualityFactor || 0) - profPenalty, 0),
      100
    );

    // PASS criteria: VLM says MATCH + score clears bar + no watermark.
    // Trust classical preFilter for studio-quality judgment (already passed at this point).
    const finalPass =
      decision.verdict === 'MATCH' &&
      finalScore >= 70;

    return {
      pass: finalPass,
      confidence: finalScore,
      verdict: finalPass ? 'PASS' : 'FAIL',
      reasoning: decision.reasoning || `VLM verdict: ${decision.verdict}`,
      ocr_hint: ocrHint,
      vlm_decision: decision,
      qualityFactor: preFilter.qualityFactor
    };

  } catch (error: any) {
    console.error("[VLM Verify] Error:", error.message);
    return {
      pass: false,
      confidence: 0,
      verdict: 'FAIL',
      reasoning: `VLM verification failed: ${error.message}`,
      ocr_hint: "",
      vlm_decision: null
    };
  }
}

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

app.post('/api/verify-vlm', async (req, res) => {
  const { sku, imageUrl } = req.body;
  try {
    const result = await verifyWithVLM(sku, imageUrl);
    res.json(result);
  } catch (error: any) {
    console.error("VLM verification route error:", error.message);
    res.status(500).json({ error: "VLM verification failed", reasoning: error.message });
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
    // Lazy-load vite so it never touches production bundles
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(APP_ROOT, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(APP_ROOT, 'dist', 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${PORT}`);
    console.log(`Mode: ${process.env.NODE_ENV || 'development'}`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('Shutting down gracefully...');
    server.close(() => {
      console.log('Server closed.');
      process.exit(0);
    });
    
    // Force close after 10s
    setTimeout(() => {
      console.error('Forced shutdown.');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start();
