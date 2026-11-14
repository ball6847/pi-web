const fs = require("fs");
const path = require("path");

const root = "/Users/ball6847/Projects/7solutions/chatplus-worktrees/CHP-27";
const token = fs.readFileSync(path.join(root, ".private/chp27/page-1389752544229142.token.txt"), "utf8").trim();

const r = await daemon.evaluateJs(`(async () => {
  const token = ${JSON.stringify(token)};
  const dialog = document.querySelector('[role="dialog"]') || document;
  const field = Array.from(dialog.querySelectorAll('input')).find(i => i.type !== 'checkbox' && i.type !== 'radio');
  if (!field) return JSON.stringify({err: 'no field'});
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(field, token);
  field.dispatchEvent(new Event('input', {bubbles: true}));
  field.dispatchEvent(new Event('change', {bubbles: true}));
  await new Promise(res => setTimeout(res, 1000));
  return JSON.stringify({len: field.value.length, type: field.type});
})()`);

return {content: [{type: "text", text: JSON.stringify(r.data)}]};
