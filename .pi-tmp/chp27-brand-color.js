const fs = require("fs");
const path = require("path");

const root = "/Users/ball6847/Projects/7solutions/chatplus-worktrees/CHP-27";
const img = fs.readFileSync(path.join(root, "messenger-staging-setup/images/12-connected-panel.png")).toString("base64");
const dataUri = "data:image/png;base64," + img;

const r = await daemon.evaluateJs(`(async () => {
  const img = new Image();
  img.src = ${JSON.stringify(dataUri)};
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const hist = {};
  for (let i = 0; i < d.length; i += 4) {
    const R = d[i], G = d[i+1], B = d[i+2], A = d[i+3];
    if (A < 200) continue;
    if (R > 110 && G < 95 && B < 85 && (R - G) > 40) {
      const k = ((R>>3)<<10) | ((G>>3)<<5) | (B>>3);
      hist[k] = (hist[k] || 0) + 1;
    }
  }
  const top = Object.entries(hist).sort((a,b) => b[1]-a[1]).slice(0, 6).map(([k, n]) => {
    const v = parseInt(k, 2);
    const R = ((v >> 10) & 31) << 3, G = ((v >> 5) & 31) << 3, B = (v & 31) << 3;
    return {hex: '#' + [R,G,B].map(x => x.toString(16).padStart(2,'0')).join(''), count: n};
  });
  return JSON.stringify({size: [c.width, c.height], top});
})()`);

return {content: [{type: "text", text: JSON.stringify(r.data)}]};
