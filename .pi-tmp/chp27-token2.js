const fs = require("fs");
const path = require("path");

const root = "/Users/ball6847/Projects/7solutions/chatplus-worktrees/CHP-27";
const cfg = JSON.parse(fs.readFileSync(path.join(root, ".private/chp27/messenger-real.json"), "utf8"));
const appToken = `${cfg.appId}|${cfg.appSecret}`;

const probe = await daemon.evaluateJs(
  `(Array.from(document.querySelectorAll('input')).map(i => i.value || '').find(v => v.length > 100)) || ''`
);
const tok = probe.data;

const r = await daemon.evaluateJs(`(async () => {
  const tok = ${JSON.stringify(tok)};
  const app = ${JSON.stringify(appToken)};
  const dbg = await fetch('https://graph.facebook.com/v26.0/debug_token?input_token=' + encodeURIComponent(tok) + '&access_token=' + encodeURIComponent(app), {credentials: 'omit'});
  const j = await dbg.json();
  const d = j.data || {};
  return JSON.stringify({
    status: dbg.status,
    type: d.type,
    profile_id: d.profile_id,
    is_valid: d.is_valid,
    scopes: d.scopes,
    granular: (d.granular_scopes || []).map(g => ({scope: g.scope, targets: g.target_ids})),
    expires_at: d.expires_at,
    error: j.error && j.error.message
  });
})()`);

const out = r.data;
if (out && out.is_valid && out.type === "USER") {
  const me = await daemon.evaluateJs(`(async () => {
    const tok = ${JSON.stringify(tok)};
    const r = await fetch('https://graph.facebook.com/v26.0/me/accounts?fields=id,name,access_token', {credentials: 'omit'});
    const j = await r.json();
    if (j.error) return JSON.stringify({status: r.status, error: j.error.message});
    return JSON.stringify({status: r.status, pages: (j.data || []).map(p => ({id: p.id, name: p.name, tokenLen: (p.access_token || '').length}))});
  })()`);
  const pageInfo = JSON.parse(me.data);
  fs.writeFileSync(path.join(root, ".private/chp27/staging-user-token.txt"), tok, {mode: 0o600});
  const pages = pageInfo.pages || [];
  for (const p of pages) {
    const t = await daemon.evaluateJs(`(async () => {
      const r = await fetch('https://graph.facebook.com/v26.0/me/accounts?fields=id,name,access_token', {credentials: 'omit'});
      const j = await r.json();
      const hit = (j.data || []).find(x => x.id === ${JSON.stringify(p.id)});
      return hit ? hit.access_token : '';
    })()`);
    if (t.data) {
      fs.writeFileSync(path.join(root, `.private/chp27/page-${p.id}.token.txt`), t.data, {mode: 0o600});
    }
  }
  return {content: [{type: "text", text: JSON.stringify({token: out, pages: pageInfo}, null, 1)}]};
}

return {content: [{type: "text", text: JSON.stringify(out, null, 1)}]};
