const https = require('https');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; XproMonitor/1.0)'
      }
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

// Palabras que indican que es una página de categoría o navegación, no un producto
const CATEGORY_WORDS = [
  'categoría', 'categoria', 'teclados', 'organos', 'órganos', 'pianos',
  'guitarras', 'bajos', 'amplificadores', 'distribui', 'mejores precios',
  'instrumentos musicales', 'sonido profesional', 'ver todo', 'todos los',
  'resultados', 'productos', 'tienda', 'home', 'inicio', 'bienvenidos'
];

function isProductResult(title, snippet) {
  const titleLower = title.toLowerCase();
  const snippetLower = (snippet || '').toLowerCase();
  
  // Si el título tiene número entre paréntesis al final, es una categoría (ej: "Teclados (8)")
  if (/\(\d+\)$/.test(title.trim())) return false;
  
  // Si el título es muy corto (menos de 5 palabras) y no tiene modelo/marca específica
  if (title.split(' ').length < 3) return false;
  
  // Si contiene palabras de categoría
  for (const word of CATEGORY_WORDS) {
    if (titleLower.includes(word) && title.split(' ').length < 6) return false;
  }
  
  return true;
}

function extractPrice(title, snippet, priceSnippet) {
  const texts = [priceSnippet || '', snippet || '', title].join(' ');
  
  // Buscar patrones de precio argentino: $1.234.567 o $ 1234567 o $1234
  const patterns = [
    /\$\s*([\d]{1,3}(?:[.,][\d]{3})+)/g,  // $1.234.567
    /\$\s*([\d]{4,})/g,                     // $123456
  ];
  
  for (const pattern of patterns) {
    const matches = [...texts.matchAll(pattern)];
    if (matches.length > 0) {
      const prices = matches.map(m => parseInt(m[1].replace(/[.,]/g, ''))).filter(p => p > 1000);
      if (prices.length > 0) return Math.min(...prices);
    }
  }
  return 0;
}

async function searchML(query) {
  // Usar endpoint de búsqueda de ML con token de app pública
  const url = `https://api.mercadolibre.com/sites/MLA/search?q=${encodeURIComponent(query)}&limit=6&sort=relevance`;
  console.log('ML URL:', url);
  
  try {
    const data = await httpsGet(url);
    console.log('ML response keys:', Object.keys(data));
    
    if (data.error || !data.results) {
      console.log('ML error:', data.error || data.message);
      // Fallback: buscar en ML via SerpApi
      return null; // señal para usar SerpApi con ML
    }
    
    const products = data.results.slice(0, 6).map(p => ({
      title: p.title,
      price: Math.round(p.price),
      currency: p.currency_id,
      url: p.permalink,
      seller: p.seller?.nickname || '',
      condition: p.condition === 'new' ? 'Nuevo' : 'Usado'
    }));
    
    console.log('ML products:', products.length, products[0]?.title, products[0]?.price);
    return { found: products.length > 0, products };
  } catch(e) {
    console.log('ML fetch error:', e.message);
    return null;
  }
}

async function searchSerpApi(query, site, serpKey, isMLFallback = false) {
  let searchQuery;
  if (isMLFallback) {
    searchQuery = `site:mercadolibre.com.ar ${query}`;
  } else {
    const hostname = new URL(site.url).hostname;
    searchQuery = `site:${hostname} ${query}`;
  }
  
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(searchQuery)}&api_key=${serpKey}&num=8&gl=ar&hl=es`;
  console.log('SerpApi query:', searchQuery);
  
  const data = await httpsGet(url);
  console.log('SerpApi results:', data.organic_results?.length, '| error:', data.error);
  
  if (data.error) return { found: false, products: [], note: data.error };
  if (!data.organic_results || data.organic_results.length === 0) return { found: false, products: [] };

  const products = data.organic_results
    .filter(item => isProductResult(item.title, item.snippet))
    .map(item => {
      // SerpApi a veces incluye el precio en rich_snippet
      const richPrice = item.rich_snippet?.top?.detected_extensions?.price || 
                        item.rich_snippet?.bottom?.detected_extensions?.price || 0;
      const price = richPrice > 0 ? Math.round(richPrice) : extractPrice(item.title, item.snippet, '');
      
      return {
        title: item.title.replace(/\s*[-|·]\s*.*$/, '').trim(),
        price,
        currency: 'ARS',
        url: item.link,
        seller: isMLFallback ? (item.displayed_link || '') : '',
        condition: 'Nuevo',
        snippet: item.snippet || ''
      };
    })
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

  console.log('Query:', query, '| Site:', site?.name, '| isML:', site?.isML);

  if (!query || !site) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Faltan parametros' }) };
  }

  try {
    let result;
    
    if (site.isML) {
      // Intentar ML API directamente primero
      result = await searchML(query);
      // Si ML falla, usar SerpApi como fallback
      if (result === null && serpKey) {
        console.log('ML API failed, using SerpApi fallback for ML');
        result = await searchSerpApi(query, site, serpKey, true);
      } else if (result === null) {
        result = { found: false, products: [] };
      }
    } else {
      if (!serpKey) {
        return { statusCode: 500, body: JSON.stringify({ error: 'SERP_API_KEY no configurada' }) };
      }
      result = await searchSerpApi(query, site, serpKey, false);
    }

    console.log('Final result - found:', result.found, '| products:', result.products?.length);
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
