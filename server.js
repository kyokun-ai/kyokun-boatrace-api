import express from 'express';
import * as cheerio from 'cheerio';

const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// 今まで通りトップページのHTMLも表示
app.use(express.static('.'));

const clean = s => (s ?? '')
  .replace(/\u3000/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const officialFetch = async url => {
  const r = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 KyokunResearch/0.5',
      'accept-language': 'ja,en;q=0.8'
    }
  });

  if (!r.ok) {
    throw new Error(`official HTTP ${r.status}`);
  }

  return await r.text();
};


// ======================================================
// STEP2-1
// 選手ごとのコース別成績を取得
// 失敗しても /api/race 全体は壊さない
// ======================================================

async function fetchCourseStats(registration) {

  const url =
    `https://www.boatrace.jp/owpc/pc/data/racersearch/course?toban=${registration}`;

  try {

    const html = await officialFetch(url);
    const $ = cheerio.load(html);

    const text = clean($('body').text());

    const section = (startLabel, endLabel) => {

      const start = text.indexOf(startLabel);

      if (start < 0) return '';

      const from = start + startLabel.length;

      const end = endLabel
        ? text.indexOf(endLabel, from)
        : -1;

      return text.slice(
        from,
        end >= 0 ? end : undefined
      );
    };


    // 1～6コースの値を取り出す
    const sixValues = s => {

      const out = Array(6).fill(null);

      const re =
        /(?:^|\s)([1-6])\s+(-|\d+(?:\.\d+)?)\s*%?/g;

      let m;

      while ((m = re.exec(s))) {

        out[Number(m[1]) - 1] =
          m[2] === '-'
            ? null
            : Number(m[2]);
      }

      return out;
    };


    // コース別進入率
    const entry = sixValues(
      section(
        'コース別進入率',
        'コース別3連対率'
      )
    );


    // コース別3連対率
    const trio = sixValues(
      section(
        'コース別3連対率',
        'コース別平均スタートタイミング'
      )
    );


    // コース別平均ST
    const avgST = sixValues(
      section(
        'コース別平均スタートタイミング',
        'コース別スタート順'
      )
    );


    // コース別平均スタート順位
    const startRank = sixValues(
      section(
        'コース別スタート順',
        '集計期間内にデータがない場合'
      )
    );


    const courses = {};

    for (let i = 0; i < 6; i++) {

      courses[String(i + 1)] = {

        entryRate: entry[i],

        trioRate: trio[i],

        avgST: avgST[i],

        avgStartRank: startRank[i]
      };
    }


    return {
      source: url,
      courses
    };

  } catch (e) {

    return {
      source: url,
      error: String(e.message || e),
      courses: null
    };
  }
}



// ======================================================
// 出走表API
// ======================================================

app.get('/api/race', async (req, res) => {

  const {
    date,
    jcd,
    rno
  } = req.query;


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


    $('tr').each((_, tr) => {

      if (racers.length >= 6) return;


      const t = clean($(tr).text());


      const head = t.match(
        /(?:^|\s)([1-6])\s+(\d{4})\s*\/\s*(A1|A2|B1|B2)\s+/
      );


      if (!head) return;


      const lane =
        Number(head[1]);

      const registration =
        head[2];

      const rank =
        head[3];


      const after =
        t.slice(
          t.indexOf(registration) +
          registration.length
        );


      const main = after.match(
        /^\s*\/\s*(A1|A2|B1|B2)\s+(.+?)\s+([^\/\s]+)\/([^\s]+)\s+(\d+)歳\/([\d.]+)kg\s+F(\d+)\s+L(\d+)\s+([0-9.]+|-)\s+/
      );


      if (!main) return;


      const name =
        clean(main[2]);

      const branch =
        clean(main[3]);

      const birthplace =
        clean(main[4]);

      const age =
        Number(main[5]);

      const weight =
        Number(main[6]);

      const F =
        Number(main[7]);

      const L =
        Number(main[8]);

      const avgST =
        main[9] === '-'
          ? null
          : Number(main[9]);


      const marker =
        `F${F} L${L} ${main[9]}`;


      const pos =
        t.indexOf(marker);


      const rest =
        pos >= 0
          ? t.slice(pos + marker.length)
          : '';


      const vals =
        (
          rest.match(
            /(?:^|\s)(-|\d+(?:\.\d+)?)(?=\s|$)/g
          ) || []
        )
        .map(v => v.trim())
        .slice(0, 12);


      const v = i =>
        vals[i] === '-' ||
        vals[i] == null
          ? null
          : Number(vals[i]);


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

          winRate: v(0),

          quinellaRate: v(1),

          trioRate: v(2)
        },


        local: {

          winRate: v(3),

          quinellaRate: v(4),

          trioRate: v(5)
        },


        motor: {

          no: v(6),

          quinellaRate: v(7),

          trioRate: v(8)
        },


        boat: {

          no: v(9),

          quinellaRate: v(10),

          trioRate: v(11)
        }

      });

    });


    racers.sort(
      (a, b) =>
        a.lane - b.lane
    );


    if (racers.length !== 6) {

      return res.status(422).json({

        ok: false,

        error:
          racers.length === 0

            ? 'No 6-racer entry table found. The venue may be non-racing today, or the official page structure changed.'

            : `Racer extraction incomplete: ${racers.length}/6`,

        source: url,

        date,

        jcd,

        rno: Number(rno),

        racers
      });
    }



    // ==================================================
    // 6選手のコース別データを並列取得
    // ==================================================

    const courseResults =
      await Promise.all(

        racers.map(
          r =>
            fetchCourseStats(
              r.registration
            )
        )

      );


    racers.forEach((r, i) => {

      r.courseStats =
        courseResults[i]?.courses
        ?? null;


      if (courseResults[i]?.error) {

        r.courseStatsError =
          courseResults[i].error;
      }

    });



    res.json({

      ok: true,

      version:
        '0.5-step2-1',

      source: url,

      date,

      jcd,

      rno:
        Number(rno),

      racers

    });


  } catch (e) {

    res.status(502).json({

      ok: false,

      error:
        String(
          e.message || e
        ),

      source: url

    });

  }

});



const port =
  process.env.PORT || 3000;


app.listen(
  port,
  () =>
    console.log(
      `Kyokun API STEP2-1 on ${port}`
    )
);
