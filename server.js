import express from 'express';
import * as cheerio from 'cheerio';

const app = express();

app.use(express.json({ limit: '1mb' }));

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
// STEP2-4 前検タイム・モーター抽選結果
// 開催につき1回だけ取得
// ========================================

async function fetchPreInspection(date, jcd) {
  const url =
    `https://www.boatrace.jp/owpc/pc/race/rankingmotor?hd=${date}&jcd=${jcd}`;

  try {
    const html = await officialFetch(url);
    const $ = cheerio.load(html);

    let targetTable = null;

    $('table').each((_, table) => {
      if (targetTable) return;
      const header = clean($(table).text());
      if (
        header.includes('登録番号') &&
        header.includes('モーター') &&
        header.includes('ボート') &&
        header.includes('前検タイム')
      ) {
        targetTable = table;
      }
    });

    if (!targetTable) {
      return {
        source: url,
        racers: {},
        error: 'pre-inspection table not found'
      };
    }

    const racers = {};

    $(targetTable).find('tr').each((_, tr) => {
      const cells = $(tr).find('th,td')
        .map((__, cell) => clean($(cell).text()))
        .get();

      // Data row:
      // 順位 / 登録番号 / 選手 / 級別 /
      // モーター番号 / モーター2連対率 /
      // ボート番号 / ボート2連対率 / 前検タイム
      if (cells.length < 9) return;

      const registration = String(cells[1] || '').match(/\d{4}/)?.[0];
      if (!registration) return;

      const num = value => {
        const text = String(value ?? '')
          .replace(/,/g, '')
          .replace(/%/g, '')
          .trim();
        const m = text.match(/-?(?:\d+(?:\.\d+)?|\.\d+)/);
        if (!m) return null;
        const normalized = m[0].startsWith('-.')
          ? m[0].replace('-.', '-0.')
          : m[0].startsWith('.')
            ? `0${m[0]}`
            : m[0];
        const n = Number(normalized);
        return Number.isFinite(n) ? n : null;
      };

      racers[registration] = {
        registration,
        name: cells[2] || null,
        rankClass: cells[3] || null,
        motorNo: num(cells[4]),
        motorQuinellaRate: num(cells[5]),
        boatNo: num(cells[6]),
        boatQuinellaRate: num(cells[7]),
        time: num(cells[8]),
        timeRank: null
      };
    });

    // 前検タイムは小さいほど上位として開催全選手から順位を計算。
    // 同タイムは同順位（competition ranking）。
    const validTimes = Object.values(racers)
      .map(r => r.time)
      .filter(v => Number.isFinite(v))
      .sort((a, b) => a - b);

    const uniqueTimes = [...new Set(validTimes)];

    Object.values(racers).forEach(racer => {
      if (Number.isFinite(racer.time)) {
        racer.timeRank = uniqueTimes.indexOf(racer.time) + 1;
      }
    });

    return {
      source: url,
      racers
    };

  } catch (error) {
    return {
      source: url,
      racers: {},
      error: String(error?.message || error)
    };
  }
}

// ========================================
// STEP2-1 コース別成績 v0.8
// ========================================

async function fetchCourseStats(registration) {

  const url =
    `https://www.boatrace.jp/owpc/pc/data/racersearch/course?toban=${registration}`;

  try {

    const html = await officialFetch(url);
    const $ = cheerio.load(html);

    const bodyText = clean($('body').text());

    const result = {
      registration,
      source: url,
      courses: {}
    };

    // 初期値
    for (let course = 1; course <= 6; course++) {

      result.courses[String(course)] = {
        entryRate: null,
        trioRate: null,
        avgST: null,
        avgStartRank: null
      };

    }


    // ========================================
    // 指定した項目の範囲だけ切り出す
    // ========================================

    function getSection(startLabel, endLabel) {

      const start = bodyText.indexOf(startLabel);

      if (start < 0) {
        return '';
      }

      const from = start + startLabel.length;

      const end = endLabel
        ? bodyText.indexOf(endLabel, from)
        : -1;

      return bodyText.slice(
        from,
        end >= 0 ? end : undefined
      );

    }


    // ========================================
    // 「コース番号 → 値」のペアとして取得
    //
    // 例:
    // 1 14.9
    // 2 17.8
    // 3 17.8
    //
    // ↓
    //
    // {
    //   1:14.9,
    //   2:17.8,
    //   3:17.8
    // }
    //
    // ========================================

    function extractCoursePairs(text) {

      const values = {};

      if (!text) {
        return values;
      }

      const re =
        /(?<!\S)([1-6])\s+(-|\d+(?:\.\d+)?)(?:\s*%)?(?=\s|$)/g;

      let match;

      while ((match = re.exec(text)) !== null) {

        const course = match[1];

        const value =
          match[2] === '-'
            ? null
            : Number(match[2]);

        // 同じコース番号を後から上書きしない
        if (!(course in values)) {
          values[course] = value;
        }

      }

      return values;

    }


    // ========================================
    // 4項目を個別取得
    // ========================================

    const entryRates =
      extractCoursePairs(
        getSection(
          'コース別進入率',
          'コース別3連対率'
        )
      );


    const trioRates =
      extractCoursePairs(
        getSection(
          'コース別3連対率',
          'コース別平均スタートタイミング'
        )
      );


    const avgSTs =
      extractCoursePairs(
        getSection(
          'コース別平均スタートタイミング',
          'コース別スタート順'
        )
      );


    const startRanks =
      extractCoursePairs(
        getSection(
          'コース別スタート順',
          '集計期間内にデータがない場合'
        )
      );


    // ========================================
    // 6コースへ格納
    // ========================================

    for (let course = 1; course <= 6; course++) {

      const key = String(course);

      result.courses[key] = {

        entryRate:
          Object.prototype.hasOwnProperty.call(entryRates, key)
            ? entryRates[key]
            : null,

        trioRate:
          Object.prototype.hasOwnProperty.call(trioRates, key)
            ? trioRates[key]
            : null,

        avgST:
          Object.prototype.hasOwnProperty.call(avgSTs, key)
            ? avgSTs[key]
            : null,

        avgStartRank:
          Object.prototype.hasOwnProperty.call(startRanks, key)
            ? startRanks[key]
            : null

      };

    }


    // ========================================
    // 安全チェック
    //
    // 変な値を拾った場合は
    // 推測して使わず null にする
    // ========================================

    for (let course = 1; course <= 6; course++) {

      const c = result.courses[String(course)];

      if (
        c.entryRate !== null &&
        (c.entryRate < 0 || c.entryRate > 100)
      ) {
        c.entryRate = null;
      }

      if (
        c.trioRate !== null &&
        (c.trioRate < 0 || c.trioRate > 100)
      ) {
        c.trioRate = null;
      }

      if (
        c.avgST !== null &&
        (c.avgST < 0 || c.avgST > 1)
      ) {
        c.avgST = null;
      }

      if (
        c.avgStartRank !== null &&
        (c.avgStartRank < 1 || c.avgStartRank > 6)
      ) {
        c.avgStartRank = null;
      }

    }


    return result;


  } catch (e) {

    // コース別取得が失敗しても
    // STEP1本体は止めない

    return {
      registration,
      source: url,
      courses: null,
      error: String(e.message || e)
    };

  }

}

// ========================================
// STEP2-2A / 2B 今節成績 + 予想時点フィルター v1.5
// ========================================

function extractCurrentMeet($, tr, meetDates, targetDate, targetRno) {

  try {

    const mainRow = $(tr);
    const courseRow = mainRow.next('tr');
    const stRow = courseRow.next('tr');
    const finishRow = stRow.next('tr');

    if (!courseRow.length || !stRow.length || !finishRow.length) {
      return {
        all: { races: [], avgST: null, predictionSafe: false },
        safe: { races: [], avgST: null, predictionSafe: true },
        previousRace: null
      };
    }

    const getCells = row =>
      $(row).children('td').map((_, td) => clean($(td).text())).get();

    const mainCells = getCells(mainRow);
    const courseCells = getCells(courseRow);
    const stCells = getCells(stRow);
    const finishCells = getCells(finishRow);

    // 選手本体行: 0〜8 基本情報 / 9〜22 今節欄 / 23 早見
    // 下3行: 0〜13 今節欄
    const raceNos = mainCells.slice(9, 23);
    const courses = courseCells.slice(0, 14);
    const sts = stCells.slice(0, 14);
    const finishes = finishCells.slice(0, 14);

    const races = [];

    for (let i = 0; i < 14; i++) {

      const raceNoText = clean(raceNos[i] || '');
      const courseText = clean(courses[i] || '');
      const stText = clean(sts[i] || '');
      const finishText = clean(finishes[i] || '');

      if (!/^(?:[1-9]|1[0-2])$/.test(raceNoText)) continue;
      if (!/^[1-6]$/.test(courseText)) continue;

      let st = null;
      let flying = false;

      if (/^F/.test(stText)) {
        flying = true;
        const value = Number(stText.replace(/^F/, ''));
        if (Number.isFinite(value)) st = -value;
      } else if (/^(?:\d+)?\.\d+$/.test(stText)) {
        const value = Number(stText);
        if (Number.isFinite(value)) st = value;
      }

      let finish = null;
      let finishCode = null;

      const normalizedFinish = finishText
        .replace(/１/g, '1')
        .replace(/２/g, '2')
        .replace(/３/g, '3')
        .replace(/４/g, '4')
        .replace(/５/g, '5')
        .replace(/６/g, '6');

      if (/^[1-6]$/.test(normalizedFinish)) {
        finish = Number(normalizedFinish);
      } else if (finishText) {
        finishCode = finishText;
      }

      // 公式表は1日につき最大2走分の列を持つ。
      // meetColumn 0,1 = 初日 / 2,3 = 2日目 ...
      const dayIndex = Math.floor(i / 2);
      const raceDate = meetDates[dayIndex] || null;

      races.push({
        meetColumn: i,
        raceDate,
        raceNo: Number(raceNoText),
        course: Number(courseText),
        st,
        flying,
        finish,
        finishCode
      });
    }

    const calcAvgST = list => {
      const values = list
        .filter(r => r.st !== null && !r.flying)
        .map(r => r.st);

      return values.length
        ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3))
        : null;
    };

    const safeRaces = races.filter(r => {
      if (!r.raceDate) return false;
      if (r.raceDate < targetDate) return true;
      if (r.raceDate > targetDate) return false;
      return r.raceNo < targetRno;
    });

    // 時系列順で最後の1走を「前走」とする。
    // 同日ならレース番号が大きい方が後。
    const chronologicalSafe = [...safeRaces].sort((a, b) => {
      if (a.raceDate !== b.raceDate) return a.raceDate.localeCompare(b.raceDate);
      return a.raceNo - b.raceNo;
    });

    const last = chronologicalSafe.at(-1) || null;

    const previousRace = last
      ? {
          date: last.raceDate,
          raceNo: last.raceNo,
          course: last.course,
          st: last.st,
          flying: last.flying,
          finish: last.finish,
          finishCode: last.finishCode
        }
      : null;

    return {
      all: {
        races,
        avgST: calcAvgST(races),
        predictionSafe: false
      },
      safe: {
        races: chronologicalSafe,
        avgST: calcAvgST(chronologicalSafe),
        predictionSafe: true
      },
      previousRace
    };

  } catch (e) {
    return {
      all: { races: [], avgST: null, predictionSafe: false },
      safe: { races: [], avgST: null, predictionSafe: true },
      previousRace: null,
      error: String(e.message || e)
    };
  }
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

    // 開催日リンクから今節の日付を取得（例: 20260926〜20260930）
    const meetDates = [...new Set(
      $('a[href]').map((_, a) => {
        const href = $(a).attr('href') || '';
        const m = href.match(/[?&]hd=(\d{8})(?:&|$)/);
        const j = href.match(/[?&]jcd=(\d{2})(?:&|$)/);
        return m && (!j || j[1] === jcd) ? m[1] : null;
      }).get().filter(Boolean)
    )]
      .filter(d => d <= date)
      .sort();

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

      const meetData =
        extractCurrentMeet($, tr, meetDates, date, Number(rno));

      const currentMeet = meetData.all;
      const currentMeetSafe = meetData.safe;
      const previousRace = meetData.previousRace;
      
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

        currentMeet,

        currentMeetSafe,

        previousRace,
        
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
// STEP2-1
// 6選手のコース別成績を並列取得
// ========================================

const courseResults =
  await Promise.all(

    racers.map(r =>
      fetchCourseStats(
        r.registration
      )
    )

  );


racers.forEach((racer, index) => {

  const result =
    courseResults[index];


  racer.courseStats =
    result?.courses
    ?? null;


  if (result?.error) {

    racer.courseStatsError =
      result.error;

  }

});

// ========================================
// STEP2-4
// 前検タイム・モーター抽選結果を開催1回取得
// ========================================

const preInspectionResult =
  await fetchPreInspection(date, jcd);

racers.forEach(racer => {
  const pre =
    preInspectionResult?.racers?.[String(racer.registration)]
    ?? null;

  racer.preInspection = pre
    ? {
        // Prediction-use fields from the rankingmotor page.
        time: pre.time,
        timeRank: pre.timeRank
      }
    : null;

  // Equipment values from rankingmotor are verification-only.
  // Never overwrite the race-list motor/boat values when they disagree.
  racer.equipmentCheck = pre
    ? {
        motorMatched:
          racer.motor?.no != null &&
          pre.motorNo != null
            ? Number(racer.motor.no) === Number(pre.motorNo)
            : null,
        boatMatched:
          racer.boat?.no != null &&
          pre.boatNo != null
            ? Number(racer.boat.no) === Number(pre.boatNo)
            : null,
        sourceMotorNo: pre.motorNo,
        sourceMotorQuinellaRate: pre.motorQuinellaRate,
        sourceBoatNo: pre.boatNo,
        sourceBoatQuinellaRate: pre.boatQuinellaRate
      }
    : null;
});



    // ========================================
    // 成功
    // ========================================

    return res.json({

      ok: true,

      version: '2.3-step2-4-safecheck',

      source: url,

      date,

      jcd,

      rno: Number(rno),

      meetDates,

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



// ============================================================
// STEP2-3A v1.8
// 直前情報専用API・正式JSON化
// ============================================================
app.get('/api/beforeinfo', async (req, res) => {
  try {
    const date = String(req.query.date || '').replace(/\D/g, '');
    const jcd = String(req.query.jcd || '').padStart(2, '0');
    const rno = Number(req.query.rno);

    if (!/^\d{8}$/.test(date)) {
      return res.status(400).json({ ok: false, error: 'date must be YYYYMMDD' });
    }
    if (!/^\d{2}$/.test(jcd)) {
      return res.status(400).json({ ok: false, error: 'jcd must be 2 digits' });
    }
    if (!Number.isInteger(rno) || rno < 1 || rno > 12) {
      return res.status(400).json({ ok: false, error: 'rno must be 1-12' });
    }

    const source =
      `https://www.boatrace.jp/owpc/pc/race/beforeinfo?hd=${date}&jcd=${jcd}&rno=${rno}`;

    const html = await officialFetch(source);
    const $ = cheerio.load(html);

    const toNumber = (value) => {
      const text = String(value ?? '').replace(/,/g, '').trim();
      const m = text.match(/-?(?:\d+(?:\.\d+)?|\.\d+)/);
      if (!m) return null;
      const normalized = m[0].startsWith('-.')
        ? m[0].replace('-.', '-0.')
        : m[0].startsWith('.')
          ? `0${m[0]}`
          : m[0];
      return Number(normalized);
    };

    const normalizeFinish = (value) => {
      const z = String(value ?? '').trim()
        .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
      const n = Number(z);
      return Number.isInteger(n) && n >= 1 && n <= 6 ? n : null;
    };

    // ---- Racer before-info table ----
    let racerTable = null;
    $('table').each((_, table) => {
      const header = clean($(table).text());
      if (!racerTable && header.includes('展示タイム') && header.includes('チルト')) {
        racerTable = table;
      }
    });

    const racers = [];

    if (racerTable) {
      const rows = $(racerTable).find('tr').toArray();

      for (let i = 0; i < rows.length; i++) {
        const cells = $(rows[i]).children('td').toArray().map(td => clean($(td).text()));

        // Main racer row begins with lane number and contains exhibition/tilt.
        const lane = Number(cells[0]);
        if (!Number.isInteger(lane) || lane < 1 || lane > 6 || cells.length < 8) continue;

        const next1 = rows[i + 1]
          ? $(rows[i + 1]).children('td').toArray().map(td => clean($(td).text()))
          : [];
        const next2 = rows[i + 2]
          ? $(rows[i + 2]).children('td').toArray().map(td => clean($(td).text()))
          : [];
        const next3 = rows[i + 3]
          ? $(rows[i + 3]).children('td').toArray().map(td => clean($(td).text()))
          : [];

        const previousRaceNo = toNumber(cells[9]);
        const previousCourse = toNumber(next1[1]);
        const previousStRaw = next2[2] || '';
        const previousFinishRaw = next3[1] || '';

        let previousSt = null;
        let previousFlying = false;
        if (previousStRaw) {
          previousFlying = /^F/i.test(previousStRaw);
          const stNum = toNumber(previousStRaw);
          previousSt = stNum;
        }

        const previousRace =
          previousRaceNo != null
            ? {
                raceNo: previousRaceNo,
                course: previousCourse,
                st: previousSt,
                flying: previousFlying,
                finish: normalizeFinish(previousFinishRaw),
                finishCode:
                  normalizeFinish(previousFinishRaw) == null && previousFinishRaw
                    ? previousFinishRaw
                    : null
              }
            : null;

        racers.push({
          lane,
          name: cells[2] || null,
          weight: toNumber(cells[3]),
          exhibitionTime: toNumber(cells[4]),
          tilt: toNumber(cells[5]),
          propeller: cells[6] || null,
          partsExchange: cells[7] || null,
          adjustWeight: toNumber(next2[0]),
          previousRace
        });
      }
    }

    // ---- Start exhibition table ----
    let startTable = null;
    $('table').each((_, table) => {
      const header = clean($(table).text());
      if (!startTable && header.includes('スタート展示') && header.includes('コース')) {
        startTable = table;
      }
    });

    const startExhibition = [];

    if (startTable) {
      $(startTable).find('tr').each((_, tr) => {
        const text = clean($(tr).text());
        // Examples: "1 .13", "4 F.01"
        const m = text.match(/^([1-6])\s+(F)?\.?(\d{1,2})$/i);
        if (!m) return;

        const lane = Number(m[1]);
        const flying = Boolean(m[2]);
        const st = Number(`0.${m[3].padStart(2, '0')}`);

        // Rows are rendered in course order; the leading displayed number is boat/lane.
        startExhibition.push({
          course: startExhibition.length + 1,
          lane,
          st,
          flying,
          raw: text
        });
      });
    }

    // Start exhibition rows are displayed in course order.
    // The leading number in each row is the boat/lane number.
    const entryOrder = startExhibition.map(x => x.lane);
    const isWakunari =
      entryOrder.length === 6 &&
      entryOrder.every((lane, index) => lane === index + 1);
    const entryMappingVerified = entryOrder.length === 6;

    // ---- Water / weather information ----
    // BOAT RACE beforeinfo exposes these values on the same page.
    // We search compact text around the labels and keep null when unavailable.
    const bodyText = clean($('body').text());

    const valueAfter = (label, pattern) => {
      const pos = bodyText.indexOf(label);
      if (pos < 0) return null;
      const chunk = bodyText.slice(pos, pos + 120);
      const m = chunk.match(pattern);
      return m ? m[1] : null;
    };

    const airTempRaw = valueAfter('気温', /気温\s*(-?\d+(?:\.\d+)?)\s*℃?/);
    const waterTempRaw = valueAfter('水温', /水温\s*(-?\d+(?:\.\d+)?)\s*℃?/);
    const windSpeedRaw = valueAfter('風速', /風速\s*(\d+(?:\.\d+)?)\s*m/);
    const waveHeightRaw = valueAfter('波高', /波高\s*(\d+(?:\.\d+)?)\s*cm/);

    let weatherText = null;
    // Official beforeinfo does not necessarily print a literal "天候" label.
    // The weather word is displayed between 気温 and 風速.
    const weatherMatch = bodyText.match(
      /気温\s*-?\d+(?:\.\d+)?\s*℃?\s*([^\d℃]{1,12}?)\s*風速/
    );
    if (weatherMatch) {
      weatherText = clean(weatherMatch[1]) || null;
    }

    const weather = {
      airTemperature: airTempRaw != null ? Number(airTempRaw) : null,
      weather: weatherText,
      windSpeed: windSpeedRaw != null ? Number(windSpeedRaw) : null,
      waterTemperature: waterTempRaw != null ? Number(waterTempRaw) : null,
      waveHeight: waveHeightRaw != null ? Number(waveHeightRaw) : null,
      windDirection: null
    };

    res.json({
      ok: true,
      version: '2.1-step2-3b-weather-entryfix',
      source,
      date,
      jcd,
      rno,
      weather,
      racers,
      startExhibition,
      entryOrder,
      isWakunari,
      entryMappingVerified
    });
  } catch (error) {
    console.error('beforeinfo error:', error);
    res.status(500).json({
      ok: false,
      version: '2.1-step2-3b-weather-entryfix',
      error: error.message
    });
  }
});


// ========================================
// STEP3 試作予想エンジン v2.4
// オッズは一切受け取らない / 参照しない
// 本線7点 + 差し頭2点 = 9点
// ========================================

const clamp = (v, min = 0, max = 100) => Math.max(min, Math.min(max, v));
const avg = values => {
  const xs = values.filter(Number.isFinite);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
};
const rankBonus = rank => ({ A1: 10, A2: 6, B1: 2, B2: -5 }[rank] ?? 0);

function buildPredictionFeatures(race, before) {
  const beforeByLane = new Map((before?.racers || []).map(x => [Number(x.lane), x]));
  const startByLane = new Map((before?.startExhibition || []).map(x => [Number(x.lane), x]));

  const exhibitionTimes = (before?.racers || [])
    .map(x => Number(x.exhibitionTime))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  const exhibitionRank = time => {
    if (!Number.isFinite(time)) return null;
    return [...new Set(exhibitionTimes)].indexOf(time) + 1;
  };

  return (race?.racers || []).map(r => {
    const lane = Number(r.lane);
    const direct = beforeByLane.get(lane) || {};
    const startEx = startByLane.get(lane) || {};
    const safeRaces = r.currentMeetSafe?.races || [];
    const last3 = safeRaces.slice(-3);

    const meetAvgST = avg(safeRaces.map(x => Number(x.st)));
    const recent3ST = avg(last3.map(x => Number(x.st)));

    const validFinishes = safeRaces.map(x => Number(x.finish)).filter(Number.isFinite);
    const recentFinishes = last3.map(x => Number(x.finish)).filter(Number.isFinite);
    const meetAvgFinish = avg(validFinishes);
    const recent3Finish = avg(recentFinishes);
    const top3Rate = validFinishes.length
      ? validFinishes.filter(x => x <= 3).length / validFinishes.length * 100
      : null;

    const actualCourse =
      (before?.entryOrder || []).indexOf(lane) >= 0
        ? (before.entryOrder.indexOf(lane) + 1)
        : lane;

    const course = r.courseStats?.[String(actualCourse)] || {};
    const exRank = exhibitionRank(Number(direct.exhibitionTime));

    // Separate feature groups.  These are intentionally not a single opaque score.
    const startScore = clamp(
      55
      + (Number.isFinite(meetAvgST) ? (0.16 - meetAvgST) * 240 : 0)
      + (Number.isFinite(recent3ST) ? (0.16 - recent3ST) * 160 : 0)
      + (Number.isFinite(Number(course.avgST)) ? (0.17 - Number(course.avgST)) * 100 : 0)
      + (Number.isFinite(Number(startEx.st)) ? (0.15 - Number(startEx.st)) * 120 : 0)
      - (Number(r.F || 0) * 9)
      - (startEx.flying ? 5 : 0)
    );

    const courseScore = clamp(
      35
      + (Number(course.trioRate) || 0) * 0.55
      + (Number.isFinite(Number(course.avgStartRank)) ? (4 - Number(course.avgStartRank)) * 5 : 0)
      + (actualCourse === 1 ? 8 : 0)
    );

    const formScore = clamp(
      50
      + (Number.isFinite(meetAvgFinish) ? (3.5 - meetAvgFinish) * 12 : 0)
      + (Number.isFinite(recent3Finish) ? (3.5 - recent3Finish) * 8 : 0)
      + (Number.isFinite(top3Rate) ? (top3Rate - 50) * 0.25 : 0)
    );

    const machineScore = clamp(
      42
      + (Number(r.motor?.quinellaRate) || 0) * 0.75
      + (Number(r.motor?.trioRate) || 0) * 0.25
      + (Number.isFinite(Number(r.preInspection?.timeRank))
          ? (8 - Number(r.preInspection.timeRank)) * 2
          : 0)
    );

    const directScore = clamp(
      50
      + (Number.isFinite(exRank) ? (7 - exRank) * 5 : 0)
      + (Number.isFinite(Number(startEx.st)) ? (0.15 - Number(startEx.st)) * 80 : 0)
      - (startEx.flying ? 4 : 0)
    );

    // This combined value is used only to order candidates.
    // The six component scores remain exposed so Kyokun can explain the reason.
    const orderScore =
      startScore * 0.24 +
      courseScore * 0.22 +
      formScore * 0.22 +
      machineScore * 0.14 +
      directScore * 0.18 +
      rankBonus(r.rank);

    return {
      lane,
      name: r.name,
      rank: r.rank,
      F: r.F,
      actualCourse,
      raw: {
        avgST: r.avgST,
        meetAvgST,
        recent3ST,
        meetAvgFinish,
        recent3Finish,
        top3Rate,
        courseTrioRate: course.trioRate ?? null,
        courseAvgST: course.avgST ?? null,
        courseAvgStartRank: course.avgStartRank ?? null,
        motorQuinellaRate: r.motor?.quinellaRate ?? null,
        motorTrioRate: r.motor?.trioRate ?? null,
        preInspectionRank: r.preInspection?.timeRank ?? null,
        exhibitionTime: direct.exhibitionTime ?? null,
        exhibitionRank: exRank,
        startExhibitionST: startEx.st ?? null,
        startExhibitionFlying: startEx.flying ?? null,
        tilt: direct.tilt ?? null,
        adjustWeight: direct.adjustWeight ?? null,
        partsExchange: direct.partsExchange ?? null
      },
      scores: {
        start: Math.round(startScore),
        course: Math.round(courseScore),
        form: Math.round(formScore),
        machine: Math.round(machineScore),
        direct: Math.round(directScore),
        order: Math.round(orderScore * 10) / 10
      }
    };
  });
}

function makeNineBets(features) {
  const sorted = [...features].sort((a, b) => b.scores.order - a.scores.order);

  // Main head: strongest overall candidate, with a modest inside-course preference.
  const mainHead = [...features].sort((a, b) => {
    const aa = a.scores.order + (a.actualCourse === 1 ? 7 : a.actualCourse === 2 ? 2 : 0);
    const bb = b.scores.order + (b.actualCourse === 1 ? 7 : b.actualCourse === 2 ? 2 : 0);
    return bb - aa;
  })[0];

  const followers = sorted.filter(x => x.lane !== mainHead.lane);

  const main = [];
  for (let i = 0; i < followers.length && main.length < 7; i++) {
    for (let j = 0; j < followers.length && main.length < 7; j++) {
      if (i === j) continue;
      main.push(`${mainHead.lane}-${followers[i].lane}-${followers[j].lane}`);
    }
  }

  // "差し頭": prefer the racer actually entering course 2 when viable.
  const course2 = features.find(x => x.actualCourse === 2 && x.lane !== mainHead.lane);
  const differenceHead =
    course2 && course2.scores.order >= 48
      ? course2
      : followers[0];

  const thirdCandidates = sorted
    .filter(x => x.lane !== differenceHead.lane && x.lane !== mainHead.lane)
    .slice(0, 2);

  const difference = thirdCandidates.map(
    x => `${differenceHead.lane}-${mainHead.lane}-${x.lane}`
  );

  while (difference.length < 2) {
    const fallback = followers.find(
      x => x.lane !== differenceHead.lane &&
           !difference.some(b => b.endsWith(`-${x.lane}`))
    );
    if (!fallback) break;
    difference.push(`${differenceHead.lane}-${mainHead.lane}-${fallback.lane}`);
  }

  const top = sorted[0]?.scores.order ?? 0;
  const second = sorted[1]?.scores.order ?? 0;
  const spread = top - second;
  const confidence =
    spread >= 12 ? '高め' :
    spread >= 6 ? 'やや高め' :
    spread >= 2 ? '中' : '低め';

  return {
    mainHead: mainHead.lane,
    differenceHead: differenceHead?.lane ?? null,
    main: main.slice(0, 7),
    difference: difference.slice(0, 2),
    all: [...main.slice(0, 7), ...difference.slice(0, 2)],
    confidence
  };
}

app.post('/api/predict', (req, res) => {
  try {
    const { race, before } = req.body || {};

    if (!race?.ok || !Array.isArray(race?.racers)) {
      return res.status(400).json({ ok: false, error: 'valid race data is required' });
    }
    if (!before?.ok) {
      return res.status(400).json({ ok: false, error: 'valid beforeinfo data is required' });
    }

    const features = buildPredictionFeatures(race, before);
    const bets = makeNineBets(features);

    res.json({
      ok: true,
      version: '2.4-step3-kyokun-prototype',
      predictionSafe: true,
      oddsUsed: false,
      date: race.date,
      jcd: race.jcd,
      rno: race.rno,
      entryOrder: before.entryOrder || null,
      isWakunari: before.isWakunari ?? null,
      weather: before.weather || null,
      predictionFeatures: features,
      prediction: {
        style: '本線7点 + 差し頭2点',
        confidence: bets.confidence,
        mainHead: bets.mainHead,
        differenceHead: bets.differenceHead,
        main: bets.main,
        difference: bets.difference,
        all: bets.all
      }
    });
  } catch (error) {
    console.error('predict error:', error);
    res.status(500).json({
      ok: false,
      version: '2.4-step3-kyokun-prototype',
      error: error.message
    });
  }
});


app.listen(
  port,
  () =>
    console.log(
      `Kyokun API v0.6 running on ${port}`
    )
);
