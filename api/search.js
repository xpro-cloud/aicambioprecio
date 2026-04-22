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

function normalizeModel(str) {
  return str.replace(/[\s\-_]/g, '').toLowerCase();
}

function extractModel(query) {
  const match = query.match(/\b([A-Z]{1,6}[\s\-]?[\d]{2,}[\w\s\-]*|[\d]{2,}[\s\-]?[A-Z]{1,6}[\w\s\-]*)\b/i);
  return match ? match[1].trim() : null;
}

function titleMatchesModel(title, model) {
  if (!model) return true;
  return normalizeModel(title).includes(normalizeModel(model));
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

const ACCESSORY_WORDS = ['funda', 'mueble', 'soporte', 'cable ', 'fuente ', 'adaptador', 'pedal ', 'atril', 'bolso', 'mochila', 'correa'];

function isAccessory(title) {
  const lower = title.toLowerCase();
  return ACCESSORY_WORDS.some(w => lower.startsWith(w.trim()));
}

async function searchML(query, model) {
  const url = `https://api.mercadolibre.com/sites/MLA/search?q=${encodeURIComponent(query)}&limit=20&sort=relevance`;
  const data = await httpsGet(url);

  if (!data.results || data.results.length === 0) {
    console.log('ML API no results or error:', data.error || data.message);
    return { found: false, products: [] };
  }

  console.log('ML API raw results:', data.results.length);

  // Filtrar con stock disponible
  let results = data.results.filter(p => p.available_quantity > 0);
  console.log('ML after stock filter:', results.length);

  // Filtrar accesorios
  const noAccessory = results.filter(p => !isAccessory(p.title));
  if (noAccessory.length > 0) results = noAccessory;
  console.log('ML after accessory filter:', results.length);

  // Filtrar por modelo — solo si quedan resultados después
  if (model) {
    const withModel = results.filter(p => titleMatchesModel(p.title, model));
    console.log('ML after model filter:', withModel.length);
    if (withModel.length > 0) results = withModel;
    // Si no queda nada con el modelo, usar los sin accesorios igual
  }

  const products = results.slice(0, 6).map(p => ({
    title: p.title,
    price: Math.round(p.price),  // precio directo de ML API — siempre disponible
    currency: p.currency_id,
    url: p.permalink,
    seller: p.seller?.nickname || '',
    condition: p.condition === 'new' ? 'Nuevo' : 'Usado'
  }));

  console.log('ML final products:', products.length, products[0]?.title, products[0]?.price);
  return { found: products.length > 0, products };
}

async function searchSite(query, model, site, serpKey) {
  const hostname = new URL(site.url).hostname;
  const modelVariant = model ? model.replace(/([A-Za-z])(\d)/g, '$1-$2') : null;

  // Intento 1: búsqueda exacta con modelo entre comillas
  let searchQuery = modelVariant
    ? `site:${hostname} "${modelVariant}"`
    : `site:${hostname} "${query}"`;

  let url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(searchQuery)}&api_key=${serpKey}&num=6&gl=ar&hl=es`;
  console.log('SerpApi exact:', site.name, '|', searchQuery);
  let data = await httpsGet(url);
  console.log('SerpApi exact', site.name, ':', data.organic_results?.length || 0, 'results');

  // Intento 2: sin comillas si no hay resultados
  if (!data.organic_results?.length) {
    searchQuery = model
      ? `site:${hostname} ${model}`
      : `site:${hostname} ${query}`;
    url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(searchQuery)}&api_key=${serpKey}&num=6&gl=ar&hl=es`;
    console.log('SerpApi loose:', site.name, '|', searchQuery);
    data = await httpsGet(url);
    console.log('SerpApi loose', site.name, ':', data.organic_results?.length || 0, 'results');
  }

  if (data.error || !data.organic_results?.length) return { found: false, products: [] };

  let items = data.organic_results.filter(item => isProductTitle(item.title));

  // Aplicar filtro de modelo solo si quedan resultados
  if (model) {
    const withModel = items.filter(item => titleMatchesModel(item.title, model));
    if (withModel.length > 0) items = withModel;
  }

  const products = items
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

  try {
    let result;
    if (site.isML) {
      result = await searchML(searchQuery, model);
    } else {
      if (!serpKey) return res.status(500).json({ error: 'SERP_API_KEY no configurada' });
      result = await searchSite(searchQuery, model, site, serpKey);
    }
    return res.status(200).json(result);
  } catch(e) {
    console.error('Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
