import express from 'express';
import * as cheerio from 'cheerio';

const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

app.use(express.static('.'));

const clean = (s) =>
  (s ?? '')
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const n = (value) => {
  if (value === undefined || value === null || value === '-') return null;
  const x = Number(value);
  return Number.isFinite(x) ? x : null;
};

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
        'user-agent': 'Mozilla/5.0',
        'accept-language': 'ja-JP,ja;q=0.9'
      }
    });

    if (!rr.ok) {
      throw new Error(`Official HTTP ${rr.status}`);
    }

    const html = await rr.text();
    const $ = cheerio.load(html);

    const racers = [];

    $('tr').each((_, tr) => {

      const cells = [];

      $(tr).find('td').each((__, td) => {
        cells.push(clean($(td).text()));
      });

      if (cells.length < 8) return;

      // 「登録番号 / 級別」を持つセルを探す
      const racerCellIndex = cells.findIndex((x) =>
        /\d{4}\s*\/\s*(A1|A2|B1|B2)/.test(x)
      );

      if (racerCellIndex === -1) return;

      const racerCell = cells[racerCellIndex];

      const racerMatch = racerCell.match(
        /(\d{4})\s*\/\s*(A1|A2|B1|B2)\s+(.+?)\s+([^\/\s]+)\/([^\s]+)\s+(\d+)歳\/([\d.]+)kg/
      );

      if (!racerMatch) return;

      // 選手セルの直前が枠番
      const laneText = cells
        .slice(0, racerCellIndex)
        .find((x) => /^[１-６1-6]$/.test(x));

      const fullToHalf = {
        '１': 1,
        '２': 2,
        '３': 3,
        '４': 4,
        '５': 5,
        '６': 6
      };

      const lane =
        fullToHalf[laneText] ||
        Number(laneText);

      if (!lane || lane < 1 || lane > 6) return;

      const statusCell = cells[racerCellIndex + 1] || '';

      const status = statusCell.match(
        /F(\d+)\s+L(\d+)\s+([0-9.]+|-)/
      );

      if (!status) return;

      const national = (cells[racerCellIndex + 2] || '')
        .split(/\s+/);

      const local = (cells[racerCellIndex + 3] || '')
        .split(/\s+/);

      const motor = (cells[racerCellIndex + 4] || '')
        .split(/\s+/);

      const boat = (cells[racerCellIndex + 5] || '')
        .split(/\s+/);

      racers.push({
        lane,

        registration: racerMatch[1],
        rank: racerMatch[2],
        name: clean(racerMatch[3]),

        branch: clean(racerMatch[4]),
        birthplace: clean(racerMatch[5]),

        age: n(racerMatch[6]),
        weight: n(racerMatch[7]),

        F: n(status[1]),
        L: n(status[2]),
        avgST: n(status[3]),

        national: {
          winRate: n(national[0]),
          quinellaRate: n(national[1]),
          trioRate: n(national[2])
        },

        local: {
          winRate: n(local[0]),
          quinellaRate: n(local[1]),
          trioRate: n(local[2])
        },

        motor: {
          no: n(motor[0]),
          quinellaRate: n(motor[1]),
          trioRate: n(motor[2])
        },

        boat: {
          no: n(boat[0]),
          quinellaRate: n(boat[1]),
          trioRate: n(boat[2])
        }
      });

    });

    racers.sort((a, b) => a.lane - b.lane);

    if (racers.length !== 6) {
      return res.status(422).json({
        ok: false,
        version: '0.4',
        error: `Racer extraction incomplete: ${racers.length}/6`,
        source: url,
        racers
      });
    }

    res.json({
      ok: true,
      version: '0.4',
      source: url,
      date,
      jcd,
      rno: Number(rno),
      racers
    });

  } catch (e) {

    res.status(502).json({
      ok: false,
      version: '0.4',
      error: String(e.message || e),
      source: url
    });

  }

});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Kyokun API v0.4 on ${port}`);
});
