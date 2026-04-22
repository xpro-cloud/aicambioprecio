const https = require('https');

function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch(e) {
          reject(new Error('Invalid JSON: ' + data.slice(0, 200)));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let parsed;
  try {
    parsed = JSON.parse(event.body || '{}');
  } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { query, sku, site } = parsed;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  console.log('Query:', query, '| Site:', site?.name, '| Has API key:', !!apiKey);

  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY no configurada' }) };
  }

  if (!query || !site) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Faltan parámetros query o site' }) };
  }

  const siteContext = site.isML
    ? 'Mercado Libre Argentina (mercadolibre.com.ar)'
    : `${site.name} (${site.url})`;

  const prompt = `Usá web search para buscar el precio actual de "${query}" en ${siteContext}.

Buscá específicamente en ese sitio web. Si encontrás resultados, devolvé SOLO este JSON sin texto adicional:
{
  "found": true,
  "products": [
    {
      "title": "nombre exacto del producto",
      "price": 123456,
      "currency": "ARS",
      "url": "https://url-directa-al-producto",
      "seller": "",
      "condition": "Nuevo"
    }
  ],
  "note": ""
}

Si no encontrás resultados devolvé: {"found": false, "products": [], "note": "sin resultados"}
Precios como números enteros en pesos argentinos.`;
  const requestBody = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{ role: 'user', content: prompt }]
  });

  try {
    console.log('Calling Anthropic API...');
    const data = await httpsPost(
      'https://api.anthropic.com/v1/messages',
      {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      requestBody
    );

    console.log('API response type:', data.type, '| Stop reason:', data.stop_reason);

    if (data.error) {
      console.error('API error:', data.error);
      return { statusCode: 400, body: JSON.stringify({ error: data.error.message }) };
    }

    const textContent = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    console.log('Text content length:', textContent.length);

    const jsonMatch = textContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log('No JSON found in response:', textContent.slice(0, 300));
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ found: false, products: [], note: 'Sin resultados' })
      };
    }

    const result = JSON.parse(jsonMatch[0]);
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
};
