import fs from 'fs/promises';
import path from 'path';

export interface Wine {
  id: string;
  sku: string;
  name: string;
  vintage?: string;
  producer: string;           // Vineyard / Producer
  vineyard?: string;
  appellation?: string;
  classification?: string;
  format?: string;
  region?: string;
  country?: string;
  priceHKD: number;
  type?: string;
  image?: string;
  url?: string;
  stock?: number;
  source?: string;            // 'vinobuzz' or 'manual'
}

// ==================== ALL 10 TEST SKUs (Complete) ====================
const TEST_SKUS: Wine[] = [
  {
    id: 'test1',
    sku: 'TEST001',
    name: "Domaine Rossignol-Trapet Latricieres-Chambertin Grand Cru",
    vintage: "2017",
    producer: "Domaine Rossignol-Trapet",
    vineyard: undefined,
    appellation: "Latricières-Chambertin Grand Cru",
    classification: "Grand Cru",
    format: "750ml",
    region: "Burgundy",
    country: "France",
    priceHKD: 2850,
    type: "Red",
    image: undefined,
    url: undefined,
    stock: 0,
    source: "manual"
  },
  {
    id: 'test2',
    sku: 'TEST002',
    name: "Domaine Arlaud Morey-St-Denis 'Monts Luisants' 1er Cru",
    vintage: "2019",
    producer: "Domaine Arlaud",
    vineyard: undefined,
    appellation: "Morey-St-Denis 'Monts Luisants' 1er Cru",
    classification: "1er Cru",
    format: "750ml",
    region: "Burgundy",
    country: "France",
    priceHKD: 1250,
    type: "Red",
    image: undefined,
    url: undefined,
    stock: 0,
    source: "manual"
  },
  {
    id: 'test3',
    sku: 'TEST003',
    name: "Domaine Taupenot-Merme Charmes-Chambertin Grand Cru",
    vintage: "2018",
    producer: "Domaine Taupenot-Merme",
    vineyard: undefined,
    appellation: "Charmes-Chambertin Grand Cru",
    classification: "Grand Cru",
    format: "750ml",
    region: "Burgundy",
    country: "France",
    priceHKD: 2450,
    type: "Red",
    image: undefined,
    url: undefined,
    stock: 0,
    source: "manual"
  },
  {
    id: 'test4',
    sku: 'TEST004',
    name: "Château Fonroque Saint-Émilion Grand Cru Classé",
    vintage: "2016",
    producer: "Château Fonroque",
    vineyard: undefined,
    appellation: "Saint-Émilion Grand Cru Classé",
    classification: "Grand Cru Classé",
    format: "750ml",
    region: "Bordeaux",
    country: "France",
    priceHKD: 980,
    type: "Red",
    image: undefined,
    url: undefined,
    stock: 0,
    source: "manual"
  },
  {
    id: 'test5',
    sku: 'TEST005',
    name: "Eric Rodez Cuvée des Crayères Blanc de Noirs",
    vintage: "NV",
    producer: "Eric Rodez",
    vineyard: undefined,
    appellation: "Champagne",
    classification: undefined,
    format: "750ml",
    region: "Champagne",
    country: "France",
    priceHKD: 890,
    type: "Sparkling",
    image: undefined,
    url: undefined,
    stock: 0,
    source: "manual"
  },
  {
    id: 'test6',
    sku: 'TEST006',
    name: "Domaine du Tunnel Cornas 'Vin Noir'",
    vintage: "2018",
    producer: "Domaine du Tunnel",
    vineyard: undefined,
    appellation: "Cornas",
    classification: undefined,
    format: "750ml",
    region: "Northern Rhône",
    country: "France",
    priceHKD: 1150,
    type: "Red",
    image: undefined,
    url: undefined,
    stock: 0,
    source: "manual"
  },
  {
    id: 'test7',
    sku: 'TEST007',
    name: "Poderi Colla Barolo 'Bussia Dardi Le Rose'",
    vintage: "2016",
    producer: "Poderi Colla",
    vineyard: undefined,
    appellation: "Barolo",
    classification: "DOCG",
    format: "750ml",
    region: "Piedmont",
    country: "Italy",
    priceHKD: 1350,
    type: "Red",
    image: undefined,
    url: undefined,
    stock: 0,
    source: "manual"
  },
  {
    id: 'test8',
    sku: 'TEST008',
    name: "Arnot-Roberts Trousseau Gris Watson Ranch",
    vintage: "2020",
    producer: "Arnot-Roberts",
    vineyard: "Watson Ranch",
    appellation: "Sonoma Coast",
    classification: undefined,
    format: "750ml",
    region: "Sonoma",
    country: "USA",
    priceHKD: 920,
    type: "White",
    image: undefined,
    url: undefined,
    stock: 0,
    source: "manual"
  },
  {
    id: 'test9',
    sku: 'TEST009',
    name: "Brokenwood Graveyard Vineyard Shiraz",
    vintage: "2015",
    producer: "Brokenwood",
    vineyard: "Graveyard Vineyard",
    appellation: "Hunter Valley",
    classification: undefined,
    format: "750ml",
    region: "Hunter Valley",
    country: "Australia",
    priceHKD: 1680,
    type: "Red",
    image: undefined,
    url: undefined,
    stock: 0,
    source: "manual"
  },
  {
    id: 'test10',
    sku: 'TEST010',
    name: "Domaine Weinbach Riesling 'Clos des Capucins' Vendanges Tardives",
    vintage: "2017",
    producer: "Domaine Weinbach",
    vineyard: "Clos des Capucins",
    appellation: "Alsace",
    classification: "Vendanges Tardives",
    format: "750ml",
    region: "Alsace",
    country: "France",
    priceHKD: 1050,
    type: "White",
    image: undefined,
    url: undefined,
    stock: 0,
    source: "manual"
  }
];

const BASE_URL = 'https://vinobuzz.ai';

async function fetchWithAuth(url: string, sessionId?: string): Promise<any> {
  const headers: HeadersInit = {
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
    'Referer': 'https://vinobuzz.ai/',
  };
  if (sessionId) headers['Cookie'] = `session_id=${sessionId}`;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function scrapeAllWines(maxPages = 80): Promise<Wine[]> {
  const SESSION_ID = process.env.VINOBUZZ_SESSION_ID;
  const allWines: Wine[] = [];
  let page = 0;
  const pageSize = 60;

  console.log('🚀 Scraping VinoBuzz and merging 10 Test SKUs...');

  while (page < maxPages) {
    const url = `${BASE_URL}/api/v1/store/skus/search?page=${page}&page_size=${pageSize}&sort=name_asc&ai_search=true`;
    try {
      const data = await fetchWithAuth(url, SESSION_ID);
      const items = data?.data?.skus || data?.skus || data?.results || [];

      if (!Array.isArray(items) || items.length === 0) break;

      console.log(`📄 Page ${page}: ${items.length} wines`);

      items.forEach((w: any) => {
        allWines.push({
          id: w.id || w.sku,
          sku: w.sku,
          name: w.name || w.title || '',
          vintage: w.vintage?.toString() || undefined,
          producer: w.producer || w.winery || w.vineyard || 'Unknown Producer',
          vineyard: w.vineyard || w.estate,
          appellation: w.appellation || w.subregion || w.designation || w.climat,
          classification: w.classification || w.cru || w.grade || w.level,
          format: w.format || w.bottle_size || w.size || '750ml',
          region: w.region,
          country: w.country || 'France',
          priceHKD: parseFloat(w.price || w.price_hkd || '0'),
          type: w.type || w.category,
          image: w.image || w.image_url,
          url: w.url,
          stock: w.stock || 0,
          source: 'vinobuzz'
        });
      });

      page++;
      await new Promise(r => setTimeout(r, 700));
    } catch (err: any) {
      console.error(`Error on page ${page}:`, err.message);
      break;
    }
  }

  // Merge Test SKUs (override if SKU conflict)
  const wineMap = new Map(allWines.map(w => [w.sku, w]));
  TEST_SKUS.forEach(testWine => {
    wineMap.set(testWine.sku, testWine);
  });

  const finalWines = Array.from(wineMap.values());

  const publicDataDir = path.join(process.cwd(), 'public', 'data');
  await fs.mkdir(publicDataDir, { recursive: true });
  const outputPath = path.join(publicDataDir, 'wines.json');
  await fs.writeFile(outputPath, JSON.stringify(finalWines, null, 2));

  console.log(`✅ Complete! ${finalWines.length} wines saved (${allWines.length} from VinoBuzz + 10 Test SKUs)`);
  return finalWines;
}
