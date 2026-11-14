const fs = require("fs");
const path = require("path");

const root = "/Users/ball6847/Projects/7solutions/chatplus-worktrees/CHP-27";
const cfg = JSON.parse(fs.readFileSync(path.join(root, ".private/chp27/messenger-real.json"), "utf8"));

const r = await daemon.evaluateJs(`(async () => {
  const token = ${JSON.stringify(cfg.verifyToken)};
  const inputs = Array.from(document.querySelectorAll('input'));
  const url = inputs.find(i => i.type === 'url');
  const idx = inputs.indexOf(url);
  const vt = inputs[idx + 1];
  const before = {vtType: vt && vt.type, vtLen: vt ? (vt.value||'').length : null, urlVal: url ? url.value : null};
  if (!vt) return JSON.stringify({err: 'no verify field', before});

  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(vt, token);
  vt.dispatchEvent(new Event('input', {bubbles: true}));
  vt.dispatchEvent(new Event('change', {bubbles: true}));
  vt.dispatchEvent(new FocusEvent('focus', {bubbles: true}));
  vt.focus();
  vt.blur();
  await new Promise(res => setTimeout(res, 2000));

  const btn = Array.from(document.querySelectorAll('button, div[role=button]')).find(x => (x.textContent||'').trim() === 'Verify and save');
  return JSON.stringify({
    before,
    after: {vtLen: vt.value.length, btnDisabled: btn ? (btn.disabled === true || btn.getAttribute('aria-disabled')==='true') : null},
  });
})()`);

return {content: [{type: "text", text: JSON.stringify(r.data)}]};
