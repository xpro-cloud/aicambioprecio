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
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

async function searchML(query) {
  const url = `https://api.mercadolibre.com/sites/MLA/search?q=${encodeURIComponent(query)}&limit=6`;
  console.log('ML URL:', url);
  const data = await httpsGet(url);
  console.log('ML raw response keys:', Object.keys(data));
  console.log('ML results count:', data.results?.length);
  if (!data.results || data.results.length === 0) {
    console.log('ML error or empty:', JSON.stringify(data).slice(0, 300));
    return { found: false, products: [] };
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
}

async function searchGoogle(query, site, googleKey, cseId) {
  const hostname = new URL(site.url).hostname;
  const siteQuery = `site:${hostname} ${query}`;
  const url = `https://www.googleapis.com/customsearch/v1?key=${googleKey}&cx=${cseId}&q=${encodeURIComponent(siteQuery)}&num=6`;
  console.log('Google query:', siteQuery);
  const data = await httpsGet(url);
  console.log('Google response - items:', data.items?.length, '| error:', data.error?.message);
  if (!data.items || data.items.length === 0) {
    return { found: false, products: [] };
  }
  const products = data.items.map(item => {
    const text = (item.title + ' ' + (item.snippet || '')).replace(/\./g, '').replace(/,/g, '.');
    const priceMatch = text.match(/\$\s*([\d]{4,})/);
    const price = priceMatch ? parseInt(priceMatch[1]) : 0;
    return {
      title: item.title.replace(/\s*[-|].*$/, '').trim(),
      price,
      currency: 'ARS',
      url: item.link,
      seller: '',
      condition: 'Nuevo'
    };
  });
  console.log('Google products:', products.length, products[0]?.title, products[0]?.price);
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
  const googleKey = process.env.GOOGLE_API_KEY;
  const cseId = process.env.GOOGLE_CSE_ID;

  console.log('Query:', query, '| Site:', site?.name, '| isML:', site?.isML);
  console.log('Google key present:', !!googleKey, '| CSE ID present:', !!cseId);

  if (!query || !site) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Faltan parametros' }) };
  }

  try {
    let result;
    if (site.isML) {
      result = await searchML(query);
    } else {
      if (!googleKey || !cseId) {
        console.log('Missing Google credentials');
        return { statusCode: 500, body: JSON.stringify({ error: 'Google API no configurada' }) };
      }
      result = await searchGoogle(query, site, googleKey, cseId);
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
