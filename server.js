import express from 'express';
import * as cheerio from 'cheerio';

const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/', (req, res) => {
  res.json({ ok: true, name: 'Kyokun BOATRACE API v0.2' });
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
      error: 'date(YYYYMMDD), jcd(01-24), rno(1-12) are required'
    });
  }

  const url =
    `https://www.boatrace.jp/owpc/pc/race/racelist` +
    `?hd=${date}&jcd=${jcd}&rno=${rno}`;

  try {
    const rr = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 KyokunResearch/0.2',
        'accept-language': 'ja,en;q=0.8'
      }
    });

    if (!rr.ok) {
      throw new Error(`official HTTP ${rr.status}`);
    }

    const html = await rr.text();
    const $ = cheerio.load(html);

    const racers = [];

    $('tr').each((_, tr) => {
      if (racers.length >= 6) return;

      const t = clean($(tr).text());

      const head = t.match(
        /(?:^|\s)([1-6])\s+(\d{4})\s*\/\s*(A1|A2|B1|B2)\s+/
      );

      if (!head) return;

      const lane = Number(head[1]);
      const registration = head[2];
      const rank = head[3];

      const after = t.slice(
        t.indexOf(registration) + registration.length
      );

      const main = after.match(
        /^\s*\/\s*(A1|A2|B1|B2)\s+(.+?)\s+([^\/\s]+)\/([^\s]+)\s+(\d+)歳\/([\d.]+)kg\s+F(\d+)\s+L(\d+)\s+([0-9.]+|-)\s+/
      );

      if (!main) return;

      racers.push({
        lane,
        registration,
        rank,
        name: clean(main[2]),
        branch: clean(main[3]),
        birthplace: clean(main[4]),
        age: Number(main[5]),
        weight: Number(main[6]),
        F: Number(main[7]),
        L: Number(main[8]),
        avgST: main[9] === '-' ? null : Number(main[9]),
        raw: t
      });
    });

    racers.sort((a, b) => a.lane - b.lane);

    if (racers.length !== 6) {
      return res.status(422).json({
        ok: false,
        error: `Racer extraction incomplete: ${racers.length}/6`,
        source: url,
        date,
        jcd,
        rno: Number(rno),
        racers
      });
    }

    res.json({
      ok: true,
      version: '0.2',
      source: url,
      date,
      jcd,
      rno: Number(rno),
      racers
    });

  } catch (e) {
    res.status(502).json({
      ok: false,
      error: String(e.message || e),
      source: url
    });
  }
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Kyokun API v0.2 on ${port}`);
});
