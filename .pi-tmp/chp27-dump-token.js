const fs = require("fs");
const path = require("path");

const root = "/Users/ball6847/Projects/7solutions/chatplus-worktrees/CHP-27";
const tok = await daemon.evaluateJs(`(Array.from(document.querySelectorAll('input')).map(i => i.value || '').find(v => v.length > 100)) || ''`);
const token = tok.data || "";
if (!token) {
  return {content: [{type: "text", text: "no token in the field"}]};
}
fs.writeFileSync("/tmp/chp27-explorer-token.txt", token, {mode: 0o600});
return {content: [{type: "text", text: "wrote " + token.length + " chars"}]};
