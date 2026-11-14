const r = await daemon.evaluateJs("1 + 1");
return {content: [{type: "text", text: "type=" + typeof r + " keys=" + (r && typeof r === "object" ? Object.keys(r).join(",") : "n/a") + " value=" + JSON.stringify(r)}]};
