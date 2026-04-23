const https = require('https');
const http = require('http');

function httpGet(url, maxBytes) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const lib = urlObj.protocol === 'https:' ? https : http;
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'es-AR,es;q=0.9',
      }
    };
    const req = lib.request(options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location;
        if (loc) return httpGet(loc.startsWith('http') ? loc : `${urlObj.origin}${loc}`, maxBytes).then(resolve).catch(reject);
      }
      let data = '';
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        data += chunk;
        if (maxBytes && bytes > maxBytes) { req.destroy(); resolve(data); }
      });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

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
        catch(e) { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function extractPrice(text) {
  const prices = [];
  const arPattern = /\$\s*([\d]{1,3}(?:\.[\d]{3})+(?:,\d{1,2})?)/g;
  for (const m of [...text.matchAll(arPattern)]) {
    const p = Math.round(parseFloat(m[1].replace(/\./g, '').replace(',', '.')));
    if (p > 5000 && p < 100000000) prices.push(p);
  }
  if (!prices.length) {
    for (const m of [...text.matchAll(/\$\s*([\d]{5,})/g)]) {
      const p = parseInt(m[1]);
      if (p > 5000 && p < 100000000) prices.push(p);
    }
  }
  return prices.length > 0 ? Math.min(...prices) : 0;
}

// Extraer precio directo del HTML de una página de producto
async function fetchPriceFromPage(url) {
  try {
    console.log('Fetching page for price:', url);
    const html = await httpGet(url, 150000); // leer solo los primeros 150KB

    // Buscar precio en meta tags (más confiable)
    const metaPrice = html.match(/itemprop="price"[^>]*content="([\d.,]+)"/i) ||
                      html.match(/"price"\s*:\s*"?([\d.,]+)"?/);
    if (metaPrice) {
      const p = Math.round(parseFloat(metaPrice[1].replace(/\./g, '').replace(',', '.')));
      if (p > 5000 && p < 100000000) {
        console.log('Price from meta:', p);
        return p;
      }
    }

    // Buscar en el HTML completo
    const price = extractPrice(html);
    console.log('Price from HTML:', price);
    return price;
  } catch(e) {
    console.log('fetchPriceFromPage error:', e.message);
    return 0;
  }
}

function extractModel(query) {
  const match = query.match(/\b([A-Z]{1,5}[\d]{2,}[A-Z\d\-]*|[\d]{2,}[A-Z]{1,5}[\w\-]*)\b/i);
  return match ? match[1] : null;
}

function normalizeStr(s) { return s.toLowerCase().replace(/[-\s]/g, ''); }

function titleContainsModel(title, model) {
  if (!model) return true;
  return normalizeStr(title).includes(normalizeStr(model));
}

function titleMatchesQuery(title, query, minWords) {
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const lower = title.toLowerCase();
  return words.filter(w => lower.includes(w)).length >= Math.min(minWords, words.length);
}

function isNavPage(title) {
  if (/\(\d+\)$/.test(title.trim())) return false;
  if (title.split(' ').length < 3) return false;
  const lower = title.toLowerCase();
  const bad = ['ver todo', 'todos los', 'bienvenidos', 'todas las guitarras', 'instrumentos de cuerdas', 'mejores precios siempre'];
  return !bad.some(w => lower.includes(w));
}

async function serpSearch(q, serpKey) {
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q)}&api_key=${serpKey}&num=10&gl=ar&hl=es`;
  console.log('SerpApi:', q);
  const data = await httpsGet(url);
  console.log('Results:', data.organic_results?.length || 0, data.error || '');
  return data.organic_results || [];
}

async function searchML(query, serpKey) {
  const model = extractModel(query);
  const searchQ = model
    ? `site:mercadolibre.com.ar "${model}" -funda -mueble -soporte -correa`
    : `site:mercadolibre.com.ar "${query}" -funda -mueble -soporte`;

  const items = await serpSearch(searchQ, serpKey);
  if (!items.length) return { found: false, products: [] };

  const products = items
    .filter(item => isNavPage(item.title))
    .filter(item => !['funda','mueble','soporte','correa','estuche'].some(w => item.title.toLowerCase().startsWith(w)))
    .filter(item => titleContainsModel(item.title, model))
    .filter(item => item.link && !item.link.includes('/s?'))
    .map(item => {
      const richPrice = item.rich_snippet?.top?.detected_extensions?.price ||
                        item.rich_snippet?.bottom?.detected_extensions?.price || 0;
      const price = richPrice > 0 ? Math.round(richPrice)
                  : extractPrice((item.title||'') + ' ' + (item.snippet||''));
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

async function searchSite(query, site, serpKey) {
  const hostname = new URL(site.url).hostname;
  const model = extractModel(query);

  const searchQ = model ? `site:${hostname} "${model}"` : `site:${hostname} "${query.split(' ').slice(0,4).join(' ')}"`;
  let items = await serpSearch(searchQ, serpKey);

  if (!items.length) {
    const fallQ = model ? `site:${hostname} ${model}` : `site:${hostname} ${query.split(' ').slice(0,3).join(' ')}`;
    items = await serpSearch(fallQ, serpKey);
  }

  if (!items.length) return { found: false, products: [] };

  const filtered = items
    .filter(item => isNavPage(item.title))
    .filter(item => {
      const hasModel = model ? titleContainsModel(item.title, model) : false;
      const hasWords = titleMatchesQuery(item.title, query, 2);
      return hasModel || hasWords;
    });

  if (!filtered.length) return { found: false, products: [] };

  // Para cada resultado, intentar obtener el precio de la página directamente
  const products = await Promise.all(filtered.slice(0, 4).map(async item => {
    const richPrice = item.rich_snippet?.top?.detected_extensions?.price ||
                      item.rich_snippet?.bottom?.detected_extensions?.price || 0;
    let price = richPrice > 0 ? Math.round(richPrice)
              : extractPrice((item.title||'') + ' ' + (item.snippet||''));

    // Si no hay precio en snippet, hacer fetch a la página
    if (!price && item.link) {
      price = await fetchPriceFromPage(item.link);
    }

    return {
      title: item.title.replace(/\s*[-|·].*$/, '').trim(),
      price,
      currency: 'ARS',
      url: item.link,
      condition: 'Nuevo'
    };
  }));

  return {
    found: products.length > 0,
    products: products.filter(p => p.title.length > 2)
  };
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let parsed;
  try { parsed = JSON.parse(event.body || '{}'); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid body' }) }; }

  const { query, site } = parsed;
  const serpKey = process.env.SERP_API_KEY;

  const model = extractModel(query || '');
  console.log('Query:', query, '| Model:', model, '| Site:', site?.name);

  if (!query || !site) return { statusCode: 400, body: JSON.stringify({ error: 'Faltan parametros' }) };
  if (!serpKey) return { statusCode: 500, body: JSON.stringify({ error: 'SERP_API_KEY no configurada' }) };

  try {
    const result = site.isML
      ? await searchML(query, serpKey)
      : await searchSite(query, site, serpKey);
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  } catch(e) {
    console.error('Error:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
