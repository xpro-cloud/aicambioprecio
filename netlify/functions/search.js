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

// Normaliza un modelo: saca espacios y guiones -> "PSR-E473" = "PSRE473" = "PSR E473"
function normalizeModel(str) {
  return str.replace(/[\s\-_]/g, '').toLowerCase();
}

// Extrae el modelo del query (parte alfanumérica más específica)
function extractModel(query) {
  const match = query.match(/\b([A-Z]{1,6}[\s\-]?[\d]{2,}[\w\s\-]*|[\d]{2,}[\s\-]?[A-Z]{1,6}[\w\s\-]*)\b/i);
  return match ? match[1].trim() : null;
}

// Verifica si un título contiene el modelo en cualquiera de sus variantes
function titleMatchesModel(title, model) {
  if (!model) return true;
  const normalizedModel = normalizeModel(model);
  const normalizedTitle = normalizeModel(title);
  return normalizedTitle.includes(normalizedModel);
}

function extractPrice(text) {
  const patterns = [
    /\$\s*([\d]{1,3}(?:[.,][\d]{3})+)/g,
    /\$\s*([\d]{4,})/g,
  ];
  const prices = [];
  for (const pattern of patterns) {
    const matches = [...text.matchAll(pattern)];
    for (const m of matches) {
      const p = parseInt(m[1].replace(/[.,]/g, ''));
      if (p > 5000 && p < 100000000) prices.push(p);
    }
  }
  return prices.length > 0 ? Math.min(...prices) : 0;
}

function isProductTitle(title) {
  if (/\(\d+\)$/.test(title.trim())) return false;
  if (title.split(' ').length < 3) return false;
  const lower = title.toLowerCase();
  const bad = ['ver todo', 'todos los', 'bienvenidos', 'inicio', 'home page', 'mejores precios siempre', 'distribuidor oficial'];
  for (const w of bad) if (lower.includes(w)) return false;
  return true;
}

// Construye variantes del modelo para el query de búsqueda
// "PSRE473" -> busca "PSRE473" OR "PSR-E473" OR "PSR E473"
function buildSearchQuery(hostname, model, fullQuery) {
  if (!model) return hostname ? `site:${hostname} "${fullQuery}"` : `"${fullQuery}"`;
  
  const norm = normalizeModel(model);
  // Generar variantes insertando guión o espacio en puntos de letra-número
  const withDash = model.replace(/([A-Za-z])(\d)/g, '$1-$2').replace(/(\d)([A-Za-z])/g, '$1-$2');
  const withSpace = model.replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2');
  const noSep = norm.toUpperCase();
  
  // Deduplicar variantes
  const variants = [...new Set([model, withDash, withSpace, noSep])];
  
  // Usar la variante más simple entre comillas
  const bestVariant = variants[0];
  const brand = fullQuery.replace(new RegExp(model.replace(/[-]/g, '[\\s\\-]?'), 'gi'), '').trim();
  
  const sitePrefix = hostname ? `site:${hostname} ` : '';
  return brand
    ? `${sitePrefix}"${bestVariant}" ${brand}`
    : `${sitePrefix}"${bestVariant}"`;
}

async function searchML(query, model, serpKey) {
  // Intentar ML API directa
  const url = `https://api.mercadolibre.com/sites/MLA/search?q=${encodeURIComponent(query)}&limit=10&sort=relevance`;
  console.log('ML API:', url);
  try {
    const data = await httpsGet(url);
    if (data.results && data.results.length > 0) {
      let results = data.results;
      if (model) {
        const filtered = results.filter(p => titleMatchesModel(p.title, model));
        if (filtered.length > 0) results = filtered;
        console.log('ML filtered by model:', filtered.length, '/', data.results.length);
      }
      const products = results.slice(0, 6).map(p => ({
        title: p.title,
        price: Math.round(p.price),
        currency: p.currency_id,
        url: p.permalink,
        seller: p.seller?.nickname || '',
        condition: p.condition === 'new' ? 'Nuevo' : 'Usado'
      }));
      console.log('ML products:', products.length, products[0]?.title, products[0]?.price);
      return { found: true, products };
    }
  } catch(e) {
    console.log('ML API error:', e.message);
  }

  // Fallback SerpApi
  console.log('ML fallback SerpApi');
  const searchQuery = buildSearchQuery('mercadolibre.com.ar', model, query);
  const serpUrl = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(searchQuery)}&api_key=${serpKey}&num=8&gl=ar&hl=es`;
  console.log('SerpApi ML:', searchQuery);
  const data = await httpsGet(serpUrl);
  if (data.error || !data.organic_results?.length) return { found: false, products: [] };

  const products = data.organic_results
    .filter(item => isProductTitle(item.title) && titleMatchesModel(item.title, model))
    .map(item => ({
      title: item.title.replace(/\s*[-|·]\s*Mercado.*$/i, '').trim(),
      price: extractPrice((item.title || '') + ' ' + (item.snippet || '')),
      currency: 'ARS',
      url: item.link,
      seller: item.displayed_link || '',
      condition: 'Nuevo'
    }))
    .filter(p => p.title.length > 2)
    .slice(0, 6);

  return { found: products.length > 0, products };
}

async function searchSite(query, model, site, serpKey) {
  const hostname = new URL(site.url).hostname;
  const searchQuery = buildSearchQuery(hostname, model, query);
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(searchQuery)}&api_key=${serpKey}&num=6&gl=ar&hl=es`;
  console.log('SerpApi site:', site.name, '|', searchQuery);

  const data = await httpsGet(url);
  console.log('SerpApi', site.name, ':', data.organic_results?.length, 'results | error:', data.error);

  if (data.error || !data.organic_results?.length) return { found: false, products: [] };

  const products = data.organic_results
    .filter(item => isProductTitle(item.title) && titleMatchesModel(item.title, model))
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

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let parsed;
  try { parsed = JSON.parse(event.body || '{}'); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid body' }) }; }

  const { query, sku, site } = parsed;
  const serpKey = process.env.SERP_API_KEY;

  // Usar SKU si está disponible — más preciso
  const searchQuery = sku && sku.trim() ? `${sku.trim()} ${query}`.trim() : query;
  const model = sku && sku.trim() ? sku.trim() : extractModel(query);

  console.log('Query:', searchQuery, '| Model:', model, '| Site:', site?.name);

  if (!query || !site) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Faltan parametros' }) };
  }

  try {
    let result;
    if (site.isML) {
      result = await searchML(searchQuery, model, serpKey);
    } else {
      if (!serpKey) return { statusCode: 500, body: JSON.stringify({ error: 'SERP_API_KEY no configurada' }) };
      result = await searchSite(searchQuery, model, site, serpKey);
    }

    console.log('Final:', result.found, result.products?.length, 'products');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result)
    };
  } catch(e) {
    console.error('Error:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
