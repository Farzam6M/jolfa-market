const { z } = require('zod');

// `z.coerce.boolean()` runs the raw querystring value through JS's `Boolean()`,
// so any non-empty string — including the literal text "false" or "0" — comes
// out `true`. That silently broke every `?flag=false` request. This parses the
// actual textual intent instead: "true"/"1" -> true, "false"/"0" -> false,
// anything else -> validation error (same as before, just correct now).
const boolQuery = () => z.preprocess((val) => {
  if (typeof val !== 'string') return val;
  if (['true', '1'].includes(val.toLowerCase())) return true;
  if (['false', '0'].includes(val.toLowerCase())) return false;
  return val;
}, z.boolean());

module.exports = { boolQuery };
