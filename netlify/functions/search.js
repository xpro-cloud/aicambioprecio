const https = require('https');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
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

async function searchML(query) {
  const url = `https://api.mercadolibre.com/sites/MLA/search?q=${encodeURIComponent(query)}&limit=6`;
  console.log('ML URL:', url);
  const data = await httpsGet(url);
  console.log('ML results:', data.results?.length, '| error:', data.error);
  if (!data.results || data.results.length === 0) return { found: false, products: [] };
  const products = data.results.slice(0, 6).map(p => ({
    title: p.title,
    price: Math.round(p.price),
    currency: p.currency_id,
    url: p.permalink,
    seller: p.seller?.nickname || '',
    condition: p.condition === 'new' ? 'Nuevo' : 'Usado'
  }));
  return { found: true, products };
}

async function searchSerpApi(query, site, serpKey) {
  const hostname = new URL(site.url).hostname;
  const siteQuery = `site:${hostname} ${query}`;
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(siteQuery)}&api_key=${serpKey}&num=6&gl=ar&hl=es`;
  console.log('SerpApi query:', siteQuery);
  const data = await httpsGet(url);
  console.log('SerpApi results:', data.organic_results?.length, '| error:', data.error);
  
  if (data.error) return { found: false, products: [], note: data.error };
  if (!data.organic_results || data.organic_results.length === 0) return { found: false, products: [] };

  const products = data.organic_results.map(item => {
    const text = (item.title + ' ' + (item.snippet || ''));
    // Extract Argentine prices - look for $ followed by numbers
    const priceMatch = text.match(/\$\s*([\d]{3,}(?:[.,][\d]{3})*)/);
    let price = 0;
    if (priceMatch) {
      price = parseInt(priceMatch[1].replace(/[.,]/g, ''));
    }
    return {
      title: item.title.replace(/\s*[-|·].*$/, '').trim(),
      price,
      currency: 'ARS',
      url: item.link,
      seller: '',
      condition: 'Nuevo',
      snippet: item.snippet || ''
    };
  }).filter(p => p.title.length > 0);

  return { found: products.length > 0, products: products.slice(0, 6) };
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
  console.log('SerpApi key present:', !!serpKey);

  if (!query || !site) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Faltan parametros' }) };
  }

  try {
    let result;
    if (site.isML) {
      result = await searchML(query);
    } else {
      if (!serpKey) {
        return { statusCode: 500, body: JSON.stringify({ error: 'SERP_API_KEY no configurada' }) };
      }
      result = await searchSerpApi(query, site, serpKey);
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
