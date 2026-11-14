const fs = require("fs");
const path = require("path");

const root = "/Users/ball6847/Projects/7solutions/chatplus-worktrees/CHP-27";
const dir = path.join(root, ".private/chp27");

const u = await daemon.evaluateJs("window.__chpUserToken || ''");
const p = await daemon.evaluateJs("JSON.stringify(window.__chpPages || [])");
const userToken = u.data || "";
const pages = JSON.parse(p.data || "[]");

fs.writeFileSync(path.join(dir, "staging-user-token.txt"), userToken, {mode: 0o600});
for (const pg of pages) {
  const t = await daemon.evaluateJs(`(async () => {
    const q = 'access_token=' + encodeURIComponent(${JSON.stringify(userToken)});
    const r = await fetch('https://graph.facebook.com/v26.0/me/accounts?fields=id,name,access_token&' + q, {credentials:'omit'});
    const j = await r.json();
    const hit = (j.data || []).find(x => x.id === ${JSON.stringify(pg.id)});
    return hit ? hit.access_token : '';
  })()`);
  if (t.data) fs.writeFileSync(path.join(dir, `page-${pg.id}.token.txt`), t.data, {mode: 0o600});
}

return {content: [{type: "text", text: JSON.stringify({userTokenLen: userToken.length, pages: pages.map(x => x.name)})}]};
