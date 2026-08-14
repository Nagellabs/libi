# Style catalog (copy + fill, do not invent pacing)

These mirror the tested templates in `lib/engine/text-anim/templates.ts`. Each
body destructures element-local timing from `context` and paces off `progress`.
Fill TEXT / fonts / colors; keep the pacing math.

## typewriter — char-by-char reveal + caret
```js
const { ctx, width, height, time, progress } = context;
const TEXT = "Salon nails at home";
const REVEAL = 0.6; // reveal done at 60% of the window, then holds
const p = Math.min(1, Math.max(0, (progress || 0) / REVEAL));
let label = TEXT.slice(0, Math.round(p * TEXT.length));
if (Math.round(p * TEXT.length) < TEXT.length && Math.floor((time||0)*2)%2===0) label += "|";
ctx.font = "bold 72px Inter, sans-serif";
ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
ctx.fillText(label, width/2, height/2);
```

## fade-in-words — staggered word reveal
```js
const { ctx, width, height, progress } = context;
const WORDS = "one two three four".split(" ");
ctx.font = "bold 64px Inter, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
const gap = ctx.measureText(" ").width;
let total = 0; const w = WORDS.map(x=>{const m=ctx.measureText(x).width; total+=m; return m;});
total += gap*(WORDS.length-1);
let x = width/2 - total/2;
for (let i=0;i<WORDS.length;i++){ const l = stagger(progress||0,i,WORDS.length,0.5);
  ctx.globalAlpha=l; ctx.fillStyle="#fff"; ctx.fillText(WORDS[i], x, height/2 + (1-easeOutCubic(l))*24); x+=w[i]+gap; }
ctx.globalAlpha=1;
```

## pop-scale-spring — elastic pop-in
```js
const { ctx, width, height, progress } = context;
const p = Math.min(1, Math.max(0, (progress||0)/0.4));
ctx.save(); ctx.translate(width/2,height/2); const s=easeOutBack(p); ctx.scale(s,s);
ctx.globalAlpha=Math.min(1,p*1.5); ctx.font="bold 80px Inter,sans-serif"; ctx.fillStyle="#fff";
ctx.textAlign="center"; ctx.textBaseline="middle"; ctx.fillText("SALE",0,0); ctx.restore(); ctx.globalAlpha=1;
```

(For slide-up-lines, gradient-sweep, and lower-third, the same element-local
`progress` pacing applies — see `lib/engine/text-anim/templates.ts` for the
exact bodies; ask the engine maintainer if a server-side template tool lands.)
