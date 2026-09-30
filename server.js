import express from 'express';
import * as cheerio from 'cheerio';

const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// index.htmlを表示
app.use(express.static('.'));

const clean = s => (s ?? '')
  .replace(/\u3000/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();


// ========================================
// BOATRACE公式ページ取得
// ========================================

async function officialFetch(url) {

  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 KyokunResearch/0.6',
      'accept-language': 'ja,en;q=0.8'
    }
  });

  if (!response.ok) {
    throw new Error(`official HTTP ${response.status}`);
  }

  return await response.text();
}


// ========================================
// API
// ========================================

app.get('/api/race', async (req, res) => {

  const { date, jcd, rno } = req.query;


  if (
    !/^\d{8}$/.test(date || '') ||
    !/^\d{2}$/.test(jcd || '') ||
    !/^(?:[1-9]|1[0-2])$/.test(rno || '')
  ) {

    return res.status(400).json({
      ok: false,
      error:
        'date(YYYYMMDD), jcd(01-24), rno(1-12) are required'
    });

  }


  const url =
    `https://www.boatrace.jp/owpc/pc/race/racelist?hd=${date}&jcd=${jcd}&rno=${rno}`;


  try {

    const html = await officialFetch(url);

    const $ = cheerio.load(html);

    const racers = [];


    // ========================================
    // STEP1で成功していた方式
    //
    // 「枠番＋登録番号」を同時に探さない。
    // 登録番号 / 級別 を持つセルから選手を特定。
    // ========================================

    $('tr').each((_, tr) => {

      if (racers.length >= 6) return;


      const cells = $(tr)
        .find('td')
        .map((_, td) => clean($(td).text()))
        .get();


      if (!cells.length) return;


      // 登録番号 / 級別 が入っているセルを探す
      const racerCellIndex = cells.findIndex(cell =>
        /\d{4}\s*\/\s*(A1|A2|B1|B2)/.test(cell)
      );


      if (racerCellIndex < 0) return;


      const racerCell = cells[racerCellIndex];


      const head = racerCell.match(
        /(\d{4})\s*\/\s*(A1|A2|B1|B2)\s+(.+?)\s+([^\/\s]+)\/([^\s]+)\s+(\d+)歳\/([\d.]+)kg/
      );


      if (!head) return;


      const registration = head[1];

      const rank = head[2];

      const name = clean(head[3]);

      const branch = clean(head[4]);

      const birthplace = clean(head[5]);

      const age = Number(head[6]);

      const weight = Number(head[7]);


      // ========================================
      // 枠番
      // 登録番号セルより前のセルから1〜6を探す
      // ========================================

      let lane = null;


      for (let i = 0; i < racerCellIndex; i++) {

        if (/^[1-6]$/.test(cells[i])) {

          lane = Number(cells[i]);

          break;
        }

      }


      // 枠番セルが取れない場合は
      // 選手の出現順を使用
      if (lane === null) {

        lane = racers.length + 1;

      }


      // ========================================
      // F / L / 平均ST
      // ========================================

      let F = 0;

      let L = 0;

      let avgST = null;

      let flIndex = -1;


      for (
        let i = racerCellIndex + 1;
        i < cells.length;
        i++
      ) {

        const m = cells[i].match(
          /F(\d+)\s+L(\d+)\s+([0-9.]+|-)/
        );


        if (m) {

          F = Number(m[1]);

          L = Number(m[2]);

          avgST =
            m[3] === '-'
              ? null
              : Number(m[3]);

          flIndex = i;

          break;
        }

      }


      // ========================================
      // 全国 / 当地 / モーター / ボート
      // ========================================

      const numberGroups = [];


      if (flIndex >= 0) {

        for (
          let i = flIndex + 1;
          i < cells.length;
          i++
        ) {

          const nums = (
            cells[i].match(
              /-|\d+(?:\.\d+)?/g
            ) || []
          );


          if (nums.length >= 3) {

            numberGroups.push(nums);

          }


          if (numberGroups.length >= 4) {

            break;

          }

        }

      }


      const n = (group, index) => {

        const value =
          numberGroups[group]?.[index];


        if (
          value === undefined ||
          value === '-'
        ) {

          return null;

        }


        return Number(value);

      };


      racers.push({

        lane,

        registration,

        rank,

        name,

        branch,

        birthplace,

        age,

        weight,

        F,

        L,

        avgST,


        national: {

          winRate: n(0, 0),

          quinellaRate: n(0, 1),

          trioRate: n(0, 2)

        },


        local: {

          winRate: n(1, 0),

          quinellaRate: n(1, 1),

          trioRate: n(1, 2)

        },


        motor: {

          no: n(2, 0),

          quinellaRate: n(2, 1),

          trioRate: n(2, 2)

        },


        boat: {

          no: n(3, 0),

          quinellaRate: n(3, 1),

          trioRate: n(3, 2)

        }

      });

    });


    racers.sort(
      (a, b) => a.lane - b.lane
    );


    // ========================================
    // 安全チェック
    // ========================================

    if (racers.length !== 6) {

      return res.status(422).json({

        ok: false,

        error:
          `Racer extraction incomplete: ${racers.length}/6`,

        source: url,

        date,

        jcd,

        rno: Number(rno),

        racers

      });

    }


    // ========================================
    // 成功
    // ========================================

    return res.json({

      ok: true,

      version: '0.6-step1-recovery',

      source: url,

      date,

      jcd,

      rno: Number(rno),

      racers

    });


  } catch (e) {

    return res.status(502).json({

      ok: false,

      error: String(
        e.message || e
      ),

      source: url

    });

  }

});


// ========================================
// SERVER
// ========================================

const port =
  process.env.PORT || 3000;


app.listen(
  port,
  () =>
    console.log(
      `Kyokun API v0.6 running on ${port}`
    )
);
