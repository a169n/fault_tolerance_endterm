const { chromium } = require('playwright');
(async () => {
  const [src, out] = process.argv.slice(2);
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto('file://' + require('path').resolve(src), { waitUntil: 'load' });
  await p.pdf({ path: out, format: 'A4', printBackground: true, preferCSSPageSize: true,
    displayHeaderFooter: true, headerTemplate: '<span></span>',
    footerTemplate: '<div style="font:8px Inter,sans-serif;color:#5a6577;width:100%;padding:0 15mm;display:flex;justify-content:space-between"><span>Resilient University Information System · Endterm (compact)</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>' });
  await b.close();
})();
