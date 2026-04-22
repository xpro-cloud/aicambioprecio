exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { query, sku, site } = JSON.parse(event.body || '{}');
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'API key no configurada en el servidor' }) };
  }

  const siteContext = site.isML
    ? 'Mercado Libre Argentina (mercadolibre.com.ar)'
    : `${site.name} (${site.url})`;

  const prompt = `Buscá el producto "${query}"${sku ? ` (SKU de referencia: ${sku})` : ''} en ${siteContext}.

Devolvé SOLO un JSON válido con esta estructura exacta, sin texto adicional ni markdown:
{
  "found": true,
  "products": [
    {
      "title": "nombre del producto",
      "price": 123456,
      "currency": "ARS",
      "url": "https://...",
      "seller": "vendedor (solo ML)",
      "condition": "Nuevo o Usado (solo ML)"
    }
  ],
  "note": ""
}

Máximo 6 productos relevantes. Precios como números enteros sin símbolos. Si no hay resultados: found: false, products: [].`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();

    if (data.error) {
      return { statusCode: 400, body: JSON.stringify({ error: data.error.message }) };
    }

    const textContent = data.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    const jsonMatch = textContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { statusCode: 200, body: JSON.stringify({ found: false, products: [], note: 'Sin resultados' }) };
    }

    const result = JSON.parse(jsonMatch[0]);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result)
    };

  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
