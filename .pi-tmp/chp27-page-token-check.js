const fs = require("fs");
const path = require("path");

const root = "/Users/ball6847/Projects/7solutions/chatplus-worktrees/CHP-27";
const cfg = JSON.parse(fs.readFileSync(path.join(root, ".private/chp27/messenger-real.json"), "utf8"));
const appToken = `${cfg.appId}|${cfg.appSecret}`;

const tok = await daemon.evaluateJs(`(Array.from(document.querySelectorAll('input')).map(i => i.value || '').find(v => v.length > 100)) || ''`);
const token = tok.data;

const r = await daemon.evaluateJs(`(async () => {
  const t = ${JSON.stringify(token)};
  const app = ${JSON.stringify(appToken)};
  const dbg = await fetch('https://graph.facebook.com/v26.0/debug_token?input_token=' + encodeURIComponent(t) + '&access_token=' + encodeURIComponent(app), {credentials:'omit'});
  const j = await dbg.json();
  const d = j.data || {};
  return JSON.stringify({
    type: d.type, profile_id: d.profile_id, is_valid: d.is_valid,
    scopes: d.scopes, expires_at: d.expires_at,
    granular: (d.granular_scopes || []).map(g => ({scope: g.scope, targets: g.target_ids})),
    error: j.error && j.error.message,
  });
})()`);

const out = r.data;
if (out && out.is_valid && out.type === "PAGE") {
  fs.writeFileSync(path.join(root, ".private/chp27/page-1389752544229142.token.txt"), token, {mode: 0o600});
}
return {content: [{type: "text", text: JSON.stringify(out, null, 1)}]};
