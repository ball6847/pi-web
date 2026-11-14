const fs = require("fs");
const path = require("path");

const root = "/Users/ball6847/Projects/7solutions/chatplus-worktrees/CHP-27";
const dir = path.join(root, ".private/chp27");

const raw = await daemon.evaluateJs("JSON.stringify(window.__chpPageTokens || {})");
const map = JSON.parse(typeof raw.data === "string" ? raw.data : "{}");

const saved = [];
for (const [id, tok] of Object.entries(map)) {
  if (!tok) continue;
  fs.writeFileSync(path.join(dir, `page-${id}.token.txt`), tok, {mode: 0o600});
  saved.push({id, len: tok.length});
}

return {content: [{type: "text", text: JSON.stringify(saved)}]};
