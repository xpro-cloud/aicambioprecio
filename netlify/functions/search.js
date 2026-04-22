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

async function serpSearch(searchQuery, serpKey) {
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(searchQuery)}&api_key=${serpKey}&num=8&gl=ar&hl=es`;
  console.log('SerpApi:', searchQuery);
  const data = await httpsGet(url);
  console.log('Results:', data.organic_results?.length || 0, '| error:', data.error || 'none');
  if (data.error || !data.organic_results?.length) return [];
  return data.organic_results;
}

async function searchML(query, serpKey) {
  const searchQuery = `site:mercadolibre.com.ar ${query} -funda -mueble -soporte -correa -estuche`;
  const items = await serpSearch(searchQuery, serpKey);
  if (!items.length) return { found: false, products: [] };

  const products = items
    .filter(item => isPageTitle(item.title))
    .filter(item => {
      const lower = item.title.toLowerCase();
      return !lower.startsWith('funda') && !lower.startsWith('mueble') &&
             !lower.startsWith('soporte') && !lower.startsWith('correa') &&
             !lower.startsWith('estuche');
    })
    .map(item => {
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

async function searchSite(query, site, serpKey) {
  const hostname = new URL(site.url).hostname;
  const searchQuery = `site:${hostname} ${query}`;
  const items = await serpSearch(searchQuery, serpKey);
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

// NETLIFY - sintaxis correcta
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let parsed;
  try { parsed = JSON.parse(event.body || '{}'); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid body' }) }; }

  const { query, sku, site } = parsed;
  const serpKey = process.env.SERP_API_KEY;

  const searchQuery = sku && sku.trim()
    ? `${sku.trim()} ${query || ''}`.trim()
    : (query || '');

  console.log('Query:', searchQuery, '| Site:', site?.name);

  if (!searchQuery || !site) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Faltan parametros' }) };
  }

  if (!serpKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'SERP_API_KEY no configurada' }) };
  }

  try {
    let result;
    if (site.isML) {
      result = await searchML(searchQuery, serpKey);
    } else {
      result = await searchSite(searchQuery, site, serpKey);
    }
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
