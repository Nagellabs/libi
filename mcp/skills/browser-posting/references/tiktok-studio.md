# TikTok Studio — working recipes (Playwright MCP)

Measured on a real account on 2026-10-02 (https://www.tiktok.com/tiktokstudio/upload, English UI). TikTok
changes this page often: when a selector stops matching, take a screenshot, find the control by its
visible text, and say what changed rather than guessing coordinates.

Each block is the body of ONE `browser_run_code_unsafe` call (`async (page) => { … }`). Run them in
this order; check each call's return value before the next.

## 1. Select the file

```js
await page.getByRole('button', { name: 'Select video', exact: true }).click();
// then, as a separate tool call: browser_file_upload({ paths: ["<cwd>/.playwright-mcp/clip.mp4"] })
```

`page.waitForEvent('filechooser')` inside your own code does not fire: the MCP grabs the chooser
and reports `[File chooser]: can be handled by browser_file_upload`. Paths outside the workspace
roots are refused (`File access denied … outside allowed roots`) — copy the export in first.

## 2. Prompts, then the caption

```js
for (let i = 0; i < 3; i++) {
  for (const name of ['Cancel', 'Got it']) {           // automatic checks → Cancel; tours → Got it
    const b = page.getByRole('dialog').getByRole('button', { name, exact: true });
    if (await b.count()) await b.first().click().catch(() => {});
  }
  const tour = page.getByRole('button', { name: 'Got it', exact: true });  // tour popovers are not dialogs
  if (await tour.count()) await tour.first().click().catch(() => {});
  await page.waitForTimeout(700);
}
const ed = page.locator('[contenteditable="true"]').first();
await ed.click();
await page.keyboard.press('Meta+A');
await page.keyboard.press('Backspace');
await page.waitForTimeout(600);                         // without this the first line is dropped
for (const line of ["Hook line 📐", "", "The point.", ""]) {
  if (line) { await page.keyboard.insertText(line); await page.waitForTimeout(300); }
  await page.keyboard.press('Enter');
}
for (const tag of ['tagone', 'tagtwo']) {                // slowly, or the suggester eats tags
  await page.keyboard.type('#' + tag, { delay: 60 });
  await page.waitForTimeout(1500);
  await page.keyboard.press('Space');
  await page.waitForTimeout(700);
}
return await ed.innerText();
```

Replace one phrase in place (select the text-node range, then type over it):

```js
const ok = await ed.evaluate((el, s) => {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) { const i = n.data.indexOf(s); if (i >= 0) {
    const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + s.length);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); return true; } }
  return false;
}, 'old phrase');
if (ok) await page.keyboard.insertText('new phrase');
```

## 3. Settings

```js
await page.getByText('Uploaded', { exact: false }).first().waitFor({ timeout: 180000 });
const more = page.getByText('Show more', { exact: true });
if (await more.count()) await more.click();
await page.waitForTimeout(800);

// Checkboxes: click the Checkbox__root label — the svg icon and the bare text intercept or ignore clicks.
// The text sits inside the label for some boxes and beside it for others ("Your brand"), so match
// on the label's own text or, when empty, its parent's.
const box = async (text) => {
  const labels = page.locator('label.Checkbox__root');
  const i = await labels.evaluateAll((ls, t) => ls.findIndex(l =>
    ((l.innerText || '').trim() || (l.parentElement?.innerText || '').trim()).startsWith(t)), text);
  return i < 0 ? null : labels.nth(i);
};
const setBox = async (text, want) => {
  const l = await box(text);
  if (!l) return 'absent';
  if ((await l.getAttribute('aria-disabled')) === 'true') return 'disabled';
  if (((await l.getAttribute('aria-checked')) === 'true') !== want) await l.click();
  await page.waitForTimeout(300);
  return await l.getAttribute('aria-checked');
};
// Switches: the [role=switch] in the row; force-click, then answer its confirm dialog.
const sw = (text) => page.getByText(text, { exact: true })
  .locator('xpath=ancestor::*[.//*[@role="switch"]][1]').locator('[role="switch"]').first();
const isOn = async (s) => s.evaluate(e => e.checked || e.getAttribute('aria-checked') === 'true');
const setSwitch = async (text, confirm) => {
  const s = sw(text);
  if (!(await isOn(s))) {
    await s.click({ force: true });
    await page.waitForTimeout(800);
    const c = page.getByRole('dialog').getByRole('button', { name: confirm, exact: true });
    if (confirm && await c.count()) await c.click();
    await page.waitForTimeout(500);
  }
  return await isOn(s);
};

const res = {
  comment: await setBox('Comment', true),
  reuse: await setBox('Reuse of content', true),         // Duet + Stitch; disabled over 60 s
  disclose: await setSwitch('Disclose post content'),    // reveals "Your brand" / "Branded content"
  ai: await setSwitch('AI-generated content', 'Turn on'),// confirm dialog "Labeling AI-generated content"
};
await page.waitForTimeout(500);
res.yourBrand = await setBox('Your brand', true);
return res;
```

What the controls are:
- "Allow users to:" → **Comment** and **Reuse of content** (the old Duet/Stitch). Both default ON
  for a ≤ 60 s video; over 60 s, Reuse of content is disabled with "Duet and Stitch not available for
  videos over 60s".
- **Disclose post content** is a switch; ON reveals two checkboxes, **Your brand** and **Branded
  content** — they start unticked.
- **AI-generated content** is a switch; turning it on opens "Labeling AI-generated content" with
  **Not now** / **Turn on**.
- "Who can see this post" is a combobox already on **Everyone** for a public account.

## 4. Sound

```js
await page.getByRole('button', { name: 'Sounds', exact: true }).click();
await page.waitForTimeout(2500);
await page.getByRole('button', { name: 'Got it' }).first().click({ timeout: 2000 }).catch(() => {});
const s = page.getByPlaceholder('Search sounds');
await s.click(); await s.fill('Dreams Fleetwood Mac'); await page.keyboard.press('Enter');
await page.waitForTimeout(3000);
// pick the row by its exact title, then its "+" (the last button in the row)
const row = page.getByText('Dreams (2004 Remaster)', { exact: true }).first()
  .locator('xpath=ancestor::*[.//button][1]');
await row.locator('button').last().click();
await page.waitForTimeout(2500);
// Audio panel opened for the new clip: Volume (dB), Fade-in, Fade-out
const field = (label) => page.getByText(label, { exact: true })
  .locator('xpath=ancestor::*[.//input][1]').locator('input').last();
const vol = field('Volume');            await vol.click({ clickCount: 3 }); await vol.fill('-8'); await page.keyboard.press('Enter');
const fo = field('Fade-out duration');  await fo.click({ clickCount: 3 });  await fo.fill('1');  await page.keyboard.press('Enter');
await page.waitForTimeout(600);
await page.getByRole('button', { name: 'Save', exact: true }).click();
await page.waitForTimeout(4000);
```

Verify (then leave without changes):

```js
await page.getByRole('button', { name: 'Sounds', exact: true }).click();
await page.waitForTimeout(3000);
const title = await page.locator('.AudioClip__title').allInnerTexts();
await page.locator('.AudioClip__root').first().click({ position: { x: 300, y: 10 } });
await page.waitForTimeout(1000);
const vals = await page.locator('input').evaluateAll(els => els.map(e => e.value).filter(Boolean));
await page.getByRole('button', { name: 'Cancel', exact: true }).first().click();
return { title, vals };   // vals carries the dB and fade values, e.g. "-8", "1"
```

- The song clips in the library are ≤ 1:00 (also 0:22 / 0:30 cuts). The added track starts at 0:00
  and spans the video; nothing to drag for a ≤ 60 s video.
- The form's phone preview label keeps "Original sound – <user>" after Save. Ignore it; verify as above.

## 5. Read-back and screenshot

```js
const ed = page.locator('[contenteditable="true"]').first();
const boxes = await page.locator('label.Checkbox__root').evaluateAll(ls =>
  ls.map(l => [(l.innerText || l.parentElement.innerText).trim().slice(0, 30), l.getAttribute('aria-checked')]));
await page.setViewportSize({ width: 1600, height: 2600 });   // whole form in one shot
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: '.playwright-mcp/tiktok-review.png' });
await page.setViewportSize({ width: 1600, height: 900 });
return { caption: await ed.innerText(), boxes,
         post: await page.getByRole('button', { name: 'Post', exact: true }).isEnabled() };
```

## 6. Leaving without posting

**Discard** → "Discard this post?" → **Discard**. Only for a form YOU filled and the user asked to
drop — never on one the user may be reviewing.

## 7. After Post

`/tiktokstudio/content` lists the post: "Content under review", privacy "Only me", then
"Everyone" once review clears. A post TikTok tags as commercial content (a brand in it is enough)
cannot be deleted or have its privacy changed on the web — "Videos with commercial content can only
be edited on the TikTok app".
