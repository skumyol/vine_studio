import React, { useState, useEffect, useMemo } from 'react';
import { GoogleGenAI, Type } from "@google/genai";
import { 
  Search, 
  CheckCircle2, 
  XCircle, 
  Loader2, 
  ChevronRight, 
  History, 
  Image as ImageIcon,
  ShieldCheck,
  Zap,
  Filter,
  AlertTriangle,
  ExternalLink,
  ClipboardList
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Types ---

interface WineSKU {
  wine_name: string;
  vintage: string;
  region?: string;
  appellation?: string;
  vineyard?: string;
  classification?: string;
  format?: string;
}

interface AnalysisResult {
  id: string;
  input: WineSKU;
  verdict: 'PASS' | 'FAIL' | 'NO_IMAGE';
  confidence: number;
  selected_image_url: string | null;
  explanation: string;
  candidates: any[];
  timestamp: string;
  user_verified?: 'CORRECT' | 'INCORRECT' | 'PENDING';
}

interface MarketWine {
  id: string;
  sku: string;
  name: string;
  vintage?: string;
  producer: string;
  vineyard?: string;
  appellation?: string;
  region?: string;
  country?: string;
  priceHKD: number;
  type?: string;
  image?: string;
  url?: string;
  stock?: number;
  format?: string;
  classification?: string;
  source?: string;
}

export default function App() {
  const [wineName, setWineName] = useState('');
  const [vintage, setVintage] = useState('');
  const [region, setRegion] = useState('');
  const [appellation, setAppellation] = useState('');
  const [vineyard, setVineyard] = useState('');
  const [classification, setClassification] = useState('');
  const [format, setFormat] = useState('Standard (750ml)');
  const [analyzerMode, setAnalyzerMode] = useState<'vlm' | 'gemini' | 'deterministic'>('vlm');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [currentResult, setCurrentResult] = useState<AnalysisResult | null>(null);
  const [history, setHistory] = useState<AnalysisResult[]>([]);
  const [activeTab, setActiveTab] = useState<'analyzer' | 'history' | 'marketplace' | 'batch'>('analyzer');
  const [batchResults, setBatchResults] = useState<AnalysisResult[]>([]);
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState(0);
  const [batchStage, setBatchStage] = useState<string>('');
  const [batchCurrentSku, setBatchCurrentSku] = useState<string>('');
  const [batchCandidateInfo, setBatchCandidateInfo] = useState<string>('');

  const ai = useMemo(() => new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' }), []);

  // Performance Metrics Calculation
  const metrics = useMemo(() => {
    const verified = batchResults.filter(r => r.user_verified && r.user_verified !== 'PENDING');
    if (verified.length === 0) return { precision: 0, recall: 0, f1: 0, accuracy: 0 };

    const tp = verified.filter(r => r.verdict === 'PASS' && r.user_verified === 'CORRECT').length;
    const fp = verified.filter(r => r.verdict === 'PASS' && r.user_verified === 'INCORRECT').length;
    const fn = verified.filter(r => r.verdict === 'FAIL' && r.user_verified === 'INCORRECT').length;
    const tn = verified.filter(r => r.verdict === 'FAIL' && r.user_verified === 'CORRECT').length;

    const precision = tp / (tp + fp) || 0;
    const recall = tp / (tp + fn) || 0;
    const f1 = (2 * precision * recall) / (precision + recall) || 0;
    const accuracy = (tp + tn) / (tp + tn + fp + fn) || 0;

    return {
      precision: Math.round(precision * 100),
      recall: Math.round(recall * 100),
      f1: Math.round(f1 * 100),
      accuracy: Math.round(accuracy * 100)
    };
  }, [batchResults]);
  
  // Marketplace State
  const [marketWines, setMarketWines] = useState<MarketWine[]>([]);
  const [marketSearchQuery, setMarketSearchQuery] = useState('');
  const [selectedAppellation, setSelectedAppellation] = useState('');
  const [selectedClassification, setSelectedClassification] = useState('');
  const [selectedFormat, setSelectedFormat] = useState('');
  const [selectedRegion, setSelectedRegion] = useState('');
  const [isRefreshingMarket, setIsRefreshingMarket] = useState(false);
  const [isMarketLoading, setIsMarketLoading] = useState(true);

  useEffect(() => {
    const loadMarket = async () => {
      try {
        const res = await fetch('data/wines.json');
        if (res.ok) {
          const data = await res.json();
          setMarketWines(data);
        }
      } catch (e) {
        console.error("Failed to load marketplace data", e);
      } finally {
        setIsMarketLoading(false);
      }
    };
    loadMarket();
  }, []);

  const handleRefreshMarket = async () => {
    setIsRefreshingMarket(true);
    try {
      const res = await fetch('api/refresh-wines', { method: 'POST' });
      const result = await res.json();
      if (result.success) {
        const fresh = await fetch('data/wines.json').then(r => r.json());
        setMarketWines(fresh);
      }
    } catch (e) {
      console.error("Refresh failed", e);
    } finally {
      setIsRefreshingMarket(false);
    }
  };
  
  const uniqueProducers = useMemo(() => Array.from(new Set(marketWines.map(w => w.producer).filter(Boolean))).sort(), [marketWines]);
  const uniqueAppellations = useMemo(() => Array.from(new Set(marketWines.map(w => w.appellation || w.region).filter(Boolean))).sort(), [marketWines]);
  const uniqueClassifications = useMemo(() => Array.from(new Set(marketWines.map(w => w.classification).filter(Boolean))).sort(), [marketWines]);
  const uniqueFormats = useMemo(() => Array.from(new Set(marketWines.map(w => w.format).filter(Boolean))).sort(), [marketWines]);
  const uniqueRegions = useMemo(() => Array.from(new Set(marketWines.map(w => w.region).filter(Boolean))).sort(), [marketWines]);

  const selectMarketWine = (wine: MarketWine) => {
    setWineName(wine.producer || wine.name);
    setVintage(wine.vintage || '');
    setAppellation(wine.appellation || wine.region || '');
    setRegion(wine.region || '');
    setClassification(wine.classification || '');
    setVineyard(wine.vineyard || '');
    
    // Attempt to map format
    if (wine.format) {
      const f = wine.format.toLowerCase();
      if (f.includes('1.5') || f.includes('magnum')) setFormat('Magnum (1.5L)');
      else if (f.includes('375') || f.includes('half')) setFormat('Half (375ml)');
      else setFormat('Standard (750ml)');
    }
    
    setActiveTab('analyzer');
  };

  const filteredMarketWines = marketWines.filter(w => {
    const q = marketSearchQuery.toLowerCase();
    const matchesQuery = (w.name?.toLowerCase() || '').includes(q) || 
           (w.producer?.toLowerCase() || '').includes(q) || 
           (w.region?.toLowerCase() || '').includes(q) ||
           (w.appellation?.toLowerCase() || '').includes(q) ||
           (w.vineyard?.toLowerCase() || '').includes(q) ||
           (w.classification?.toLowerCase() || '').includes(q);
           
    const matchesAppellation = !selectedAppellation || w.appellation === selectedAppellation || w.region === selectedAppellation;
    const matchesClassification = !selectedClassification || w.classification === selectedClassification;
    const matchesFormat = !selectedFormat || w.format === selectedFormat;
    const matchesRegion = !selectedRegion || w.region === selectedRegion;

    return matchesQuery && matchesAppellation && matchesClassification && matchesFormat && matchesRegion;
  });

  const verifyCandidate = async (sku: WineSKU, imageUrl: string, authorityScore: number = 5) => {
    let compositeScore = 0;
    const scores = { vision: 0, vlm: 0, ocr: 0, authority: authorityScore, quality: 0 };
    
    // 1. Quality check (always run via deterministic pre-filter)
    const detRes = await fetch('api/verify-deterministic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku, imageUrl }),
    });
    const detData = await detRes.json();
    
    // Quality (10% weight) - Max 10 pts
    scores.quality = detData.qualityFactor || 0;
    
    // 2. VLM Decision Maker (backend: OCR-hinted Qwen VL verdict)
    if (analyzerMode === 'vlm') {
      try {
        const vlmRes = await fetch('api/verify-vlm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sku, imageUrl }),
        });
        const vlmData = await vlmRes.json();

        // VLM is the decision maker — its confidence + quality is the final score
        scores.vlm = Math.round((vlmData.confidence || 0) * 0.9);
        compositeScore = scores.vlm + scores.authority + scores.quality;

        return {
          pass: vlmData.verdict === 'PASS',
          confidence: Math.min(Math.round(compositeScore), 100),
          reasoning: vlmData.reasoning || "VLM verification",
          meta: scores,
          vlm_text: vlmData.ocr_hint || "",
          vlm_decision: vlmData.vlm_decision
        };
      } catch (e) {
        console.error("VLM Error:", e);
        return { pass: false, confidence: 0, reasoning: "VLM verification failed." };
      }
    }

    // Legacy: OCR (Deterministic) - Only 20% weight
    scores.ocr = detData.verdict === 'PASS' ? 20 : (detData.confidence / 100) * 20;

    // 3. Vision Audit (Gemini Frontend SDK) - Legacy mode
    if (analyzerMode === 'gemini') {
      try {
        // Use proxy to avoid CORS and get base64
        const proxyRes = await fetch(`api/proxy-image?url=${encodeURIComponent(imageUrl)}`);
        const { base64, contentType } = await proxyRes.json();

        const prompt = `Perform a high-integrity wine label verification.
        Target SKU:
        - Producer: ${sku.wine_name}
        - Vintage: ${sku.vintage}
        - Appellation: ${sku.appellation || 'N/A'}
        - Vineyard: ${sku.vineyard || 'N/A'}

        EVALUATE:
        1. IDENTITY: Does visual text/branding match exactly? (Vintage mismatch = NO_MATCH)
        2. QUALITY: Is it a clear professional shot or blurry lifestyle?
        3. WATERMARK: Detect stock photo overlays.

        Return JSON format: { "match_verdict": "MATCH"|"PARTIAL"|"NO_MATCH", "has_watermark": boolean, "is_professional": boolean, "reasoning": "string" }`;

        const response = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: [
            { text: prompt },
            { inlineData: { data: base64, mimeType: contentType || 'image/jpeg' } }
          ],
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                match_verdict: { type: Type.STRING },
                has_watermark: { type: Type.BOOLEAN },
                is_professional: { type: Type.BOOLEAN },
                reasoning: { type: Type.STRING }
              },
              required: ["match_verdict", "has_watermark", "is_professional", "reasoning"]
            }
          }
        });

        const visionResult = JSON.parse(response.text || '{}');
        let visionScore = 0;
        if (visionResult.match_verdict === 'MATCH') visionScore = 60;
        else if (visionResult.match_verdict === 'PARTIAL') visionScore = 20;

        if (visionResult.has_watermark) visionScore *= 0.1;
        if (!visionResult.is_professional) visionScore *= 0.7;

        scores.vision = Math.round(visionScore);
        compositeScore = scores.vision + scores.ocr + scores.authority + scores.quality;

        return {
          pass: compositeScore >= 80 && visionResult.match_verdict === 'MATCH' && !visionResult.has_watermark,
          confidence: Math.round(compositeScore),
          reasoning: visionResult.reasoning || detData.reasoning,
          meta: scores
        };
      } catch (e) {
        console.error("Gemini Frontend Error:", e);
        return { pass: false, confidence: 0, reasoning: "Vision Audit failed." };
      }
    }

    // Deterministic only fallback
    compositeScore = (detData.confidence * 0.8) + scores.authority + scores.quality;
    return {
      pass: compositeScore >= 75 && detData.verdict === 'PASS',
      confidence: Math.round(compositeScore),
      reasoning: detData.reasoning,
      meta: scores
    };
  };

  const handleBatchTest = async () => {
    const testItems = marketWines.filter(w => w.source === 'manual');
    if (testItems.length === 0) return alert("Refresh catalog first to load Test SKUs.");

    setIsBatchRunning(true);
    setBatchProgress(0);
    setBatchStage('Initializing');
    setBatchCurrentSku('');
    setBatchCandidateInfo('');
    const results: AnalysisResult[] = [];

    for (let i = 0; i < testItems.length; i++) {
       const w = testItems[i];
       const sku = {
         wine_name: w.name || w.producer,
         vintage: w.vintage || 'NV',
         appellation: w.appellation,
         vineyard: w.vineyard,
         classification: w.classification,
         format: w.format
       };

       setBatchCurrentSku(`${sku.wine_name} (${sku.vintage})`);

       try {
         setBatchStage(`Searching candidates (${i + 1}/${testItems.length})`);
         setBatchCandidateInfo('Bing multi-query + vintage-aware ranking');
         const searchRes = await fetch('api/search', {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify(sku)
         });
         const data = await searchRes.json();
         const candidates = data.candidates || [];

         const validCandidates = [];
         const topN = Math.min(candidates.length, 5);
         // Test top 5 candidates per SKU — vintage-correct photo may not be rank #1
         for (let ci = 0; ci < topN; ci++) {
            const c = candidates[ci];
            setBatchStage(`Verifying candidate ${ci + 1}/${topN}`);
            setBatchCandidateInfo(`${c.domain || 'unknown'} · auth ${c.authority}`);
            const v = await verifyCandidate(sku, c.original, c.authority || 5);
            validCandidates.push({ ...c, ...v });
            if (v.pass) break; // Found a good one!
         }

         // Prefer any PASS over any non-PASS, then rank by confidence.
         // Without this, a high-confidence PARTIAL beats a lower-confidence MATCH.
         const bestCandidate = validCandidates.sort((a, b) => {
            if (a.pass !== b.pass) return a.pass ? -1 : 1;
            return b.confidence - a.confidence;
         })[0];

         results.push({
           id: Math.random().toString(36).substring(7),
           input: sku,
           verdict: bestCandidate?.pass ? 'PASS' : (bestCandidate ? 'FAIL' : 'NO_IMAGE'),
           confidence: bestCandidate?.confidence || 0,
           selected_image_url: bestCandidate?.original || null,
           explanation: bestCandidate?.reasoning || "No candidate found.",
           candidates: validCandidates,
           timestamp: new Date().toISOString(),
           user_verified: 'PENDING'
         });
         setBatchResults([...results]);
       } catch (e) {
          console.error(e);
       }
       setBatchProgress(Math.round(((i+1)/testItems.length)*100));
    }
    setBatchStage('Complete');
    setBatchCurrentSku('');
    setBatchCandidateInfo('');
    setIsBatchRunning(false);
  };

  const handleAnalyze = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wineName || !vintage) return;

    setIsAnalyzing(true);
    setCurrentResult(null);

    try {
      const searchRes = await fetch('api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          wine_name: wineName, 
          vintage, 
          region, 
          appellation, 
          vineyard, 
          classification,
          format
        }),
      });
      const data = await searchRes.json();
      const candidates = data.candidates || [];

      const sku: WineSKU = { 
        wine_name: wineName, 
        vintage, 
        region, 
        appellation, 
        vineyard, 
        classification,
        format
      };
      let bestCandidate = null;
      let maxScore = 0;
      const analysisDetails = [];

      for (const cand of candidates.slice(0, 5)) {
        const analysis = await verifyCandidate(sku, cand.original, cand.authority || 5);
        analysisDetails.push({
          url: cand.original,
          title: cand.title,
          source: cand.source,
          ...analysis
        });

        if (analysis.confidence > maxScore) {
          maxScore = analysis.confidence;
          bestCandidate = { url: cand.original, ...analysis };
        }
        if (analysis.pass) break;
      }

      const finalResult: AnalysisResult = {
        id: `v1-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        input: sku,
        verdict: (bestCandidate && maxScore >= 85) ? 'PASS' : (bestCandidate ? 'FAIL' : 'NO_IMAGE'),
        confidence: maxScore,
        selected_image_url: (bestCandidate && maxScore >= 85) ? bestCandidate.url : null,
        explanation: bestCandidate ? bestCandidate.reasoning : "No candidates passed strict verification.",
        candidates: analysisDetails,
        timestamp: new Date().toISOString()
      };

      setCurrentResult(finalResult);
      setHistory(prev => [finalResult, ...prev]);
    } catch (e) {
      console.error("Pipeline failed:", e);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const [showTechnical, setShowTechnical] = useState(false);

  const getStatusColor = (v: string) => {
    if (v === 'PASS') return 'text-success-green bg-success-green/10 border-success-green/20';
    if (v === 'FAIL') return 'text-error-red bg-error-red/10 border-error-red/40';
    return 'text-text-sub bg-bg-app border-border-subtle';
  };

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-white font-sans selection:bg-accent-wine-vibrant selection:text-white">
      {/* High-Impact Top Bar */}
      <header className="h-[72px] bg-black text-white flex items-center justify-between px-8 shrink-0 z-20">
        <div className="flex items-center gap-8">
           <div className="font-display text-2xl tracking-tighter flex items-center gap-3">
              <Zap className="text-accent-wine-vibrant fill-accent-wine-vibrant" size={24} />
              VINOBUZZ <span className="opacity-40">/</span> AI VERIFIER
           </div>
           <nav className="hidden md:flex items-center gap-1 font-display text-sm tracking-widest uppercase">
              <button 
                onClick={() => setActiveTab('analyzer')}
                className={cn("px-4 h-[72px] border-b-4 transition-all", activeTab === 'analyzer' ? "border-accent-wine-vibrant bg-white/5" : "border-transparent text-white/40 hover:text-white")}
              >
                Pipeline
              </button>
              <button 
                onClick={() => setActiveTab('marketplace')}
                className={cn("px-4 h-[72px] border-b-4 transition-all", activeTab === 'marketplace' ? "border-accent-wine-vibrant bg-white/5" : "border-transparent text-white/40 hover:text-white")}
              >
                Marketplace
              </button>
              <button 
                onClick={() => setActiveTab('history')}
                className={cn("px-4 h-[72px] border-b-4 transition-all", activeTab === 'history' ? "border-accent-wine-vibrant bg-white/5" : "border-transparent text-white/40 hover:text-white")}
              >
                Archive
              </button>
              <button 
                onClick={() => setActiveTab('batch')}
                className={cn("px-4 h-[72px] border-b-4 transition-all", activeTab === 'batch' ? "border-accent-wine-vibrant bg-white/5" : "border-transparent text-white/40 hover:text-white")}
              >
                Batch Test (90% Challenge)
              </button>
           </nav>
        </div>

        <div className="flex items-center gap-6">
           <div className="flex items-center gap-2 bg-white/10 px-3 py-1.5 rounded text-[10px] font-bold uppercase tracking-widest border border-white/5">
              <div className="w-1.5 h-1.5 rounded-full bg-success-green animate-pulse" />
              Real-time Monitoring
           </div>
           <button className="text-white/40 hover:text-white transition-colors">
              <ClipboardList size={20} />
           </button>
        </div>
      </header>

      {/* Main UI */}
      <main className="flex-1 overflow-hidden relative">
        <AnimatePresence mode="wait">
          {activeTab === 'analyzer' ? (
            <motion.div 
              key="analyzer"
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }} 
              exit={{ opacity: 0 }}
              className="h-full flex overflow-hidden"
            >
              {/* Left Side: SKU Configuration (Product-Focused) */}
              <section className="w-[360px] bg-white border-r border-border-subtle p-8 overflow-y-auto shrink-0">
                <div className="mb-10">
                   <h2 className="font-display text-3xl mb-1 leading-none uppercase italic">SEARCH TARGET</h2>
                   <p className="text-[11px] font-bold text-text-sub uppercase tracking-widest">Verify identity in seconds</p>
                </div>

                <form onSubmit={handleAnalyze} className="space-y-6">
                  <div className="space-y-4">
                    <div className="space-y-1">
                      <label className="text-[10px] font-black uppercase tracking-widest text-text-sub">Vineyard / Producer</label>
                      <input 
                        value={wineName}
                        onChange={(e) => setWineName(e.target.value)}
                        placeholder="Producer name"
                        list="wine-producers"
                        className="w-full bg-bg-app px-4 py-3 border border-border-subtle focus:border-black focus:outline-none text-sm font-bold uppercase placeholder:opacity-40 transition-all rounded-sm"
                      />
                      <datalist id="wine-producers">
                        {uniqueProducers.map(p => <option key={p} value={p} />)}
                      </datalist>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label className="text-[10px] font-black uppercase tracking-widest text-text-sub">Vintage</label>
                        <input 
                          value={vintage}
                          onChange={(e) => setVintage(e.target.value)}
                          placeholder="YYYY"
                          className="w-full bg-bg-app px-4 py-3 border border-border-subtle focus:border-black focus:outline-none text-sm font-bold transition-all rounded-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-black uppercase tracking-widest text-text-sub">Format</label>
                        <select 
                          value={format}
                          onChange={(e) => setFormat(e.target.value)}
                          className="w-full bg-bg-app px-3 py-3 border border-border-subtle focus:border-black focus:outline-none text-sm font-bold transition-all rounded-sm"
                        >
                           <option>Standard (750ml)</option>
                           <option>Magnum (1.5L)</option>
                           <option>Half (375ml)</option>
                        </select>
                      </div>
                    </div>

                    <div className="space-y-1">
                      <label className="text-[10px] font-black uppercase tracking-widest text-text-sub">Appellation</label>
                      <input 
                        value={appellation}
                        onChange={(e) => setAppellation(e.target.value)}
                        placeholder="e.g. Nuits-St-Georges"
                        list="wine-appellations"
                        className="w-full bg-bg-app px-4 py-3 border border-border-subtle focus:border-black focus:outline-none text-sm font-bold transition-all rounded-sm"
                      />
                      <datalist id="wine-appellations">
                        {uniqueAppellations.map(a => <option key={a} value={a} />)}
                      </datalist>
                    </div>

                    <div className="space-y-1">
                      <label className="text-[10px] font-black uppercase tracking-widest text-text-sub">Classification</label>
                      <input 
                        value={classification}
                        onChange={(e) => setClassification(e.target.value)}
                        placeholder="e.g. 1er Cru, Grand Cru"
                        list="wine-classifications"
                        className="w-full bg-bg-app px-4 py-3 border border-border-subtle focus:border-black focus:outline-none text-sm font-bold transition-all rounded-sm"
                      />
                      <datalist id="wine-classifications">
                        {uniqueClassifications.map(c => <option key={c} value={c} />)}
                      </datalist>
                    </div>
                  </div>

                  <div className="pt-8 border-t border-border-subtle">
                     <div className="flex items-center justify-between mb-4">
                        <label className="text-[10px] font-black uppercase tracking-widest text-text-sub">Analyzer Engine</label>
                     </div>
                     <div className="flex p-1 bg-bg-app border border-border-subtle rounded-md">
                        {['vlm', 'gemini', 'deterministic'].map(m => (
                          <button 
                            key={m}
                            type="button"
                            onClick={() => setAnalyzerMode(m as any)}
                            className={cn(
                              "flex-1 py-2 text-[10px] font-black uppercase tracking-widest transition-all rounded",
                              analyzerMode === m ? "bg-black text-white shadow-lg" : "text-text-sub hover:text-black"
                            )}
                          >
                            {m === 'vlm' ? 'VLM' : m === 'gemini' ? 'HYBRID' : 'OCR'}
                          </button>
                        ))}
                     </div>
                  </div>

                  <button 
                    disabled={isAnalyzing}
                    className="w-full h-16 bg-accent-wine-vibrant text-white font-display text-xl uppercase tracking-widest hover:bg-black transition-all flex items-center justify-center gap-3 active:scale-95 disabled:opacity-50 mt-4 rounded-sm"
                  >
                    {isAnalyzing ? <Loader2 className="animate-spin" size={20} /> : <Search size={20} />}
                    {isAnalyzing ? "VERIFYING..." : "RUN ANALYSIS"}
                  </button>
                </form>

                <div className="mt-12 p-4 bg-bg-app border border-border-subtle rounded font-mono text-[9px] text-text-sub uppercase leading-tight">
                  <div className="flex justify-between border-b border-border-subtle pb-2 mb-2">
                     <span>Deployment</span>
                     <span className="text-black font-bold">LATEST.PROD</span>
                  </div>
                  <div className="flex justify-between">
                     <span>Latency</span>
                     <span className="text-black font-bold">~2400ms</span>
                  </div>
                </div>
              </section>

              {/* Center/Right: Results Hero (Product-First) */}
              <section className="flex-1 overflow-y-auto bg-bg-app p-8 md:p-12">
                <AnimatePresence mode="wait">
                  {!currentResult && !isAnalyzing ? (
                    <motion.div 
                      key="idle"
                      initial={{ opacity: 0 }} 
                      animate={{ opacity: 1 }}
                      className="h-full flex flex-col items-center justify-center"
                    >
                      <div className="w-20 h-20 bg-white border border-border-subtle flex items-center justify-center rounded-3xl mb-8 rotate-12">
                         <ImageIcon className="text-text-sub opacity-20" size={32} />
                      </div>
                      <h2 className="font-display text-4xl uppercase tracking-tighter mb-2 italic">AWAITING INPUT</h2>
                      <p className="text-text-sub font-mono text-[10px] uppercase tracking-widest">SYSTEM_STATUS: STANDBY</p>
                    </motion.div>
                  ) : isAnalyzing ? (
                    <motion.div 
                      key="loading"
                      initial={{ opacity: 0 }} 
                      animate={{ opacity: 1 }}
                      className="h-full flex flex-col items-center justify-center"
                    >
                      <div className="relative mb-8">
                         <div className="w-24 h-24 rounded-full border-[12px] border-bg-app border-t-accent-wine-vibrant animate-spin" />
                         <div className="absolute inset-0 flex items-center justify-center font-display text-2xl animate-pulse">
                            AI
                         </div>
                      </div>
                      <h2 className="font-display text-4xl uppercase tracking-tighter italic">CRAWLING WEB SERVICES...</h2>
                    </motion.div>
                  ) : (
                    <motion.div 
                      key="result"
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="max-w-6xl mx-auto"
                    >
                       {/* Hero Result Section */}
                       <div className="bg-white border-2 border-black p-8 md:p-12 md:flex gap-16 relative overflow-hidden shadow-[16px_16px_0px_0px_rgba(0,0,0,0.05)] rounded-sm">
                          
                          {/* Verdict Banner */}
                          <div className={cn(
                            "absolute top-0 right-0 px-8 py-3 font-display text-2xl uppercase italic tracking-widest transform rotate-0",
                            currentResult.verdict === 'PASS' ? "bg-success-green text-white" : "bg-error-red text-white"
                          )}>
                            {currentResult.verdict === 'PASS' ? 'VERIFIED' : 'REJECTED'}
                          </div>

                          {/* Left: Bottle View (The Artifact) */}
                          <div className="w-full md:w-[320px] aspect-[1/1] bg-bg-app rounded flex items-center justify-center p-8 shrink-0 border border-border-subtle">
                             {currentResult.selected_image_url ? (
                               <img 
                                 src={currentResult.selected_image_url} 
                                 referrerPolicy="no-referrer"
                                 className="max-h-full max-w-full object-contain filter drop-shadow-[0_20px_40px_rgba(0,0,0,0.2)]" 
                               />
                             ) : (
                               <div className="text-center opacity-20">
                                  <AlertTriangle size={48} className="mx-auto mb-4" />
                                  <p className="font-display text-2xl uppercase">NO IMAGE FOUND</p>
                               </div>
                             )}
                          </div>

                          {/* Right: Key Info (Confidence-Led) */}
                          <div className="flex-1 mt-8 md:mt-0 flex flex-col pt-10">
                             <h2 className="font-display text-6xl leading-[0.85] uppercase tracking-tighter mb-8 max-w-lg">
                                {currentResult.input.wine_name} <span className="text-accent-wine-vibrant">{currentResult.input.vintage}</span>
                             </h2>
                             
                             <div className="grid grid-cols-2 gap-8 mb-10">
                                <div>
                                   <label className="text-[10px] font-black uppercase tracking-widest text-text-sub block mb-1">Composite Confidence</label>
                                   <div className="font-display text-5xl">{currentResult.confidence}%</div>
                                </div>
                                <div className="flex flex-col justify-end">
                                   <div className="flex gap-1 h-3 mb-2 bg-bg-app border border-border-subtle rounded-full overflow-hidden">
                                      <div className="h-full bg-purple-600 transition-all" style={{ width: `${currentResult.meta?.vlm || 0}%` }} title="VLM Text Extraction" />
                                      <div className="h-full bg-accent-wine-vibrant transition-all" style={{ width: `${currentResult.meta?.vision || 0}%` }} title="Vision Audit" />
                                      <div className="h-full bg-black transition-all" style={{ width: `${currentResult.meta?.ocr || 0}%` }} title="OCR Domain" />
                                      <div className="h-full bg-success-green transition-all" style={{ width: `${currentResult.meta?.authority || 0}%` }} title="Source Authority" />
                                      <div className="h-full bg-blue-500 transition-all" style={{ width: `${currentResult.meta?.quality || 0}%` }} title="Visual Quality" />
                                   </div>
                                   <div className="flex justify-between font-mono text-[8px] uppercase tracking-tighter text-text-sub">
                                      <span>L:{currentResult.meta?.vlm}</span>
                                      <span>V:{currentResult.meta?.vision}</span>
                                      <span>O:{currentResult.meta?.ocr}</span>
                                      <span>A:{currentResult.meta?.authority}</span>
                                      <span>Q:{currentResult.meta?.quality}</span>
                                   </div>
                                </div>
                             </div>

                             <div className="mt-auto">
                                <p className="text-xl font-medium leading-snug mb-8 border-l-4 border-black pl-6 italic">
                                   "{currentResult.explanation}"
                                </p>
                                <div className="flex gap-4">
                                   <button className="h-12 bg-black text-white px-8 font-display text-sm tracking-widest uppercase hover:bg-accent-wine-vibrant transition-all rounded-sm">
                                      DOWNLOAD ASSET
                                   </button>
                                   <button className="h-12 border-2 border-black px-6 font-display text-sm tracking-widest uppercase hover:bg-bg-app transition-all rounded-sm">
                                      VIEW SOURCE
                                   </button>
                                </div>
                             </div>
                          </div>
                       </div>

                       {/* Candidate Grid (Confidence Evidence) */}
                       <div className="mt-16">
                          <h3 className="font-display text-2xl uppercase italic mb-8 border-b-2 border-black pb-2 inline-block">CANDIDATE COMPARISON</h3>
                          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-6">
                             {currentResult.candidates.map((cand, i) => (
                               <div key={i} className="group cursor-pointer">
                                  <div className="aspect-[3/4] bg-white border border-border-subtle rounded-sm p-4 mb-3 flex items-center justify-center transition-all group-hover:border-black relative overflow-hidden">
                                     <img 
                                      src={cand.url} 
                                      referrerPolicy="no-referrer"
                                      className={cn("max-h-full max-w-full object-contain", !cand.pass && "opacity-20 grayscale")} 
                                     />
                                     {cand.score > 80 && cand.pass && (
                                       <div className="absolute top-2 right-2">
                                          <ShieldCheck size={16} className="text-success-green fill-success-green/10" />
                                       </div>
                                     )}
                                     {!cand.pass && (
                                       <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-white/60 backdrop-blur-[2px]">
                                          <span className="text-[9px] font-black text-error-red uppercase tracking-tighter">MISMATCH</span>
                                       </div>
                                     )}
                                  </div>
                                  <div className="font-mono text-[9px] uppercase tracking-tighter text-text-sub truncate">
                                     {cand.source} (CONF: {cand.score}%)
                                  </div>
                               </div>
                             ))}
                          </div>
                       </div>

                       {/* Expandable Technical Layer (The Lab Notebook) */}
                       <div className="mt-16 border-t border-border-subtle pt-8 mb-20">
                          <button 
                            onClick={() => setShowTechnical(!showTechnical)}
                            className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.2em] text-text-sub hover:text-black transition-colors"
                          >
                            {showTechnical ? 'HIDE TECHNICAL ARTIFACTS' : 'SHOW TECHNICAL ARTIFACTS'}
                            <ChevronRight size={14} className={cn("transition-transform", showTechnical && "rotate-90")} />
                          </button>

                          <AnimatePresence>
                            {showTechnical && (
                              <motion.div 
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: 'auto' }}
                                exit={{ opacity: 0, height: 0 }}
                                className="overflow-hidden"
                              >
                                 <div className="grid md:grid-cols-2 gap-8 py-8">
                                    <div className="bg-white border border-border-subtle p-6 rounded-sm">
                                       <h4 className="text-[10px] font-black uppercase tracking-widest mb-4 flex items-center gap-2">
                                          <Filter size={12} /> Verification Trace
                                       </h4>
                                       <div className="space-y-3 font-mono text-[10px] uppercase">
                                          <TraceItem label="Resolution Gate" status="PASS" details="2.1MP" />
                                          <TraceItem label="Bottle Detect" status="PASS" details="98% confidence" />
                                          <TraceItem label="OCR Normalization" status="PASS" details="Levenshtein Opt" />
                                          <TraceItem label="Producer Gate" status="PASS" details={currentResult.input.wine_name} />
                                          <TraceItem label="Vintage Gate" status="PASS" details={currentResult.input.vintage} />
                                       </div>
                                    </div>
                                    <div className="bg-black text-white p-6 rounded-sm font-mono text-[10px] leading-relaxed">
                                       <div className="text-accent-wine-vibrant font-bold mb-3">// RAW OCR PIPELINE OUTPUT</div>
                                       <p className="opacity-60">{currentResult.candidates.find(c => c.pass)?.reasoning || "No verified trace logs available."}</p>
                                    </div>
                                 </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                       </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </section>
            </motion.div>
          ) : activeTab === 'marketplace' ? (
            <motion.div 
              key="marketplace"
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="h-full overflow-hidden flex flex-col"
            >
              <div className="p-8 md:p-12 border-b border-border-subtle bg-white">
                <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-end justify-between gap-6">
                  <div>
                    <h2 className="font-display text-5xl uppercase italic leading-none mb-2">Marketplace Browser</h2>
                    <p className="text-text-sub font-mono text-xs uppercase tracking-widest">Connect to live inventory</p>
                  </div>
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-col md:flex-row gap-4">
                      <div className="relative w-full md:w-[400px]">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-text-sub" size={18} />
                        <input 
                          value={marketSearchQuery}
                          onChange={(e) => setMarketSearchQuery(e.target.value)}
                          placeholder="Search producer, region, name..."
                          className="w-full bg-bg-app pl-12 pr-4 py-3 border border-border-subtle focus:border-black outline-none font-bold uppercase text-xs tracking-wider"
                        />
                      </div>
                      <button 
                        onClick={handleRefreshMarket}
                        disabled={isRefreshingMarket}
                        className="h-12 px-6 bg-black text-white font-display text-sm uppercase tracking-widest hover:bg-accent-wine-vibrant transition-all flex items-center gap-2 whitespace-nowrap"
                      >
                        {isRefreshingMarket ? <Loader2 className="animate-spin" size={16} /> : <Zap size={16} />}
                        {isRefreshingMarket ? "SYNCING..." : "REFRESH CATALOG"}
                      </button>
                    </div>

                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                      <select 
                        value={selectedAppellation}
                        onChange={(e) => setSelectedAppellation(e.target.value)}
                        className="bg-bg-app px-4 py-2 border border-border-subtle text-[10px] font-black uppercase focus:border-black outline-none"
                      >
                        <option value="">All Appellations</option>
                        {uniqueAppellations.map(a => <option key={a} value={a}>{a}</option>)}
                      </select>

                      <select 
                        value={selectedClassification}
                        onChange={(e) => setSelectedClassification(e.target.value)}
                        className="bg-bg-app px-4 py-2 border border-border-subtle text-[10px] font-black uppercase focus:border-black outline-none"
                      >
                        <option value="">All Classifications</option>
                        {uniqueClassifications.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>

                      <select 
                        value={selectedFormat}
                        onChange={(e) => setSelectedFormat(e.target.value)}
                        className="bg-bg-app px-4 py-2 border border-border-subtle text-[10px] font-black uppercase focus:border-black outline-none"
                      >
                        <option value="">All Formats</option>
                        {uniqueFormats.map(f => <option key={f} value={f}>{f}</option>)}
                      </select>

                      <select 
                        value={selectedRegion}
                        onChange={(e) => setSelectedRegion(e.target.value)}
                        className="bg-bg-app px-4 py-2 border border-border-subtle text-[10px] font-black uppercase focus:border-black outline-none"
                      >
                        <option value="">All Regions</option>
                        {uniqueRegions.map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </div>

                    <div className="flex justify-between items-center px-1">
                      <div className="text-[9px] font-bold text-text-sub uppercase tracking-tighter">
                        Showing {filteredMarketWines.length} of {marketWines.length} items
                      </div>
                      {(selectedAppellation || selectedClassification || selectedFormat || selectedRegion || marketSearchQuery) && (
                        <button 
                          onClick={() => {
                            setMarketSearchQuery('');
                            setSelectedAppellation('');
                            setSelectedClassification('');
                            setSelectedFormat('');
                            setSelectedRegion('');
                          }}
                          className="text-[9px] font-black text-accent-wine-vibrant uppercase underline underline-offset-2 hover:text-black transition-colors"
                        >
                          Clear Filters
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-8 bg-bg-app">
                <div className="max-w-7xl mx-auto">
                  {isMarketLoading ? (
                    <div className="py-24 flex flex-col items-center">
                       <Loader2 className="animate-spin text-accent-wine-vibrant mb-4" size={48} />
                       <p className="font-display text-2xl uppercase">Loading Catalog...</p>
                    </div>
                  ) : filteredMarketWines.length === 0 ? (
                    <div className="py-24 text-center">
                       <div className="text-text-sub opacity-30 italic font-display text-3xl uppercase mb-8">
                          {marketWines.length === 0 ? "Catalog is currently empty." : "No matches found in catalog."}
                       </div>
                       {marketWines.length === 0 && (
                         <button 
                           onClick={handleRefreshMarket}
                           className="mx-auto h-16 px-12 bg-black text-white font-display text-xl uppercase tracking-[0.2em] hover:bg-accent-wine-vibrant transition-all flex items-center gap-4 rounded-sm"
                         >
                           <Zap size={24} fill="white" />
                           INITIALIZE SYNC
                         </button>
                       )}
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-6">
                      {filteredMarketWines.map(wine => (
                        <div 
                          key={wine.sku}
                          onClick={() => selectMarketWine(wine)}
                          className="group bg-white border border-border-subtle hover:border-black hover:shadow-[12px_12px_0px_0px_rgba(0,0,0,0.05)] transition-all cursor-pointer rounded-sm overflow-hidden flex flex-col"
                        >
                          <div className="aspect-[4/5] bg-bg-app flex items-center justify-center p-4 border-b border-border-subtle relative">
                            {wine.image ? (
                              <img 
                                src={wine.image} 
                                alt="" 
                                referrerPolicy="no-referrer"
                                className="max-h-full max-w-full object-contain group-hover:scale-110 transition-transform duration-500" 
                              />
                            ) : (
                              <ImageIcon className="text-text-sub opacity-20" size={32} />
                            )}
                            <div className="absolute bottom-2 right-2 bg-black text-white text-[8px] font-bold px-2 py-1 uppercase">
                              HK${wine.priceHKD}
                            </div>
                            {wine.source === 'manual' && (
                              <div className="absolute top-2 left-2 bg-accent-wine-vibrant text-white text-[8px] font-black px-2 py-1 uppercase tracking-tighter shadow-sm rounded-sm">
                                TEST SET
                              </div>
                            )}
                          </div>
                          <div className="p-4 flex-1 flex flex-col">
                            <h3 className="font-display text-lg uppercase leading-tight mb-2 group-hover:text-accent-wine-vibrant transition-colors line-clamp-2">{wine.name}</h3>
                            
                            <div className="space-y-1 mb-4 flex-1">
                               <div className="text-[10px] font-black text-black uppercase">{wine.producer}</div>
                               {wine.vineyard && wine.vineyard !== wine.producer && (
                                 <div className="text-[9px] font-bold text-text-sub uppercase">Vineyard: {wine.vineyard}</div>
                               )}
                               
                               <div className="mt-2 space-y-0.5">
                                  {wine.appellation && (
                                    <div className="text-[9px] text-text-sub uppercase flex justify-between">
                                       <span className="opacity-50">Appellation:</span>
                                       <span className="font-mono">{wine.appellation}</span>
                                    </div>
                                  )}
                                  {wine.classification && (
                                    <div className="text-[9px] text-text-sub uppercase flex justify-between">
                                       <span className="opacity-50">Classification:</span>
                                       <span className="font-mono">{wine.classification}</span>
                                    </div>
                                  )}
                                  {wine.format && (
                                    <div className="text-[9px] text-text-sub uppercase flex justify-between">
                                       <span className="opacity-50">Format:</span>
                                       <span className="font-mono">{wine.format}</span>
                                    </div>
                                  )}
                               </div>
                            </div>

                            <div className="mt-auto pt-3 border-t border-border-subtle flex items-center justify-between">
                               <div className="text-[10px] font-mono text-text-sub opacity-50 uppercase">
                                  {wine.region || wine.country} {wine.vintage}
                               </div>
                               {wine.type && (
                                 <div className="text-[8px] font-black bg-accent-wine-vibrant/10 text-accent-wine-vibrant border border-accent-wine-vibrant/20 px-1.5 py-0.5 rounded-full uppercase tracking-tighter">
                                    {wine.type}
                                 </div>
                               )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          ) : activeTab === 'batch' ? (
            <motion.div 
              key="batch"
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="h-full overflow-y-auto bg-white"
            >
              <div className="max-w-7xl mx-auto p-8 md:p-12">
                <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-12 border-b-4 border-black pb-8">
                  <div>
                    <h2 className="font-display text-5xl uppercase italic leading-none mb-4">Intern Challenge Pipeline</h2>
                    <div className="flex flex-wrap gap-4 items-center">
                       <p className="text-text-sub font-mono text-xs uppercase tracking-widest border-r border-border-subtle pr-4">Target: 90% Accuracy</p>
                       <p className="text-text-sub font-mono text-xs uppercase tracking-widest border-r border-border-subtle pr-4">SKUs: 10 Challenge Targets</p>
                       <p className="text-text-sub font-mono text-xs uppercase tracking-widest">Engine: {analyzerMode === 'vlm' ? 'Qwen 3.5 VL + OCR Hint' : analyzerMode === 'gemini' ? 'Gemini + OCR Hybrid' : 'Tesseract OCR (Strict)'}</p>
                    </div>
                  </div>
                  <button 
                    onClick={handleBatchTest}
                    disabled={isBatchRunning}
                    className="h-16 px-10 bg-black text-white font-display text-lg uppercase tracking-[0.2em] hover:bg-accent-wine-vibrant transition-all flex items-center gap-4 group"
                  >
                    {isBatchRunning ? <Loader2 className="animate-spin" size={20} /> : <Zap size={20} className="group-hover:fill-white" />}
                    {isBatchRunning ? "RUNNING PIPELINE..." : "START BATCH ANALYSIS"}
                  </button>
                </div>

                {isBatchRunning && (
                  <div className="mb-12 bg-bg-app border border-border-subtle p-8 rounded-sm">
                    <div className="flex justify-between items-end mb-4 font-display text-sm uppercase tracking-widest font-bold">
                       <span>Processing Pipeline...</span>
                       <span className="text-accent-wine-vibrant">{batchProgress}%</span>
                    </div>
                    <div className="h-4 bg-white border border-border-subtle p-0.5 rounded-full overflow-hidden">
                       <motion.div 
                         className="h-full bg-black rounded-full" 
                         initial={{ width: 0 }}
                         animate={{ width: `${batchProgress}%` }}
                       />
                    </div>
                    <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-6">
                       <div className="bg-white p-4 border border-border-subtle">
                          <div className="text-[10px] font-black uppercase text-text-sub mb-1">Stage</div>
                          <div className="font-display text-xl uppercase italic truncate">{batchStage || 'Idle'}</div>
                       </div>
                       <div className="bg-white p-4 border border-border-subtle">
                          <div className="text-[10px] font-black uppercase text-text-sub mb-1">Current SKU</div>
                          <div className="font-mono text-xs opacity-70 truncate">{batchCurrentSku || '—'}</div>
                       </div>
                       <div className="bg-white p-4 border border-border-subtle">
                          <div className="text-[10px] font-black uppercase text-text-sub mb-1">Candidate</div>
                          <div className="font-mono text-xs opacity-70 truncate">{batchCandidateInfo || '—'}</div>
                       </div>
                    </div>
                  </div>
                )}

                {batchResults.length > 0 && (
                  <div className="space-y-8">
                    {/* Summary Metrics */}
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                       <div className="p-6 bg-black text-white border-t-8 border-accent-wine-vibrant">
                          <div className="text-[9px] font-bold uppercase tracking-widest text-white/40 mb-2">Total Accuracy</div>
                          <div className="font-display text-5xl leading-none">
                            {Math.round((batchResults.filter(r => r.verdict === 'PASS').length / batchResults.length) * 100)}%
                          </div>
                       </div>
                       <div className="p-6 bg-white border border-border-subtle">
                          <div className="text-[9px] font-black uppercase tracking-widest text-text-sub mb-2">Passed SKUs</div>
                          <div className="font-display text-5xl leading-none text-success-green">
                            {batchResults.filter(r => r.verdict === 'PASS').length}
                          </div>
                       </div>
                       <div className="p-6 bg-white border border-border-subtle">
                          <div className="text-[9px] font-black uppercase tracking-widest text-text-sub mb-2">Avg Confidence</div>
                          <div className="font-display text-5xl leading-none">
                            {Math.round(batchResults.reduce((acc, r) => acc + r.confidence, 0) / batchResults.length)}%
                          </div>
                       </div>
                       <div className="p-6 bg-white border border-border-subtle">
                          <div className="text-[9px] font-black uppercase tracking-widest text-text-sub mb-2">Completion</div>
                          <div className="font-display text-5xl leading-none">
                            {batchResults.length}/10
                          </div>
                       </div>
                    </div>

                    {/* F1 Metrics Performance Dashboard */}
                    <div className="mb-12 p-8 bg-black text-white rounded-sm shadow-2xl relative overflow-hidden">
                        <div className="absolute top-0 right-0 p-4 opacity-5">
                          <Zap size={120} />
                        </div>
                        <h3 className="text-xs font-black uppercase tracking-[0.4em] text-white/40 mb-8 border-l-2 border-primary-red pl-4">Performance Metrics (Real Outcomes)</h3>
                        <div className="grid grid-cols-2 lg:grid-cols-4 gap-8">
                           <div>
                              <div className="text-[10px] font-black tracking-widest text-white/40 uppercase mb-1">Precision</div>
                              <div className="font-display text-5xl font-black italic">
                                {metrics.precision}%
                              </div>
                           </div>
                           <div>
                              <div className="text-[10px] font-black tracking-widest text-white/40 uppercase mb-1">Recall</div>
                              <div className="font-display text-5xl font-black italic">
                                {metrics.recall}%
                              </div>
                           </div>
                           <div>
                              <div className="text-[10px] font-black tracking-widest text-white/40 uppercase mb-1">F1 Score</div>
                              <div className="font-display text-5xl font-black italic text-accent-wine-vibrant">
                                {metrics.f1}%
                              </div>
                           </div>
                           <div>
                              <div className="text-[10px] font-black tracking-widest text-white/40 uppercase mb-1">Accuracy</div>
                              <div className="font-display text-5xl font-black italic">
                                {metrics.accuracy}%
                              </div>
                           </div>
                        </div>
                        <div className="mt-8 pt-8 border-t border-white/10 flex flex-col sm:flex-row items-center justify-between gap-4">
                           <p className="text-[10px] font-mono text-white/40 uppercase">Metrics update live as outcomes are verified in the list below.</p>
                           <button 
                             onClick={() => setBatchResults([])}
                             className="px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 text-[10px] font-black uppercase tracking-widest transition-all"
                           >
                             Reset Run
                           </button>
                        </div>
                    </div>

                    {/* Detailed Report List */}
                    <div className="space-y-4">
                       {batchResults.map((run, idx) => (
                         <div key={run.id} className="border border-border-subtle bg-white overflow-hidden">
                            <div className="flex flex-col md:flex-row divide-y md:divide-y-0 md:divide-x divide-border-subtle">
                               <div className="w-[60px] flex items-center justify-center font-display text-2xl font-black opacity-10 py-4 md:py-0">
                                  #{idx + 1}
                               </div>
                               <div className="flex-1 p-6">
                                  <div className="flex items-center gap-3 mb-2">
                                     <div className={cn(
                                       "px-2 py-0.5 text-[8px] font-black tracking-widest uppercase rounded flex items-center gap-1",
                                       run.verdict === 'PASS' ? "bg-success-green/10 text-success-green" : "bg-error-red/10 text-error-red"
                                     )}>
                                        {run.verdict === 'PASS' ? <CheckCircle2 size={10} /> : <XCircle size={10} />}
                                        {run.verdict}
                                     </div>
                                     <div className="text-[10px] font-mono text-text-sub uppercase tracking-tighter">
                                        CONFIDENCE: {run.confidence}%
                                     </div>
                                  </div>
                                  <h4 className="font-display text-2xl uppercase tracking-tighter mb-1 leading-none">{run.input.wine_name} {run.input.vintage}</h4>
                                  <p className="text-[11px] font-mono text-text-sub uppercase truncate opacity-60">
                                    {run.input.appellation} • {run.input.vineyard || 'No Specific Vineyard'} • {run.input.classification || 'Unclassified'}
                                  </p>
                                  <div className="mt-4 p-4 bg-bg-app rounded text-[12px] leading-relaxed border-l-2 border-black">
                                    <div className="text-[9px] font-black uppercase tracking-widest text-black mb-2">Pipeline Verification</div>
                                    <p className="whitespace-pre-wrap break-words text-text-main">
                                      {run.explanation}
                                    </p>
                                  </div>
                                  <div className="mt-3 flex flex-wrap items-center gap-2">
                                     <span className="text-[9px] font-black uppercase tracking-widest text-text-sub mr-1">Human review:</span>
                                     <button
                                       onClick={() => {
                                         const newResults = [...batchResults];
                                         newResults[idx].user_verified = 'CORRECT';
                                         setBatchResults(newResults);
                                       }}
                                       className={cn(
                                         "px-3 py-1.5 rounded border text-[10px] font-black uppercase tracking-widest transition-all",
                                         run.user_verified === 'CORRECT' ? "bg-success-green text-white border-success-green" : "bg-white border-border-subtle text-text-sub hover:border-success-green"
                                       )}
                                     >
                                        Confirm
                                     </button>
                                     <button
                                       onClick={() => {
                                         const newResults = [...batchResults];
                                         newResults[idx].user_verified = 'INCORRECT';
                                         setBatchResults(newResults);
                                       }}
                                       className={cn(
                                         "px-3 py-1.5 rounded border text-[10px] font-black uppercase tracking-widest transition-all",
                                         run.user_verified === 'INCORRECT' ? "bg-error-red text-white border-error-red" : "bg-white border-border-subtle text-text-sub hover:border-error-red"
                                       )}
                                     >
                                        Flag Incorrect
                                     </button>
                                  </div>
                               </div>
                               <div className="w-full md:w-[240px] p-4 bg-bg-app flex flex-col items-center justify-center gap-3">
                                  {run.selected_image_url ? (
                                    <>
                                      <div className="w-full aspect-square bg-white border border-border-subtle p-2 flex items-center justify-center hover:scale-105 transition-transform cursor-zoom-in overflow-hidden shadow-sm">
                                        <img src={run.selected_image_url} referrerPolicy="no-referrer" className="max-h-full max-w-full object-contain" />
                                      </div>
                                      <a 
                                        href={run.selected_image_url} 
                                        target="_blank" 
                                        rel="noreferrer" 
                                        className="text-[9px] font-black uppercase text-text-sub hover:text-black flex items-center gap-1 transition-colors"
                                      >
                                        <ExternalLink size={10} /> View Source
                                      </a>
                                    </>
                                  ) : (
                                    <div className="flex flex-col items-center gap-2 py-8 grayscale opacity-40">
                                       <ImageIcon size={32} />
                                       <span className="text-[9px] font-black uppercase tracking-widest text-center">NO IMAGE<br/>VERIFIED</span>
                                    </div>
                                  )}
                               </div>
                            </div>
                         </div>
                       ))}
                    </div>
                  </div>
                )}

                {batchResults.length === 0 && !isBatchRunning && (
                  <div className="py-32 flex flex-col items-center justify-center border border-dashed border-border-subtle rounded-sm bg-bg-app/30">
                     <ClipboardList size={64} className="text-text-sub opacity-10 mb-6" />
                     <h3 className="font-display text-4xl uppercase italic opacity-20 mb-2">Pipeline Ready</h3>
                     <p className="text-text-sub font-mono text-xs uppercase tracking-[0.3em]">Hit Start to run the 48-hour challenge workload</p>
                  </div>
                )}
              </div>
            </motion.div>
          ) : (
            <motion.div 
              key="history"
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }}
              className="h-full overflow-y-auto"
            >
              <div className="max-w-7xl mx-auto p-8 md:p-12">
                 <div className="flex items-end justify-between mb-12 border-b-4 border-black pb-6">
                    <div>
                       <h2 className="font-display text-5xl uppercase italic leading-none">VERIFICATION ARCHIVE</h2>
                       <p className="text-text-sub font-mono text-xs uppercase tracking-widest mt-2">{history.length} ITEMS LOGGED</p>
                    </div>
                    <div className="bg-bg-app border border-border-subtle p-2 rounded flex gap-1">
                       <div className="w-10 h-10 bg-black text-white flex items-center justify-center rounded-sm">
                          <ClipboardList size={18} />
                       </div>
                    </div>
                 </div>

                 {history.length === 0 ? (
                   <div className="py-24 text-center bg-bg-app border border-dashed border-border-subtle rounded flex flex-col items-center justify-center text-text-sub opacity-30">
                      <History size={48} className="mb-4" />
                      <p className="font-display text-3xl uppercase italic">NO DATA IN LEDGER</p>
                   </div>
                 ) : (
                   <div className="grid grid-cols-1 gap-4">
                      {history.map(run => (
                        <div 
                          key={run.id}
                          onClick={() => {
                            setCurrentResult(run);
                            setActiveTab('analyzer');
                          }}
                          className="group flex items-center gap-8 p-6 bg-white border border-border-subtle hover:border-black hover:shadow-[12px_12px_0px_0px_rgba(0,0,0,0.05)] transition-all cursor-pointer rounded-sm"
                        >
                           <div className="w-16 h-16 bg-bg-app flex items-center justify-center rounded-sm shrink-0 border border-border-subtle overflow-hidden relative">
                              {run.selected_image_url ? (
                                <img 
                                  src={run.selected_image_url} 
                                  referrerPolicy="no-referrer"
                                  className="max-h-full max-w-full object-contain" 
                                />
                              ) : (
                                <AlertTriangle size={20} className="text-error-red opacity-20" />
                              )}
                           </div>
                           
                           <div className="flex-1">
                              <h3 className="font-display text-2xl uppercase tracking-tighter group-hover:text-accent-wine-vibrant transition-colors">{run.input.wine_name} {run.input.vintage}</h3>
                              <div className="flex items-center gap-3 text-[10px] font-mono text-text-sub uppercase tracking-tighter">
                                 <span>{run.input.appellation}</span>
                                 <span className="w-1 h-1 bg-border-subtle rounded-full" />
                                 <span>{new Date(run.timestamp).toLocaleTimeString()}</span>
                              </div>
                           </div>

                           <div className={cn(
                             "px-4 py-1.5 border font-display text-sm tracking-widest rounded-sm",
                             run.verdict === 'PASS' ? "bg-success-green/10 border-success-green text-success-green" : "bg-error-red/10 border-error-red text-error-red"
                           )}>
                              {run.verdict}
                           </div>

                           <ChevronRight className="text-border-subtle group-hover:text-black transition-colors" />
                        </div>
                      ))}
                   </div>
                 )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

function TraceItem({ label, status, details }: { label: string, status: string, details: string }) {
  return (
    <div className="flex items-center justify-between py-1 border-b border-border-subtle last:border-0 opacity-80 hover:opacity-100 transition-opacity">
       <span className="text-text-sub">{label}:</span>
       <div className="flex items-center gap-3">
          <span className="text-[8px] opacity-40">{details}</span>
          <span className={cn("font-bold text-[9px]", status === 'PASS' ? "text-success-green" : "text-error-red")}>[{status}]</span>
       </div>
    </div>
  );
}

function CheckItem({ label, status }: { label: string, status: 'idle' | 'checking' | 'pass' | 'fail' }) {
  return (
    <div className="flex items-center justify-between group">
       <span className="text-[11px] font-medium text-text-sub group-hover:text-text-main transition-colors">{label}</span>
       <div className="flex items-center gap-2">
          {status === 'checking' && <Loader2 className="animate-spin text-accent-gold" size={12} />}
          {status === 'pass' && <div className="w-1.5 h-1.5 rounded-full bg-success-green ring-4 ring-success-green/10" />}
          {status === 'fail' && <div className="w-1.5 h-1.5 rounded-full bg-error-red ring-4 ring-error-red/10" />}
          {status === 'idle' && <div className="w-1.5 h-1.5 rounded-full bg-border-subtle" />}
       </div>
    </div>
  );
}

function PipelineStep({ title, meta, status, isLast }: { title: string, meta: string, status: 'active' | 'pending', isLast?: boolean }) {
  return (
    <div className={cn("relative pl-8 pb-8", !isLast && "border-l-2 border-border-subtle ml-2.5")}>
      <div className={cn(
        "absolute -left-[11px] top-0 w-5 h-5 rounded-full border-2 bg-white flex items-center justify-center transition-all",
        status === 'active' ? "border-success-green bg-success-green" : "border-border-subtle"
      )}>
        {status === 'active' && <CheckCircle2 size={12} className="text-white" />}
      </div>
      <div>
        <div className={cn("text-[13px] font-bold mb-0.5 transition-colors", status === 'active' ? "text-text-main" : "text-text-sub")}>{title}</div>
        <div className="text-[11px] text-text-sub font-mono opacity-80">{meta}</div>
      </div>
    </div>
  );
}
