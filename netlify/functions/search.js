const https = require('https');

function httpsGet(url, asText) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'es-AR,es;q=0.9'
      }
    };
    const req = https.request(options, (res) => {
      // Follow redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        return httpsGet(res.headers.location, asText).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (asText) return resolve(data);
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Invalid JSON: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// Extraer precio y nombre del producto desde ar.xprostore.com
async function getXproProduct(sku) {
  const url = `https://ar.xprostore.com/${sku}`;
  console.log('Fetching Xpro:', url);
  try {
    const html = await httpsGet(url, true);

    // Extraer nombre del producto
    let name = '';
    const h1Match = html.match(/<h1[^>]*class="[^"]*product[^"]*"[^>]*>([^<]+)<\/h1>/i)
                 || html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    if (h1Match) name = h1Match[1].trim();

    // Extraer precio — buscar patrones de precio en el HTML
    let price = 0;
    const pricePatterns = [
      /class="[^"]*price[^"]*"[^>]*>\s*\$\s*([\d.,]+)/i,
      /"price"[^>]*>\s*\$\s*([\d.,]+)/i,
      /itemprop="price"[^>]*content="([\d.,]+)"/i,
      /\$\s*([\d]{1,3}(?:[.,][\d]{3})+)/g,
    ];

    for (const pattern of pricePatterns) {
      const match = html.match(pattern);
      if (match) {
        const raw = match[1].replace(/[.,]/g, '');
        const p = parseInt(raw);
        if (p > 1000 && p < 100000000) {
          price = p;
          break;
        }
      }
    }

    // Si no encontró precio con patrones específicos, buscar el primero válido
    if (!price) {
      const allPrices = [...html.matchAll(/\$\s*([\d]{1,3}(?:[.,][\d]{3})+)/g)];
      for (const m of allPrices) {
        const p = parseInt(m[1].replace(/[.,]/g, ''));
        if (p > 10000 && p < 100000000) { price = p; break; }
      }
    }

    console.log('Xpro product:', name, '| price:', price);
    return { name, price, url, found: !!(name || price) };
  } catch(e) {
    console.log('Xpro fetch error:', e.message);
    return { name: '', price: 0, url, found: false };
  }
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
  const bad = ['ver todo', 'todos los', 'bienvenidos', 'inicio', 'home page', 'mejores precios siempre', 'distribuidor oficial'];
  return !bad.some(w => lower.includes(w));
}

async function serpSearch(searchQuery, serpKey) {
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(searchQuery)}&api_key=${serpKey}&num=8&gl=ar&hl=es`;
  console.log('SerpApi:', searchQuery);
  const data = await httpsGet(url, false);
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
    .slice(0, 6);

  return { found: products.length > 0, products };
}

async function searchSite(query, site, serpKey) {
  const hostname = new URL(site.url).hostname;
  const searchQuery = `site:${hostname} ${query}`;
  const items = await serpSearch(searchQuery, serpKey);
  if (!items.length) return { found: false, products: [] };

  // Filtrar por palabras clave del query
  const keywords = query.toLowerCase().split(' ').filter(w => w.length > 3);
  
  const products = items
    .filter(item => isPageTitle(item.title))
    .filter(item => {
      const lower = item.title.toLowerCase();
      // Al menos 2 palabras clave deben estar en el título
      const matches = keywords.filter(k => lower.includes(k)).length;
      return matches >= Math.min(2, keywords.length);
    })
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

// NETLIFY
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let parsed;
  try { parsed = JSON.parse(event.body || '{}'); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid body' }) }; }

  const { query, sku, site } = parsed;
  const serpKey = process.env.SERP_API_KEY;

  // Si es una consulta especial para obtener el producto de Xpro
  if (site && site.id === 'xpro') {
    if (!sku) return { statusCode: 400, body: JSON.stringify({ error: 'SKU requerido' }) };
    const product = await getXproProduct(sku);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(product)
    };
  }

  const searchQuery = sku && sku.trim()
    ? `${query || ''}`.trim()
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
