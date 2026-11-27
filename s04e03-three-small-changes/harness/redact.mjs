// Masking for records and logs: values from vars.json, secret-named JSON fields, and token and key shapes.
// A new secret (the attempt in the manual, a receipt) is not in vars yet, so names and shapes count too.
const FIELD = /^(attempt|ticket|receipt|token|task|key|payout_?key|api_?key|authorization|secret|cursor)$/i;
const SHAPES = [
  /\bv1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // course tickets and tokens
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]+)?/g, // JWT-like
  /\bsk-[A-Za-z0-9_-]{16,}/g, // model keys
  /Bearer\s+(?!\{\{)[A-Za-z0-9._~+/-]{12,}=*/g,
];

function fieldValues(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => fieldValues(v, found));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string' && FIELD.test(k) && v.length >= 12 && !/\s/.test(v)) found.add(v);
      else fieldValues(v, found);
    }
  }
  return found;
}

/** secrets: [[name, value]] from vars.json. Returns the text with every secret replaced. */
export function redact(text, secrets = []) {
  let s = String(text);
  for (const [name, v] of secrets) s = s.split(v).join(`{{${name}}}`).split(encodeURIComponent(v)).join(`{{${name}}}`);
  try {
    for (const v of fieldValues(JSON.parse(String(text)))) s = s.split(v).join('<masked>');
  } catch {}
  for (const re of SHAPES) s = s.replace(re, '<masked>');
  return s;
}
