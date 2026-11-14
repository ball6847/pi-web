const r1 = await daemon.evaluateJs("(async () => { const x = {a: 1, b: 'z'}; return JSON.stringify(x); })()");
const r2 = await daemon.evaluateJs("(async () => { try { const q = await fetch('https://graph.facebook.com/v26.0/me/accounts?fields=id,name', {credentials:'omit'}); return 'status=' + q.status; } catch (e) { return 'err ' + String(e); } })()");
return {
  content: [
    {type: "text", text: "r1=" + JSON.stringify(r1)},
    {type: "text", text: "r2=" + JSON.stringify(r2)},
  ],
};
