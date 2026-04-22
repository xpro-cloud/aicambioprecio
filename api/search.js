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

function buildSearchQuery(hostname, model, fullQuery) {
  if (!model) return hostname ? `site:${hostname} "${fullQuery}"` : `"${fullQuery}"`;
  const withDash = model.replace(/([A-Za-z])(\d)/g, '$1-$2').replace(/(\d)([A-Za-z])/g, '$1-$2');
  const brand = fullQuery.replace(new RegExp(model.replace(/[-\s]/g, '[\\s\\-]?'), 'gi'), '').trim();
  const sitePrefix = hostname ? `site:${hostname} ` : '';
  return brand ? `${sitePrefix}"${withDash}" ${brand}` : `${sitePrefix}"${withDash}"`;
}

async function searchML(query, model, serpKey) {
  const url = `https://api.mercadolibre.com/sites/MLA/search?q=${encodeURIComponent(query)}&limit=10&sort=relevance`;
  try {
    const data = await httpsGet(url);
    if (data.results && data.results.length > 0) {
      let results = data.results;
      if (model) {
        const filtered = results.filter(p => titleMatchesModel(p.title, model));
        if (filtered.length > 0) results = filtered;
      }
      const products = results.slice(0, 6).map(p => ({
        title: p.title,
        price: Math.round(p.price),
        currency: p.currency_id,
        url: p.permalink,
        seller: p.seller?.nickname || '',
        condition: p.condition === 'new' ? 'Nuevo' : 'Usado'
      }));
      return { found: true, products };
    }
  } catch(e) {
    console.log('ML API error:', e.message);
  }

  // Fallback SerpApi
  const searchQuery = buildSearchQuery('mercadolibre.com.ar', model, query);
  const serpUrl = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(searchQuery)}&api_key=${serpKey}&num=8&gl=ar&hl=es`;
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
  const data = await httpsGet(url);
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

// VERCEL - sintaxis diferente a Netlify
module.exports = async function(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { query, sku, site } = req.body || {};
  const serpKey = process.env.SERP_API_KEY;

  const searchQuery = sku && sku.trim() ? `${sku.trim()} ${query || ''}`.trim() : query;
  const model = sku && sku.trim() ? sku.trim() : extractModel(query || '');

  console.log('Query:', searchQuery, '| Model:', model, '| Site:', site?.name);

  if (!searchQuery || !site) {
    return res.status(400).json({ error: 'Faltan parametros' });
  }

  try {
    let result;
    if (site.isML) {
      result = await searchML(searchQuery, model, serpKey);
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
