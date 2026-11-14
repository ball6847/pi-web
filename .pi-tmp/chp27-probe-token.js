const fs = require("fs");
const path = require("path");

const root = "/Users/ball6847/Projects/7solutions/chatplus-worktrees/CHP-27";
const cfg = JSON.parse(fs.readFileSync(path.join(root, ".private/chp27/messenger-real.json"), "utf8"));
const appToken = `${cfg.appId}|${cfg.appSecret}`;

// The Explorer's token field is the token the OAuth flow just delivered.
const probe = await daemon.evaluateJs(`(async () => {
  const inputs = Array.from(document.querySelectorAll('input')).map(i => i.value || '');
  const tok = inputs.find(v => v.length > 100) || '';
  return JSON.stringify({tok});
})()`);
const { tok } = JSON.parse(probe);

const result = await daemon.evaluateJs(`(async () => {
  const tok = ${JSON.stringify(tok)};
  const app = ${JSON.stringify(appToken)};
  const out = {tokLen: tok.length, tokPrefix: tok.slice(0, 6)};

  const dbg = await fetch('https://graph.facebook.com/v26.0/debug_token?input_token=' + encodeURIComponent(tok) + '&access_token=' + encodeURIComponent(app), {credentials: 'omit'});
  const j = await dbg.json();
  const d = j.data || {};
  out.debug = {
    status: dbg.status,
    type: d.type,
    profile_id: d.profile_id,
    is_valid: d.is_valid,
    scopes: d.scopes,
    granular: (d.granular_scopes || []).map(g => ({scope: g.scope, targets: g.target_ids})),
    expires_at: d.expires_at,
    error: j.error && j.error.message,
  };

  const me = await fetch('https://graph.facebook.com/v26.0/me?fields=id,name', {credentials: 'omit'});
  out.me = {status: me.status, body: (await me.text()).slice(0, 300)};

  return JSON.stringify(out);
})()`);

return {content: [{type: "text", text: result}]};
