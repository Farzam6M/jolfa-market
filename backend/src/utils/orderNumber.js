/** Human-friendly, sortable order number: JM-YYYYMMDD-XXXXXX */
function generateOrderNumber() {
  const d = new Date();
  const datePart = d.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `JM-${datePart}-${rand}`;
}

module.exports = { generateOrderNumber };
