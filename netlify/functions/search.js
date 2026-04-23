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
  if (clean.includes(',')) {
    const [intPart, decPart] = clean.split(',');
    if (decPart && decPart.length <= 2) {
      return parseInt(intPart.replace(/\./g, ''));
    }
    return parseInt(clean.replace(/[.,]/g, ''));
  }
  return parseInt(clean.replace(/\./g, ''));
}

function isReasonablePrice(price, referencePrice) {
  if (!price || price <= 0) return false;
  if (price > 99000000) return false;
  if (!referencePrice) return price > 1000;
  const min = referencePrice * 0.30;
  const max = referencePrice * 4.00;
  return price >= min && price <= max;
}

function sanitizePrice(price, referencePrice) {
  if (!price) return 0;
  if (isReasonablePrice(price, referencePrice)) return price;
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
    let clean = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
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

async function checkMLItemStatus(link) {
  try {
    const match = link.match(/MLA-?(\d+)/i);
    if (!match) return { active: true, price: 0 };
    const itemId = 'MLA' + match[1];
    const apiUrl = `https://api.mercadolibre.com/items/${itemId}`;
    console.log('Checking ML item:', itemId);
    const data = await httpGet(apiUrl, null, true);
    if (data.error) { console.log('ML item API error:', data.error); return { active: false, price: 0 }; }
    const isActive = data.status === 'active' && data.available_quantity > 0;
    console.log('ML item', itemId, 'status:', data.status, 'active:', isActive);
    return { active: isActive, price: isActive ? Math.round(data.price || 0) : 0, title: data.title || '' };
  } catch(e) {
    console.log('ML item check error:', e.message);
    return { active: true, price: 0 };
  }
}

async function fetchPriceFromPage(url) {
  try {
    const html = await Promise.race([
      httpGet(url, 150000, false),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout 8s')), 8000))
    ]);
    const price = extractPriceFromHtml(html);
    console.log('Page price:', price, 'from', url.slice(0, 60));
    return price;
  } catch(e) {
    console.log('Fetch error:', e.message, 'for', url.slice(0, 60));
    return 0;
  }
}

function extractModel(query) {
  const match = query.match(/\b([A-Z]{1,5}[\d]{2,}[A-Z\d\-]*|[\d]{2,}[A-Z]{1,5}[\w\-]*)\b/i);
  return match ? match[1] : null;
}

function normalizeStr(s) {
  return s.toLowerCase()
    .replace(/[-\s_\.]/g, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function titleMatchesModel(title, modelStr) {
  if (!modelStr) return true;
  const titleNorm = normalizeStr(title);
  if (titleNorm.includes(normalizeStr(modelStr))) return true;
  const modelWords = modelStr.toLowerCase().split(/[\s\-_]+/).filter(w => w.length > 1);
  const titleLower = title.toLowerCase();
  return modelWords.every(w => titleLower.includes(w));
}

function titleContainsModel(title, model) {
  if (!model) return true;
  return normalizeStr(title).includes(normalizeStr(model));
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

async function searchML(query, serpKey, brand, modelField) {
  const model = extractModel(query);
  const searchTerm = brand ? `${brand} ${modelField || model || query}` : (model || query);

  console.log('ML API search:', searchTerm);
  try {
    const url = `https://api.mercadolibre.com/sites/MLA/search?q=${encodeURIComponent(searchTerm)}&limit=10&sort=relevance`;
    const data = await httpGet(url, null, true);

    if (data.results && data.results.length > 0) {
      console.log('ML API results:', data.results.length);
      let results = data.results
        .filter(p => p.available_quantity > 0)
        .filter(p => !['funda','mueble','soporte','correa','estuche'].some(w => p.title.toLowerCase().startsWith(w)));

      if (brand) {
        const withBrand = results.filter(p => normalizeStr(p.title).includes(normalizeStr(brand)));
        if (withBrand.length > 0) results = withBrand;
      }
      if (modelField) {
        const withModel = results.filter(p => titleMatchesModel(p.title, modelField));
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

  // Fallback SerpApi — solo URLs de producto directo, nunca listados
  console.log('ML fallback to SerpApi');
  const brandTerm = brand || '';
  const mlModelHasBrand = brand && normalizeStr(modelField || model || '').includes(normalizeStr(brand));
  const mlBrand = mlModelHasBrand ? '' : brandTerm;
  const serpQ = modelField
    ? `site:mercadolibre.com.ar ${mlBrand} "${modelField}" -funda -mueble -soporte -correa`.trim()
    : model
    ? `site:mercadolibre.com.ar ${mlBrand} "${model}" -funda -mueble -soporte -correa`.trim()
    : `site:mercadolibre.com.ar ${mlBrand} "${query}" -funda -mueble -soporte`.trim();

  const items = await serpSearch(serpQ, serpKey);
  if (!items.length) return { found: false, products: [] };

  const filtered = items
    .filter(item => isNavPage(item.title))
    .filter(item => !['funda','mueble','soporte','correa','estuche'].some(w => item.title.toLowerCase().startsWith(w)))
    .filter(item => !brand || normalizeStr(item.title).includes(normalizeStr(brand)))
    .filter(item => !modelField || titleMatchesModel(item.title, modelField))
    // FILTRO ESTRICTO: solo URLs de producto directo, nunca listados
    .filter(item => {
      const link = item.link || '';
      if (link.includes('listado.mercadolibre')) return false;
      if (link.includes('/s?')) return false;
      if (link.includes('_OrderId_')) return false;
      // Aceptar solo URLs con MLA en el path o articulo.mercadolibre
      return link.includes('-MLA') || link.includes('/p/MLA') || link.includes('articulo.mercadolibre');
    });

  const products = await Promise.all(filtered.slice(0, 4).map(async item => {
    const statusCheck = await checkMLItemStatus(item.link || '');
    if (!statusCheck.active) { console.log('ML item skipped (not active):', item.title); return null; }
    let price = statusCheck.price > 0 ? statusCheck.price : 0;
    if (!price) {
      const richPrice = item.rich_snippet?.top?.detected_extensions?.price ||
                        item.rich_snippet?.bottom?.detected_extensions?.price || 0;
      price = richPrice > 0 ? Math.round(richPrice)
            : extractPriceFromText((item.title||'') + ' ' + (item.snippet||''));
    }
    return {
      title: (statusCheck.title || item.title).replace(/\s*[-|·]\s*Mercado.*$/i, '').trim(),
      price,
      currency: 'ARS',
      url: item.link,
      seller: '',
      condition: 'Nuevo'
    };
  }));

  const valid = products.filter(p => p && p.title.length > 2 && p.price > 0);
  return { found: valid.length > 0, products: valid };
}

async function searchSite(query, site, serpKey, brand, modelField) {
  const hostname = new URL(site.url).hostname;
  const model = extractModel(query);
  const brandTerm = brand || '';

  // Evitar duplicar marca si ya está en el modelo o query
  const modelHasBrand = brand && normalizeStr(modelField || '').includes(normalizeStr(brand));
  const effectiveBrand = modelHasBrand ? '' : brandTerm;
  
  const searchQ = modelField
    ? `site:${hostname} ${effectiveBrand} "${modelField}"`.trim()
    : `site:${hostname} ${effectiveBrand} "${query.split(' ').slice(0,4).join(' ')}"`.trim();
  let items = await serpSearch(searchQ, serpKey);

  if (!items.length) {
    const fallQ = modelField
      ? `site:${hostname} ${effectiveBrand} ${modelField}`.trim()
      : `site:${hostname} ${effectiveBrand} ${query.split(' ').slice(0,3).join(' ')}`.trim();
    items = await serpSearch(fallQ, serpKey);
  }

  // Segundo fallback sin site: — útil para sitios que Google no indexa bien
  if (!items.length) {
    const domainQ = modelField
      ? `${hostname} ${effectiveBrand} ${modelField}`.trim()
      : `${hostname} ${effectiveBrand} ${query.split(' ').slice(0,3).join(' ')}`.trim();
    const domainItems = await serpSearch(domainQ, serpKey);
    items = domainItems.filter(item => item.link && item.link.includes(hostname));
  }

  if (!items.length) return { found: false, products: [] };

  const filtered = items
    .filter(item => isNavPage(item.title))
    .filter(item => {
      const titleNorm = normalizeStr(item.title);
      // Marca: obligatoria si se ingresó
      if (brand && !titleNorm.includes(normalizeStr(brand))) return false;
      // Modelo: obligatorio si se ingresó
      if (modelField && !titleMatchesModel(item.title, modelField)) return false;
      // Si no hay ni marca ni modelo, al menos 2 palabras del query deben estar en el título
      if (!brand && !modelField) {
        const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        const lower = item.title.toLowerCase();
        const matches = queryWords.filter(w => lower.includes(w)).length;
        if (matches < Math.min(2, queryWords.length)) return false;
      }
      return true;
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

  return { found: products.length > 0, products: products.filter(p => p.title.length > 2) };
}

function postProcessProducts(products, referencePrice) {
  return products
    .map(p => ({ ...p, price: sanitizePrice(p.price, referencePrice) }))
    .filter(p => {
      if (!p.price) return true;
      if (!referencePrice) return true;
      const ratio = p.price / referencePrice;
      return ratio >= 0.65 && ratio <= 1.35;
    });
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  let parsed;
  try { parsed = JSON.parse(event.body || '{}'); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid body' }) }; }

  const { query, site, xproPrice, brand, model: modelField } = parsed;
  const serpKey = process.env.SERP_API_KEY;
  console.log('Query:', query, '| Brand:', brand, '| Model:', modelField, '| Site:', site?.name);

  if (!query || !site) return { statusCode: 400, body: JSON.stringify({ error: 'Faltan parametros' }) };
  if (!serpKey) return { statusCode: 500, body: JSON.stringify({ error: 'SERP_API_KEY no configurada' }) };

  try {
    let result = site.isML
      ? await searchML(query, serpKey, brand, modelField)
      : await searchSite(query, site, serpKey, brand, modelField);

    if (result.products && xproPrice) {
      result = { ...result, products: postProcessProducts(result.products, xproPrice) };
    }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  } catch(e) {
    console.error('Error:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
