const fs = require("fs");
const path = require("path");

const root = "/Users/ball6847/Projects/7solutions/chatplus-worktrees/CHP-27";
const dir = path.join(root, ".private/chp27");
const userToken = fs.readFileSync(path.join(dir, "staging-user-token.txt"), "utf8").trim();

const ids = ["1389752544229142", "1629373374009729"];
const saved = [];
for (const id of ids) {
  const t = await daemon.evaluateJs(`(async () => {
    const q = 'access_token=' + encodeURIComponent(${JSON.stringify(userToken)});
    const r = await fetch('https://graph.facebook.com/v26.0/me/accounts?fields=id,name,access_token&' + q, {credentials:'omit'});
    const j = await r.json();
    const hit = (j.data || []).find(x => x.id === ${JSON.stringify(id)});
    return hit ? (hit.access_token || '') : '';
  })()`);
  const tok = typeof t.data === "string" ? t.data : "";
  if (tok) {
    fs.writeFileSync(path.join(dir, `page-${id}.token.txt`), tok, {mode: 0o600});
    saved.push({id, len: tok.length});
  }
}

return {content: [{type: "text", text: JSON.stringify(saved)}]};
