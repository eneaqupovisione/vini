// =====================================================================
//  Funzione Netlify — abbinamento vini con Claude Haiku
//  La chiave API vive QUI (variabile d'ambiente ANTHROPIC_API_KEY),
//  mai nell'index.html pubblico. L'app chiama questa funzione; lei sola
//  parla con Anthropic.
//
//  L'app manda: { items: [ { raw, candidates: [ {id, label}, ... ] }, ... ] }
//  La funzione risponde: { results: [ { raw, chosenId, confidence }, ... ] }
//   - chosenId = id del candidato scelto, oppure null se nessuno corrisponde
//   - confidence = 'high' | 'low'
// =====================================================================

exports.handler = async (event) => {
  // CORS: consenti chiamate dal tuo sito
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Chiave API non configurata sul server' }) };
  }

  let items;
  try {
    const body = JSON.parse(event.body || '{}');
    items = body.items;
    if (!Array.isArray(items) || items.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Nessun item da abbinare' }) };
    }
    // limite di sicurezza: non processare più di 40 righe per chiamata
    if (items.length > 40) items = items.slice(0, 40);
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Body non valido' }) };
  }

  // Costruiamo un prompt rigido: l'AI sceglie SOLO tra i candidati forniti,
  // non inventa, non cerca online. Risposta in JSON puro.
  const userPayload = items.map((it, i) => {
    const cands = (it.candidates || [])
      .map(c => `      - id ${c.id}: ${c.label}`)
      .join('\n');
    return `RIGA ${i} — testo del cameriere: "${it.raw}"\n    candidati possibili:\n${cands}`;
  }).join('\n\n');

  const systemPrompt =
    'Sei un assistente che abbina voci scritte male o abbreviate da camerieri ' +
    'a vini di una carta. Per ogni RIGA devi scegliere QUALE candidato corrisponde, ' +
    'usando solo la lista di candidati fornita per quella riga. ' +
    'Regole ferree: ' +
    '(1) Scegli SOLO tra gli id elencati per quella riga. ' +
    '(2) NON inventare vini, NON cercare informazioni esterne. ' +
    '(3) Se nessun candidato corrisponde ragionevolmente, usa chosenId = null. ' +
    '(4) Tieni conto di abbreviazioni gergali (es. "gewu" = gewürztraminer, ' +
    '"sv" = Sanct Valentin) e di errori di battitura. ' +
    '(5) Se la riga sembra indicare il formato piccolo (375, "piccolo"), preferisci il candidato 375ml. ' +
    'Rispondi ESCLUSIVAMENTE con un oggetto JSON valido, senza testo prima o dopo, ' +
    'in questa forma: {"results":[{"line":0,"chosenId":<id o null>,"confidence":"high"|"low"}, ...]}';

  const userPrompt =
    'Abbina ogni riga al candidato corretto.\n\n' + userPayload +
    '\n\nRispondi solo col JSON richiesto.';

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Errore AI', detail: errText.slice(0, 300) }) };
    }

    const data = await resp.json();
    // Estrai il testo dalla risposta
    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    // Pulisci eventuali backtick e parse del JSON
    const clean = text.replace(/```json|```/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (e) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Risposta AI non interpretabile', raw: clean.slice(0, 300) }) };
    }

    // Normalizza il risultato e rimappa al "raw" originale tramite l'indice riga
    const out = (parsed.results || []).map(r => ({
      raw: items[r.line] ? items[r.line].raw : null,
      line: r.line,
      chosenId: (r.chosenId === null || r.chosenId === undefined) ? null : r.chosenId,
      confidence: r.confidence === 'high' ? 'high' : 'low',
    }));

    return { statusCode: 200, headers, body: JSON.stringify({ results: out }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Errore interno', detail: String(e).slice(0, 200) }) };
  }
};
