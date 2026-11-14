const fs = require("fs");
const path = require("path");

const root = "/Users/ball6847/Projects/7solutions/chatplus-worktrees/CHP-27";
const token = fs.readFileSync(path.join(root, ".private/chp27/page-1389752544229142.token.txt"), "utf8").trim();

const r = await daemon.evaluateJs(`(async () => {
  const token = ${JSON.stringify(token)};
  const field = document.querySelector('input[aria-label="Page access token"]') ||
    Array.from(document.querySelectorAll('input')).find(i => /page access token/i.test(i.getAttribute('aria-label') || i.placeholder || ''));
  if (!field) return JSON.stringify({err: 'no field', inputs: Array.from(document.querySelectorAll('input')).map(i => i.getAttribute('aria-label'))});
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(field, token);
  field.dispatchEvent(new Event('input', {bubbles: true}));
  field.dispatchEvent(new Event('change', {bubbles: true}));
  await new Promise(res => setTimeout(res, 800));
  return JSON.stringify({filled: true, len: field.value.length});
})()`);

return {content: [{type: "text", text: JSON.stringify(r.data)}]};
