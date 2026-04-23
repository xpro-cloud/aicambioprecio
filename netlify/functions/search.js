const https = require('https');
const http = require('http');

function httpGet(url, maxBytes, asJson) {
  return new Promise((resolve, reject) => {
    try {
      const urlObj = new URL(url);
      const lib = urlObj.protocol === 'https:' ? https : http;
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': asJson ? 'application/json' : 'text/html,application/xhtml+xml,*/*;q=0.9',
          'Accept-Language': 'es-AR,es;q=0.9',
        }
      };
      const req = lib.request(options, (res) => {
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          const loc = res.headers.location;
          const next = loc.startsWith('http') ? loc : `${urlObj.origin}${loc}`;
          return httpGet(next, maxBytes, asJson).then(resolve).catch(reject);
        }
        let data = '';
        let bytes = 0;
        res.on('data', chunk => {
          bytes += chunk.length;
          data += chunk;
          if (maxBytes && bytes > maxBytes) { req.destroy(); resolve(asJson ? JSON.parse(data) : data); }
        });
        res.on('end', () => {
          if (asJson) { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } }
          else resolve(data);
        });
      });
      req.on('error', reject);
      req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    } catch(e) { reject(e); }
  });
}

function parseArgentinePrice(str) {
  const clean = str.trim();
  // Formato argentino: punto=miles, coma=centavos
  // "813.353,53"  -> tomar "813.353" -> 813353
  // "1.658.573,50" -> tomar "1.658.573" -> 1658573
  // "1.658.573" -> 1658573
  if (clean.includes(',')) {
    const [intPart, decPart] = clean.split(',');
    // Solo ignorar la parte decimal si son 1-2 dígitos (centavos)
    if (decPart && decPart.length <= 2) {
      return parseInt(intPart.replace(/\./g, ''));
    }
    // Si hay más dígitos después de la coma, tratar todo como entero
    return parseInt(clean.replace(/[.,]/g, ''));
  }
  // Sin coma — los puntos son separadores de miles
  return parseInt(clean.replace(/\./g, ''));
}

function isReasonablePrice(price, referencePrice) {
  if (!price || price <= 0) return false;
  if (price > 99000000) return false;
  if (!referencePrice) return price > 1000;
  // Aceptar precios entre 40% y 300% del precio de referencia
  // Esto evita cuotas (muy bajo) y errores de parsing (muy alto)
  const min = referencePrice * 0.40;
  const max = referencePrice * 3.00;
  return price >= min && price <= max;
}

function sanitizePrice(price, referencePrice) {
  if (!price) return 0;
  if (isReasonablePrice(price, referencePrice)) return price;
  // Intentar corregir precio corrido: dividir por 10, 100 hasta que sea razonable
  let corrected = price;
  for (let i = 0; i < 3; i++) {
    corrected = Math.round(corrected / 10);
    if (isReasonablePrice(corrected, referencePrice)) {
      console.log('Price corrected:', price, '->', corrected);
      return corrected;
    }
  }
  console.log('Price discarded:', price);
  return 0;
}

function extractPriceFromHtml(html) {
  const prices = [];

  // 1. Meta tags — más confiable
  const metaPatterns = [
    /itemprop="price"[^>]*content="([\d.,]+)"/i,
    /"price"\s*:\s*"([\d.,]+)"/,
    /data-price="([\d.,]+)"/i,
  ];
  for (const p of metaPatterns) {
    const m = html.match(p);
    if (m) {
      const val = parseArgentinePrice(m[1]);
      if (val > 5000 && val < 100000000) { prices.push(val); break; }
    }
  }

  if (!prices.length) {
    // Limpiar scripts y estilos
    let clean = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

    // Eliminar contextos de cuotas — buscar y borrar patrones tipo "9 x $123.456" o "en 12 cuotas"
    clean = clean.replace(/\d+\s*[xX×]\s*\$\s*[\d.,]+/g, '');
    clean = clean.replace(/en\s+\d+\s+cuotas?[^$<]{0,50}/gi, '');
    clean = clean.replace(/\d+\s*cuotas?\s*(sin|con)[^$<]{0,50}/gi, '');

    const arPattern = /\$\s*([\d]{1,3}(?:\.[\d]{3})+(?:,\d{1,2})?)/g;
    for (const m of [...clean.matchAll(arPattern)]) {
      const val = parseArgentinePrice(m[1]);
      if (val > 10000 && val < 100000000) prices.push(val);
    }
  }

  if (!prices.length) return 0;

  // Filtrar outliers:
  // 1. Descartar precios < 1000 (probablemente centavos o cuotas muy pequeñas)
  // 2. Descartar precios que son < 15% del precio máximo (cuotas individuales)
  const validPrices = prices.filter(p => p >= 1000);
  if (!validPrices.length) return 0;
  const maxP = Math.max(...validPrices);
  const filtered = validPrices.filter(p => p >= maxP * 0.15);
  return filtered.length > 0 ? Math.min(...filtered) : 0;
}

function extractPriceFromText(text) {
  const prices = [];
  const arPattern = /\$\s*([\d]{1,3}(?:\.[\d]{3})+(?:,\d{1,2})?)/g;
  for (const m of [...text.matchAll(arPattern)]) {
    const val = parseArgentinePrice(m[1]);
    if (val > 5000 && val < 100000000) prices.push(val);
  }
  return prices.length > 0 ? Math.min(...prices) : 0;
}

async function fetchPriceFromPage(url) {
  try {
    const html = await httpGet(url, 200000, false);
    const price = extractPriceFromHtml(html);
    console.log('Page price:', price, 'from', url.slice(0, 60));
    return price;
  } catch(e) {
    console.log('Fetch error:', e.message);
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
  const data = await httpGet(url, null, true);
  console.log('Results:', data.organic_results?.length || 0, data.error || '');
  return data.organic_results || [];
}

// ML via API oficial
async function searchML(query, serpKey) {
  const model = extractModel(query);
  const searchTerm = model || query;
  
  console.log('ML API search:', searchTerm);
  try {
    const url = `https://api.mercadolibre.com/sites/MLA/search?q=${encodeURIComponent(searchTerm)}&limit=10&sort=relevance`;
    const data = await httpGet(url, null, true);
    
    if (data.results && data.results.length > 0) {
      console.log('ML API results:', data.results.length);
      
      let results = data.results
        .filter(p => p.available_quantity > 0) // solo con stock
        .filter(p => !['funda','mueble','soporte','correa','estuche'].some(w => p.title.toLowerCase().startsWith(w)));

      // Filtrar por modelo si existe
      if (model) {
        const withModel = results.filter(p => titleContainsModel(p.title, model));
        if (withModel.length > 0) results = withModel;
      }

      const products = results.slice(0, 5).map(p => ({
        title: p.title,
        price: Math.round(p.price),
        currency: p.currency_id,
        url: p.permalink,
        seller: p.seller?.nickname || '',
        condition: p.condition === 'new' ? 'Nuevo' : 'Usado'
      }));

      if (products.length > 0) {
        console.log('ML API products:', products.length, products[0]?.title, products[0]?.price);
        return { found: true, products };
      }
    }
    console.log('ML API error or no results:', data.error || data.message);
  } catch(e) {
    console.log('ML API failed:', e.message);
  }

  // Fallback: SerpApi para ML
  console.log('ML fallback to SerpApi');
  const searchQ = model
    ? `site:mercadolibre.com.ar "${model}" -funda -mueble -soporte -correa`
    : `site:mercadolibre.com.ar "${query}" -funda -mueble -soporte`;

  const items = await serpSearch(searchQ, serpKey);
  if (!items.length) return { found: false, products: [] };

  const filtered = items
    .filter(item => isNavPage(item.title))
    .filter(item => !['funda','mueble','soporte','correa','estuche'].some(w => item.title.toLowerCase().startsWith(w)))
    .filter(item => titleContainsModel(item.title, model));

  const products = await Promise.all(filtered.slice(0, 4).map(async item => {
    const richPrice = item.rich_snippet?.top?.detected_extensions?.price ||
                      item.rich_snippet?.bottom?.detected_extensions?.price || 0;
    let price = richPrice > 0 ? Math.round(richPrice)
              : extractPriceFromText((item.title||'') + ' ' + (item.snippet||''));
    if (!price && item.link) price = await fetchPriceFromPage(item.link);
    return {
      title: item.title.replace(/\s*[-|·]\s*Mercado.*$/i, '').trim(),
      price,
      currency: 'ARS',
      url: item.link,
      seller: '',
      condition: 'Nuevo'
    };
  }));

  const valid = products.filter(p => p.title.length > 2 && p.price > 0);
  return { found: valid.length > 0, products: valid };
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

  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const filtered = items
    .filter(item => isNavPage(item.title))
    .filter(item => {
      const lower = item.title.toLowerCase();
      if (model) {
        // Si hay modelo alfanumérico, debe estar en el título
        return titleContainsModel(item.title, model);
      }
      // Sin modelo: exigir al menos 3 palabras del query en el título
      const matches = queryWords.filter(w => lower.includes(w)).length;
      return matches >= Math.min(3, queryWords.length);
    });

  if (!filtered.length) return { found: false, products: [] };

  const products = await Promise.all(filtered.slice(0, 4).map(async item => {
    const richPrice = item.rich_snippet?.top?.detected_extensions?.price ||
                      item.rich_snippet?.bottom?.detected_extensions?.price || 0;
    let price = richPrice > 0 ? Math.round(richPrice)
              : extractPriceFromText((item.title||'') + ' ' + (item.snippet||''));
    if (!price && item.link) price = await fetchPriceFromPage(item.link);
    return {
      title: item.title.replace(/\s*[-|·].*$/, '').trim(),
      price,
      currency: 'ARS',
      url: item.link,
      condition: 'Nuevo'
    };
  }));

  const valid = products.filter(p => p.title.length > 2);
  return { found: valid.length > 0, products: valid };
}

// Recibe referencePrice para sanitizar precios irreales
function postProcessProducts(products, referencePrice) {
  return products
    .map(p => ({
      ...p,
      price: sanitizePrice(p.price, referencePrice)
    }))
    .filter(p => {
      if (!p.price) return true; // sin precio lo mostramos igual (Ver precio)
      if (!referencePrice) return true;
      // Filtrar productos fuera del rango ±20% del precio Xpro
      // Salvo que sea mas barato (eso siempre se muestra como alerta)
      const ratio = p.price / referencePrice;
      // Mostrar si está entre 20% más barato y 120% más caro
      return ratio >= 0.20 && ratio <= 1.20;
    });
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  let parsed;
  try { parsed = JSON.parse(event.body || '{}'); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid body' }) }; }

  const { query, site, xproPrice } = parsed;
  const serpKey = process.env.SERP_API_KEY;
  const model = extractModel(query || '');
  console.log('Query:', query, '| Model:', model, '| Site:', site?.name);

  if (!query || !site) return { statusCode: 400, body: JSON.stringify({ error: 'Faltan parametros' }) };
  if (!serpKey) return { statusCode: 500, body: JSON.stringify({ error: 'SERP_API_KEY no configurada' }) };

  try {
    let result = site.isML
      ? await searchML(query, serpKey)
      : await searchSite(query, site, serpKey);
    
    // Sanitizar precios irreales usando el precio de Xpro como referencia
    if (result.products && xproPrice) {
      result = { ...result, products: postProcessProducts(result.products, xproPrice) };
    }
    
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  } catch(e) {
    console.error('Error:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
