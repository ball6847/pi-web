const fs = require("fs");
const path = require("path");

const root = "/Users/ball6847/Projects/7solutions/chatplus-worktrees/CHP-27";
const cfg = JSON.parse(fs.readFileSync(path.join(root, ".private/chp27/messenger-real.json"), "utf8"));

const r = await daemon.evaluateJs(`(async () => {
  const token = ${JSON.stringify(cfg.verifyToken)};
  const inputs = Array.from(document.querySelectorAll('input'));
  const vt = inputs.find(i => {
    const v = i.value || '';
    const lbl = (i.getAttribute('aria-label') || '') + ' ' + (i.placeholder || '');
    return lbl.includes('Verify') || (v.length > 0 && /^•+$/.test(v));
  });
  if (!vt) return JSON.stringify({err: 'no verify token field', fields: inputs.map(i => ({lbl: i.getAttribute('aria-label'), len: (i.value||'').length}))});
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(vt, token);
  vt.dispatchEvent(new Event('input', {bubbles: true}));
  vt.dispatchEvent(new Event('change', {bubbles: true}));
  vt.blur();
  await new Promise(res => setTimeout(res, 1500));
  const btn = Array.from(document.querySelectorAll('button, div[role=button]')).find(x => (x.textContent||'').trim() === 'Verify and save');
  return JSON.stringify({
    filled: true,
    len: vt.value.length,
    btnDisabled: btn ? (btn.disabled === true || btn.getAttribute('aria-disabled') === 'true') : null,
  });
})()`);

return {content: [{type: "text", text: JSON.stringify(r.data)}]};
