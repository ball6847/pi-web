const fs = require("fs");
const path = require("path");

const root = "/Users/ball6847/Projects/7solutions/chatplus-worktrees/CHP-27";
const dir = path.join(root, ".private/chp27");

const u = await daemon.evaluateJs("window.__chpUserToken || ''");
const p = await daemon.evaluateJs("window.__chpPageToken || ''");
const userToken = u.data || "";
const pageToken = p.data || "";

if (!pageToken) {
  return {content: [{type: "text", text: "no page token captured"}]};
}

fs.writeFileSync(path.join(dir, "staging-user-token.txt"), userToken, {mode: 0o600});
fs.writeFileSync(path.join(dir, "page-1389752544229142.token.txt"), pageToken, {mode: 0o600});

const out = await daemon.evaluateJs(`(async () => {
  const t = ${JSON.stringify(pageToken)};
  const q = 'access_token=' + encodeURIComponent(t);
  const r = await fetch('https://graph.facebook.com/v26.0/me?fields=id,name&' + q, {credentials:'omit'});
  const meBody = (await r.text()).slice(0, 200);
  const r2 = await fetch('https://graph.facebook.com/v26.0/me/accounts?fields=id,name&' + q, {credentials:'omit'});
  const accBody = (await r2.text()).slice(0, 300);
  return JSON.stringify({meStatus: r.status, meBody, accStatus: r2.status, accBody});
})()`);

return {content: [{type: "text", text: JSON.stringify({saved: true, pageTokenLen: pageToken.length, probe: out.data}, null, 1)}]};
