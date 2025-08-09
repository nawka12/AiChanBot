const fetch = require('node-fetch');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

function toOpenAIMessage(message) {
  if (Array.isArray(message.content)) {
    const parts = [];
    for (const item of message.content) {
      if (item.type === 'image' && item.source?.type === 'base64') {
        const mediaType = item.source.media_type || 'image/png';
        const dataUrl = `data:${mediaType};base64,${item.source.data}`;
        parts.push({ type: 'image_url', image_url: { url: dataUrl } });
      } else if (item.type === 'text' && typeof item.text === 'string') {
        parts.push({ type: 'text', text: item.text });
      }
    }
    return { role: message.role, content: parts };
  }
  return { role: message.role, content: message.content };
}

function toOpenAITools(tools) {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema
    }
  }));
}

async function callChat({ model, messages, tools, max_tokens, reasoning }) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not set');
  }
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
    'HTTP-Referer': 'https://github.com/nawka12/AiChanBot',
    'X-Title': 'Ai-chan Discord Bot'
  };

  const body = {
    model,
    messages,
    ...(tools && tools.length ? { tools } : {}),
    ...(max_tokens ? { max_tokens } : {}),
    ...(reasoning ? { reasoning } : {})
  };

  const res = await fetch(OPENROUTER_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenRouter request failed: ${res.status} ${res.statusText} ${text}`);
  }
  return res.json();
}

module.exports = {
  toOpenAIMessage,
  toOpenAITools,
  callChat,
};

// Cache for tool support checks per model
const toolsSupportCache = new Map();

async function modelSupportsTools(modelId) {
  if (!modelId) return false;
  if (toolsSupportCache.has(modelId)) return toolsSupportCache.get(modelId);
  try {
    const [author, ...rest] = String(modelId).split('/');
    const slug = rest.join('/');
    if (!author || !slug) throw new Error('invalid model id');
    const url = `https://openrouter.ai/api/v1/models/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    const endpoints = data?.data?.endpoints || [];
    const supported = endpoints.some((ep) => Array.isArray(ep.supported_parameters) && ep.supported_parameters.includes('tools'));
    toolsSupportCache.set(modelId, supported);
    return supported;
  } catch (_) {
    toolsSupportCache.set(modelId, false);
    return false;
  }
}

module.exports.modelSupportsTools = modelSupportsTools;

// Cache for reasoning parameter support checks per model
const reasoningSupportCache = new Map();

async function modelSupportsReasoning(modelId) {
  if (!modelId) return false;
  if (reasoningSupportCache.has(modelId)) return reasoningSupportCache.get(modelId);
  try {
    const [author, ...rest] = String(modelId).split('/');
    const slug = rest.join('/');
    if (!author || !slug) throw new Error('invalid model id');
    const url = `https://openrouter.ai/api/v1/models/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    const endpoints = data?.data?.endpoints || [];
    const supported = endpoints.some((ep) => Array.isArray(ep.supported_parameters) && ep.supported_parameters.includes('reasoning'));
    reasoningSupportCache.set(modelId, supported);
    return supported;
  } catch (_) {
    reasoningSupportCache.set(modelId, false);
    return false;
  }
}

module.exports.modelSupportsReasoning = modelSupportsReasoning;


