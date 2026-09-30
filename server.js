import express from 'express';
import * as cheerio from 'cheerio';

const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/', (req, res) => {
  res.json({
    ok: true,
    name: 'Kyokun BOATRACE API v0.3 DEBUG'
  });
});

const clean = (s) =>
  (s ?? '')
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

app.get('/api/race', async (req, res) => {

  const { date, jcd, rno } = req.query;

  if (
    !/^\d{8}$/.test(date || '') ||
    !/^\d{2}$/.test(jcd || '') ||
    !/^(?:[1-9]|1[0-2])$/.test(rno || '')
  ) {
    return res.status(400).json({
      ok: false,
      error: 'invalid parameters'
    });
  }

  const url =
    `https://www.boatrace.jp/owpc/pc/race/racelist` +
    `?hd=${date}&jcd=${jcd}&rno=${rno}`;

  try {

    const rr = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0',
        'accept-language': 'ja-JP,ja;q=0.9'
      }
    });

    const html = await rr.text();
    const $ = cheerio.load(html);

    const rows = [];

    $('tr').each((index, tr) => {

      const cells = [];

      $(tr).find('th,td').each((_, cell) => {
        cells.push(clean($(cell).text()));
      });

      const text = clean($(tr).text());

      if (text || cells.length) {
        rows.push({
          index,
          cells,
          text
        });
      }

    });

    res.json({
      ok: true,
      version: '0.3-debug',

      source: url,

      htmlLength: html.length,

      tableCount: $('table').length,
      trCount: $('tr').length,
      tdCount: $('td').length,

      rows: rows.slice(0, 80)
    });

  } catch (e) {

    res.status(500).json({
      ok: false,
      error: String(e.message || e)
    });

  }

});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Kyokun API v0.3 DEBUG on ${port}`);
});
