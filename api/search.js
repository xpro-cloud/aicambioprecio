const https = require('https');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; XproMonitor/1.0)' }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Invalid JSON: ' + data.slice(0, 300))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function normalizeStr(str) {
  return str.replace(/[\s\-_]/g, '').toLowerCase();
}

function extractModel(query) {
  const match = query.match(/\b([A-Z]{1,6}[\s\-]?[\d]{2,}[\w\s\-]*|[\d]{2,}[\s\-]?[A-Z]{1,6}[\w\s\-]*)\b/i);
  return match ? match[1].trim() : null;
}

function extractPrice(text) {
  const patterns = [
    /\$\s*([\d]{1,3}(?:[.,][\d]{3})+)/g,
    /\$\s*([\d]{4,})/g,
  ];
  const prices = [];
  for (const pattern of patterns) {
    for (const m of [...text.matchAll(pattern)]) {
      const p = parseInt(m[1].replace(/[.,]/g, ''));
      if (p > 5000 && p < 100000000) prices.push(p);
    }
  }
  return prices.length > 0 ? Math.min(...prices) : 0;
}

function isPageTitle(title) {
  if (/\(\d+\)$/.test(title.trim())) return false;
  if (title.split(' ').length < 3) return false;
  const lower = title.toLowerCase();
  const bad = ['ver todo', 'todos los', 'bienvenidos', 'inicio', 'home page', 'mejores precios siempre', 'distribuidor oficial', 'tienda online'];
  return !bad.some(w => lower.includes(w));
}

const ACCESSORY_STARTS = ['funda ', 'mueble ', 'soporte ', 'atril ', 'bolso ', 'mochila ', 'correa ', 'estuche '];

function isAccessory(title) {
  const lower = title.toLowerCase();
  return ACCESSORY_STARTS.some(w => lower.startsWith(w));
}

async function searchViaSerpApi(searchQuery, serpKey, isML) {
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(searchQuery)}&api_key=${serpKey}&num=8&gl=ar&hl=es`;
  console.log('SerpApi:', searchQuery);
  const data = await httpsGet(url);
  console.log('SerpApi results:', data.organic_results?.length || 0, '| error:', data.error || 'none');
  if (data.error || !data.organic_results?.length) return [];
  return data.organic_results;
}

async function searchML(query, model, serpKey) {
  // Usar SerpApi para buscar en ML — más confiable que la API directa desde servidores
  const modelVariant = model ? model.replace(/([A-Za-z])(\d)/g, '$1-$2') : null;
  const searchQuery = modelVariant
    ? `site:mercadolibre.com.ar "${modelVariant}" -funda -mueble -soporte -correa`
    : `site:mercadolibre.com.ar "${query}" -funda -mueble -soporte -correa`;

  const items = await searchViaSerpApi(searchQuery, serpKey, true);
  if (!items.length) return { found: false, products: [] };

  const products = items
    .filter(item => isPageTitle(item.title) && !isAccessory(item.title))
    .map(item => {
      // Intentar extraer precio del rich snippet primero
      const richPrice = item.rich_snippet?.top?.detected_extensions?.price ||
                        item.rich_snippet?.bottom?.detected_extensions?.price || 0;
      const price = richPrice > 0
        ? Math.round(richPrice)
        : extractPrice((item.title || '') + ' ' + (item.snippet || ''));
      return {
        title: item.title.replace(/\s*[-|·]\s*Mercado.*$/i, '').trim(),
        price,
        currency: 'ARS',
        url: item.link,
        seller: item.displayed_link || '',
        condition: item.snippet?.toLowerCase().includes('usado') ? 'Usado' : 'Nuevo'
      };
    })
    .filter(p => p.title.length > 2)
    .slice(0, 6);

  return { found: products.length > 0, products };
}

async function searchSite(query, model, site, serpKey) {
  const hostname = new URL(site.url).hostname;
  const modelVariant = model ? model.replace(/([A-Za-z])(\d)/g, '$1-$2') : null;

  // Intento 1: modelo entre comillas
  let searchQuery = modelVariant
    ? `site:${hostname} "${modelVariant}"`
    : `site:${hostname} "${query}"`;

  let items = await searchViaSerpApi(searchQuery, serpKey, false);

  // Intento 2: sin comillas si no hay resultados
  if (!items.length) {
    searchQuery = model
      ? `site:${hostname} ${model}`
      : `site:${hostname} ${query}`;
    items = await searchViaSerpApi(searchQuery, serpKey, false);
  }

  if (!items.length) return { found: false, products: [] };

  const products = items
    .filter(item => isPageTitle(item.title))
    .map(item => ({
      title: item.title.replace(/\s*[-|·].*$/, '').trim(),
      price: extractPrice((item.title || '') + ' ' + (item.snippet || '')),
      currency: 'ARS',
      url: item.link,
      seller: '',
      condition: 'Nuevo'
    }))
    .filter(p => p.title.length > 2)
    .slice(0, 6);

  return { found: products.length > 0, products };
}

// VERCEL
module.exports = async function(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { query, sku, site } = req.body || {};
  const serpKey = process.env.SERP_API_KEY;

  const searchQuery = sku && sku.trim()
    ? `${sku.trim()} ${query || ''}`.trim()
    : (query || '');
  const model = sku && sku.trim() ? sku.trim() : extractModel(query || '');

  console.log('Query:', searchQuery, '| Model:', model, '| Site:', site?.name);

  if (!searchQuery || !site) {
    return res.status(400).json({ error: 'Faltan parametros' });
  }

  if (!serpKey) {
    return res.status(500).json({ error: 'SERP_API_KEY no configurada' });
  }

  try {
    let result;
    if (site.isML) {
      result = await searchML(searchQuery, model, serpKey);
    } else {
      result = await searchSite(searchQuery, model, site, serpKey);
    }
    return res.status(200).json(result);
  } catch(e) {
    console.error('Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
