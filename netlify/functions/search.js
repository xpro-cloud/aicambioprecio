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
        catch(e) { reject(new Error('Invalid JSON: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function extractPrice(text) {
  const cleaned = text.replace(/\./g, '').replace(/,/g, '.');
  const patterns = [
    /\$\s*([\d]{4,}(?:\.\d{1,2})?)/g,
  ];
  const prices = [];
  for (const pattern of patterns) {
    for (const m of [...cleaned.matchAll(pattern)]) {
      const p = parseFloat(m[1]);
      if (p > 5000 && p < 100000000) prices.push(Math.round(p));
    }
  }
  return prices.length > 0 ? Math.min(...prices) : 0;
}

// Verificar si un título coincide con al menos N palabras del query
function titleMatchesQuery(title, query, minWords) {
  const queryWords = query.toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2);
  const titleLower = title.toLowerCase();
  const matches = queryWords.filter(w => titleLower.includes(w)).length;
  return matches >= Math.min(minWords, queryWords.length);
}

function isNavigationPage(title) {
  if (/\(\d+\)$/.test(title.trim())) return false;
  if (title.split(' ').length < 3) return false;
  const lower = title.toLowerCase();
  const bad = ['ver todo', 'todos los', 'bienvenidos', 'inicio', 'home', 'todas las guitarras', 'instrumentos de cuerdas', 'mejores precios siempre'];
  return !bad.some(w => lower.includes(w));
}

async function serpSearch(q, serpKey) {
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q)}&api_key=${serpKey}&num=10&gl=ar&hl=es`;
  console.log('SerpApi:', q);
  const data = await httpsGet(url);
  console.log('Results:', data.organic_results?.length || 0, data.error || '');
  return data.organic_results || [];
}

async function searchSite(query, site, serpKey, minWords) {
  const hostname = new URL(site.url).hostname;

  // Búsqueda con las primeras 3-4 palabras clave entre comillas para mayor precisión
  const keywords = query.split(/\s+/).filter(w => w.length > 2).slice(0, 4).join(' ');
  const searchQuery = `site:${hostname} "${keywords}"`;

  let items = await serpSearch(searchQuery, serpKey);

  // Si no hay resultados con comillas, intentar sin
  if (!items.length) {
    items = await serpSearch(`site:${hostname} ${keywords}`, serpKey);
  }

  if (!items.length) return { found: false, products: [] };

  const products = items
    .filter(item => isNavigationPage(item.title))
    .filter(item => titleMatchesQuery(item.title, query, minWords))
    .map(item => {
      const text = (item.title || '') + ' ' + (item.snippet || '');
      const price = extractPrice(text);
      return {
        title: item.title.replace(/\s*[-|·].*$/, '').trim(),
        price,
        currency: 'ARS',
        url: item.link,
        condition: 'Nuevo'
      };
    })
    .filter(p => p.title.length > 2)
    .slice(0, 5);

  return { found: products.length > 0, products };
}

async function searchML(query, serpKey, minWords) {
  const keywords = query.split(/\s+/).filter(w => w.length > 2).slice(0, 4).join(' ');
  const searchQuery = `site:mercadolibre.com.ar "${keywords}" -funda -mueble -soporte -correa -estuche`;

  const items = await serpSearch(searchQuery, serpKey);
  if (!items.length) return { found: false, products: [] };

  const products = items
    .filter(item => isNavigationPage(item.title))
    .filter(item => titleMatchesQuery(item.title, query, minWords))
    .filter(item => {
      const lower = item.title.toLowerCase();
      return !['funda', 'mueble', 'soporte', 'correa', 'estuche'].some(w => lower.startsWith(w));
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
    .slice(0, 5);

  return { found: products.length > 0, products };
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let parsed;
  try { parsed = JSON.parse(event.body || '{}'); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid body' }) }; }

  const { query, site, minWords = 3 } = parsed;
  const serpKey = process.env.SERP_API_KEY;

  console.log('Query:', query, '| Site:', site?.name, '| minWords:', minWords);

  if (!query || !site) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Faltan parametros' }) };
  }

  if (!serpKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'SERP_API_KEY no configurada' }) };
  }

  try {
    const result = site.isML
      ? await searchML(query, serpKey, minWords)
      : await searchSite(query, site, serpKey, minWords);

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
