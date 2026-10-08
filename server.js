import express from 'express';
import * as cheerio from 'cheerio';

const app = express();

app.use(express.json({ limit: '1mb' }));


const BOATRACE_VENUES = {
  '01':'桐生','02':'戸田','03':'江戸川','04':'平和島','05':'多摩川','06':'浜名湖',
  '07':'蒲郡','08':'常滑','09':'津','10':'三国','11':'びわこ','12':'住之江',
  '13':'尼崎','14':'鳴門','15':'丸亀','16':'児島','17':'宮島','18':'徳山',
  '19':'下関','20':'若松','21':'芦屋','22':'福岡','23':'唐津','24':'大村'
};

function classifyOfficialRacePage($, html, racersCount = 0) {
  const text = clean($('body').text());
  const hasRaceNav = /(?:1R|１R)/.test(text) && /(?:12R|１２R)/.test(text);
  const hasRacerHeader = text.includes('ボートレーサー') || text.includes('登録番号');
  if (racersCount === 6) return { status:'ready', message:'出走データ取得済み' };
  if (!hasRaceNav && !hasRacerHeader) return { status:'not_held', message:'この日、この場は開催データがありません' };
  return { status:'parse_error', message:`公式ページはありますが選手を6艇取得できませんでした (${racersCount}/6)` };
}

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

// ========================================
// v3.1 TURBO CACHE+
// Heavy repeated official pages are cached in memory.
// Also coalesces identical in-flight requests so 8 parallel
// backtest workers do not fetch the same page multiple times.
// Prediction logic/data parsing is unchanged.
// ========================================
const officialHtmlCache = new Map();
const officialInflight = new Map();
const CACHE_MAX = 6000; // v2.4: retained for official page cache; historical STEP① no longer requests racer course pages

function shouldCacheOfficial(url) {
  return url.includes('/pc/data/racersearch/course?') ||
         url.includes('/pc/race/rankingmotor?') ||
         url.includes('/pc/race/racelist?') ||
         url.includes('/pc/race/beforeinfo?') ||
         url.includes('/pc/race/raceresult?');
}

function cachePut(key, value) {
  if (officialHtmlCache.size >= CACHE_MAX) {
    const first = officialHtmlCache.keys().next().value;
    if (first !== undefined) officialHtmlCache.delete(first);
  }
  officialHtmlCache.set(key, value);
}

async function officialFetch(url) {
  const cacheable = shouldCacheOfficial(url);

  if (cacheable && officialHtmlCache.has(url)) {
    return officialHtmlCache.get(url);
  }

  // Even for non-cacheable pages, merge only simultaneous identical requests.
  if (officialInflight.has(url)) {
    return officialInflight.get(url);
  }

  const task = (async () => {
    const response = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 KyokunResearch/0.6',
        'accept-language': 'ja,en;q=0.8'
      }
    });

    if (!response.ok) {
      throw new Error(`official HTTP ${response.status}`);
    }

    const html = await response.text();
    if (cacheable) cachePut(url, html);
    return html;
  })();

  officialInflight.set(url, task);

  try {
    return await task;
  } finally {
    officialInflight.delete(url);
  }
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


// ========================================
// ⑦ 当地成績 ULTRA: 全国1日1CSV
// Source: BoatraceCSV race_cards (race.boatcast.jp bc_j_str3 derived)
// ========================================
app.get('/api/local-ultra', async (req,res)=>{
  try{
    const raw=String(req.query.date||'').replace(/-/g,'');
    if(!/^\d{8}$/.test(raw)) return res.status(400).json({ok:false,error:'dateはYYYYMMDD'});
    const y=raw.slice(0,4),m=raw.slice(4,6),d=raw.slice(6,8);
    const url=`https://boatracecsv.github.io/data/programs/race_cards/${y}/${m}/${d}.csv`;
    const r=await fetch(url,{headers:{'user-agent':'kyokun-boatrace-api/1.0'}});
    if(r.status===404) return res.json({ok:true,date:raw,empty:true,csv:''});
    if(!r.ok) throw new Error(`CSV HTTP ${r.status}`);
    const csv=await r.text();
    res.type('text/csv; charset=utf-8').send(csv);
  }catch(e){res.status(502).json({ok:false,error:e.message||String(e)})}
});

// Y 結果 ULTRA: 全国1日1CSV
app.get('/api/result-ultra', async (req,res)=>{
  try{
    const raw=String(req.query.date||'').replace(/-/g,'');
    if(!/^\d{8}$/.test(raw)) return res.status(400).json({ok:false,error:'dateはYYYYMMDD'});
    const y=raw.slice(0,4),m=raw.slice(4,6),d=raw.slice(6,8);
    const url=`https://boatracecsv.github.io/data/results/realtime/${y}/${m}/${d}.csv`;
    const r=await fetch(url,{headers:{'user-agent':'kyokun-boatrace-api/1.0'}});
    if(r.status===404) return res.type('text/csv; charset=utf-8').send('');
    if(!r.ok) throw new Error(`CSV HTTP ${r.status}`);
    res.type('text/csv; charset=utf-8').send(await r.text());
  }catch(e){res.status(502).json({ok:false,error:e.message||String(e)})}
});

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

    // DATA SYSTEM v2: race-level metadata available on the official race list.
    const pageText = clean($('body').text());
    const stableBoard = pageText.includes('安定板使用');
    const raceName =
      clean($('h2').first().text()) ||
      clean($('h3').first().text()) ||
      null;

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
      const pageState = classifyOfficialRacePage($, html, racers.length);
      const statusCode = pageState.status === 'not_held' ? 404 : 422;
      return res.status(statusCode).json({
        ok: false,
        status: pageState.status,
        error: pageState.message,
        venue: BOATRACE_VENUES[jcd] || jcd,
        source: url,
        date,
        jcd,
        rno: Number(rno),
        racers
      });
    }

    // ========================================
// DATA SYSTEM v2
// Heavy sub-fetches can be switched off in research export mode.
// Defaults stay ON so the existing prediction API remains backward compatible.
const includeCourseStats = String(req.query.includeCourseStats ?? '0') !== '0'; // v2.4 temporal-safety default
const includePreInspection = String(req.query.includePreInspection ?? '1') !== '0';

// STEP2-1: six racers' course stats (heavy: six additional source reads)
if (includeCourseStats) {
  const courseResults = await Promise.all(
    racers.map(r => fetchCourseStats(r.registration))
  );

  racers.forEach((racer, index) => {
    const result = courseResults[index];
    racer.courseStats = result?.courses ?? null;
    if (result?.error) racer.courseStatsError = result.error;
  });
} else {
  racers.forEach(racer => { racer.courseStats = null; });
}

// STEP2-4: pre-inspection/rankingmotor page.
// Not required by the current v2 STEP①/② RAW, so research export may skip it.
if (includePreInspection) {
  const preInspectionResult = await fetchPreInspection(date, jcd);

  racers.forEach(racer => {
    const pre = preInspectionResult?.racers?.[String(racer.registration)] ?? null;
    racer.preInspection = pre ? { time: pre.time, timeRank: pre.timeRank } : null;
    racer.equipmentCheck = pre
      ? {
          motorMatched: racer.motor?.no != null && pre.motorNo != null
            ? Number(racer.motor.no) === Number(pre.motorNo) : null,
          boatMatched: racer.boat?.no != null && pre.boatNo != null
            ? Number(racer.boat.no) === Number(pre.boatNo) : null,
          sourceMotorNo: pre.motorNo,
          sourceMotorQuinellaRate: pre.motorQuinellaRate,
          sourceBoatNo: pre.boatNo,
          sourceBoatQuinellaRate: pre.boatQuinellaRate
        }
      : null;
  });
} else {
  racers.forEach(racer => {
    racer.preInspection = null;
    racer.equipmentCheck = null;
  });
}



    // ========================================
    // 成功
    // ========================================

    return res.json({

      ok: true,

      version: '2.5-step3-national',

      status: 'ready',

      venue: BOATRACE_VENUES[jcd] || jcd,

      source: url,

      date,

      jcd,

      rno: Number(rno),

      raceName,
      stableBoard,
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

    if (racers.length !== 6 || startExhibition.length !== 6) {
      return res.status(409).json({
        ok: false,
        status: 'beforeinfo_not_ready',
        version: '2.5-step3-national',
        venue: BOATRACE_VENUES[jcd] || jcd,
        source,
        date,
        jcd,
        rno,
        message: '直前情報がまだ揃っていません。展示後にもう一度お試しください。'
      });
    }

    res.json({
      ok: true,
      status: 'ready',
      version: '2.5-step3-national',
      venue: BOATRACE_VENUES[jcd] || jcd,
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
      registration: r.registration,
      name: r.name,
      rank: r.rank,
      branch: r.branch,
      birthplace: r.birthplace,
      age: r.age,
      weight: r.weight,
      F: r.F,
      L: r.L,
      actualCourse,
      raw: {
        // v2 STEP① raw inputs. Keep these unscored so the new logic can be rebuilt from zero.
        nationalWinRate: r.national?.winRate ?? null,
        nationalQuinellaRate: r.national?.quinellaRate ?? null,
        nationalTrioRate: r.national?.trioRate ?? null,
        // v2 STEP② venue-specific raw inputs. Export only; do not score here.
        localWinRate: r.local?.winRate ?? null,
        localQuinellaRate: r.local?.quinellaRate ?? null,
        localTrioRate: r.local?.trioRate ?? null,
        courseStatsAll: r.courseStats ?? null,
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

function permutations3(lanes) {
  const out = [];
  for (const a of lanes) for (const b of lanes) for (const c of lanes) {
    if (a !== b && a !== c && b !== c) out.push([a,b,c]);
  }
  return out;
}

function makeTwelveBets(features) {
  const byLane = new Map(features.map(x => [x.lane, x]));
  const sorted = [...features].sort((a,b) => b.scores.order - a.scores.order);
  const rankIndex = new Map(sorted.map((x,i) => [x.lane, i]));

  // 120通りを「頭・2着・3着」の役割別に採点。
  // 本命は最も強い3点。△×☆は本命に入らなかった別シナリオの研究用。
  const scored = permutations3(features.map(x => x.lane)).map(([a,b,c]) => {
    const A=byLane.get(a), B=byLane.get(b), C=byLane.get(c);
    const insideHead = A.actualCourse===1 ? 7 : A.actualCourse===2 ? 2 : 0;
    const head = A.scores.order*0.58 + A.scores.start*0.16 + A.scores.course*0.14 + A.scores.direct*0.12 + insideHead;
    const second = B.scores.order*0.62 + B.scores.start*0.12 + B.scores.form*0.14 + B.scores.direct*0.12;
    const third = C.scores.order*0.68 + C.scores.form*0.14 + C.scores.machine*0.10 + C.scores.direct*0.08;
    const score = head*0.52 + second*0.30 + third*0.18;
    return { bet:`${a}-${b}-${c}`, lanes:[a,b,c], headLane:a, score };
  }).sort((a,b)=>b.score-a.score);

  const used = new Set();
  const take = (pool, n) => {
    const arr=[];
    for (const x of pool) {
      if (used.has(x.bet)) continue;
      used.add(x.bet); arr.push(x.bet);
      if (arr.length===n) break;
    }
    return arr;
  };

  const main = take(scored, 3);
  const mainHeads = new Set(main.map(x => Number(x.split('-')[0])));
  const strongestHead = Number(main[0]?.split('-')[0]);

  // △: 本命と近い評価。主に本命展開の着順ズレを拾う。
  const reservePool = scored.filter(x => x.headLane===strongestHead || mainHeads.has(x.headLane));
  const reserve = take(reservePool, 3);

  // ×: 別頭シナリオ。総合上位艇が頭になるケースを警戒。
  const cautionHeads = sorted.slice(0,4).map(x=>x.lane).filter(x=>!mainHeads.has(x));
  const cautionPool = scored.filter(x => cautionHeads.includes(x.headLane));
  const caution = take(cautionPool, 3);

  // ☆: さらに別頭。上記に入らない艇の中で成立度が高い3点。
  const starPool = scored.filter(x => !mainHeads.has(x.headLane) && !cautionHeads.includes(x.headLane));
  const star = take(starPool, 3);

  // 候補不足時は全120通りの上位から補完（重複なし）。
  const fill = arr => {
    for (const x of scored) {
      if (arr.length>=3) break;
      if (used.has(x.bet)) continue;
      used.add(x.bet); arr.push(x.bet);
    }
  };
  fill(reserve); fill(caution); fill(star);

  const top = scored[0]?.score ?? 0;
  const fourth = scored[3]?.score ?? 0;
  const spread = top-fourth;
  const confidence = spread>=10?'高め':spread>=5?'やや高め':spread>=2?'中':'低め';

  return {
    main, reserve, caution, star,
    all:[...main,...reserve,...caution,...star],
    confidence,
    strongestHead,
    candidateTop: scored.slice(0,20).map(x=>({bet:x.bet,score:Math.round(x.score*10)/10}))
  };
}

app.post('/api/predict', (req, res) => {
  try {
    const { race, before } = req.body || {};
    if (!race?.ok || !Array.isArray(race?.racers)) return res.status(400).json({ok:false,error:'valid race data is required'});
    if (!before?.ok) return res.status(400).json({ok:false,error:'valid beforeinfo data is required'});
    const features=buildPredictionFeatures(race,before);
    const bets=makeTwelveBets(features);
    res.json({
      ok:true, version:'2.7-step3c-bulk-backtest', predictionSafe:true, oddsUsed:false,
      date:race.date,jcd:race.jcd,rno:race.rno,
      entryOrder:before.entryOrder||null,isWakunari:before.isWakunari??null,weather:before.weather||null,
      predictionFeatures:features,
      prediction:{
        style:'○本命3点 + △抑え3点 + ×注意3点 + ☆穴目3点',
        confidence:bets.confidence,
        mainHead:bets.strongestHead,
        main:bets.main,reserve:bets.reserve,caution:bets.caution,star:bets.star,all:bets.all,
        candidateTop:bets.candidateTop
      }
    });
  } catch(error) {
    console.error('predict error:',error);
    res.status(500).json({ok:false,version:'2.7-step3c-bulk-backtest',error:error.message});
  }
});


// ============================================================
// v2正式試用基盤：①全国共通 → ②-A当地成績 → ②-B場×枠
// ③④⑤・展示・オッズは使用しない。
// ============================================================
const V2_B_PRIOR = {"01-1":{"p":0.5262045539682702,"base":0.5550718328254245},"01-2":{"p":0.16087591499529214,"base":0.1417065737919025},"01-3":{"p":0.1315416468396594,"base":0.1262516325642142},"01-4":{"p":0.08563621913314637,"base":0.09229429690901175},"01-5":{"p":0.0598265179050531,"base":0.05790161079669134},"01-6":{"p":0.035915147158578936,"base":0.02677405311275577},"02-1":{"p":0.5012046055388405,"base":0.5550718328254245},"02-2":{"p":0.16707567859105502,"base":0.1417065737919025},"02-3":{"p":0.12470802462024085,"base":0.1262516325642142},"02-4":{"p":0.10411910862248795,"base":0.09229429690901175},"02-5":{"p":0.06927475915535894,"base":0.05790161079669134},"02-6":{"p":0.03361782347201676,"base":0.02677405311275577},"03-1":{"p":0.5229958330741962,"base":0.5550718328254245},"03-2":{"p":0.13607478254688904,"base":0.1417065737919025},"03-3":{"p":0.14349573090010928,"base":0.1262516325642142},"03-4":{"p":0.0955583147494958,"base":0.09229429690901175},"03-5":{"p":0.06780694428402619,"base":0.05790161079669134},"03-6":{"p":0.034068394445283555,"base":0.02677405311275577},"04-1":{"p":0.4816167541186445,"base":0.5550718328254245},"04-2":{"p":0.15879293357468552,"base":0.1417065737919025},"04-3":{"p":0.1664482276653759,"base":0.1262516325642142},"04-4":{"p":0.09068120889947988,"base":0.09229429690901175},"04-5":{"p":0.07257979515615333,"base":0.05790161079669134},"04-6":{"p":0.029881080585660934,"base":0.02677405311275577},"05-1":{"p":0.5631176788903853,"base":0.5550718328254245},"05-2":{"p":0.14565727747285162,"base":0.1417065737919025},"05-3":{"p":0.1290895479272029,"base":0.1262516325642142},"05-4":{"p":0.08985714808832326,"base":0.09229429690901175},"05-5":{"p":0.04107551906387445,"base":0.05790161079669134},"05-6":{"p":0.03120282855736251,"base":0.02677405311275577},"06-1":{"p":0.5524664106523911,"base":0.5550718328254245},"06-2":{"p":0.1389803446505895,"base":0.1417065737919025},"06-3":{"p":0.12084482484103028,"base":0.1262516325642142},"06-4":{"p":0.09836025417340756,"base":0.09229429690901175},"06-5":{"p":0.05519263979370401,"base":0.05790161079669134},"06-6":{"p":0.03415552588887763,"base":0.02677405311275577},"07-1":{"p":0.5679738221877307,"base":0.5550718328254245},"07-2":{"p":0.12864487706081656,"base":0.1417065737919025},"07-3":{"p":0.12568023508924683,"base":0.1262516325642142},"07-4":{"p":0.08548603092881074,"base":0.09229429690901175},"07-5":{"p":0.06135957108515833,"base":0.05790161079669134},"07-6":{"p":0.030855463648236832,"base":0.02677405311275577},"08-1":{"p":0.5605641225396971,"base":0.5550718328254245},"08-2":{"p":0.143003459890475,"base":0.1417065737919025},"08-3":{"p":0.09802717503379695,"base":0.1262516325642142},"08-4":{"p":0.10647068258369041,"base":0.09229429690901175},"08-5":{"p":0.06731663726141648,"base":0.05790161079669134},"08-6":{"p":0.02461792269092409,"base":0.02677405311275577},"09-1":{"p":0.5926258485302891,"base":0.5550718328254245},"09-2":{"p":0.12116045082958449,"base":0.1417065737919025},"09-3":{"p":0.12789427433528436,"base":0.1262516325642142},"09-4":{"p":0.07513624856898693,"base":0.09229429690901175},"09-5":{"p":0.056898893887357097,"base":0.05790161079669134},"09-6":{"p":0.02628428384849804,"base":0.02677405311275577},"10-1":{"p":0.5681603253601154,"base":0.5550718328254245},"10-2":{"p":0.13712420246370308,"base":0.1417065737919025},"10-3":{"p":0.131748911344069,"base":0.1262516325642142},"10-4":{"p":0.08344179789666416,"base":0.09229429690901175},"10-5":{"p":0.05290571249187215,"base":0.05790161079669134},"10-6":{"p":0.026619050443576233,"base":0.02677405311275577},"11-1":{"p":0.5662996784700841,"base":0.5550718328254245},"11-2":{"p":0.1454007584539289,"base":0.1417065737919025},"11-3":{"p":0.11144656991046467,"base":0.1262516325642142},"11-4":{"p":0.09267195031759604,"base":0.09229429690901175},"11-5":{"p":0.05922969195021269,"base":0.05790161079669134},"11-6":{"p":0.024951350897713626,"base":0.02677405311275577},"12-1":{"p":0.526476842704531,"base":0.5550718328254245},"12-2":{"p":0.14745508355379927,"base":0.1417065737919025},"12-3":{"p":0.14723636180971836,"base":0.1262516325642142},"12-4":{"p":0.10446841197548642,"base":0.09229429690901175},"12-5":{"p":0.04947192826764006,"base":0.05790161079669134},"12-6":{"p":0.02489137168882489,"base":0.02677405311275577},"13-1":{"p":0.5689964796661313,"base":0.5550718328254245},"13-2":{"p":0.14728731628961314,"base":0.1417065737919025},"13-3":{"p":0.1190739795535406,"base":0.1262516325642142},"13-4":{"p":0.10228202452974645,"base":0.09229429690901175},"13-5":{"p":0.04866448741236695,"base":0.05790161079669134},"13-6":{"p":0.013695712548601625,"base":0.02677405311275577},"14-1":{"p":0.5000366494007268,"base":0.5550718328254245},"14-2":{"p":0.14882988458770535,"base":0.1417065737919025},"14-3":{"p":0.14604675130827255,"base":0.1262516325642142},"14-4":{"p":0.10576239638214886,"base":0.09229429690901175},"14-5":{"p":0.08056204632484251,"base":0.05790161079669134},"14-6":{"p":0.018762271996303963,"base":0.02677405311275577},"15-1":{"p":0.5406698955158904,"base":0.5550718328254245},"15-2":{"p":0.13856660861993905,"base":0.1417065737919025},"15-3":{"p":0.13203227035263387,"base":0.1262516325642142},"15-4":{"p":0.09830893556813235,"base":0.09229429690901175},"15-5":{"p":0.06743850674793209,"base":0.05790161079669134},"15-6":{"p":0.022983783195472358,"base":0.02677405311275577},"16-1":{"p":0.5192653042429926,"base":0.5550718328254245},"16-2":{"p":0.14505123739995313,"base":0.1417065737919025},"16-3":{"p":0.1352171310404876,"base":0.1262516325642142},"16-4":{"p":0.10687225812933258,"base":0.09229429690901175},"16-5":{"p":0.05908731288302468,"base":0.05790161079669134},"16-6":{"p":0.034506756304209504,"base":0.02677405311275577},"17-1":{"p":0.5485060371558289,"base":0.5550718328254245},"17-2":{"p":0.12587070091423597,"base":0.1417065737919025},"17-3":{"p":0.13584266967561948,"base":0.1262516325642142},"17-4":{"p":0.10831341679031213,"base":0.09229429690901175},"17-5":{"p":0.05760286265137313,"base":0.05790161079669134},"17-6":{"p":0.023864312812630496,"base":0.02677405311275577},"18-1":{"p":0.6089464518937745,"base":0.5550718328254245},"18-2":{"p":0.12955770979797154,"base":0.1417065737919025},"18-3":{"p":0.10458001612089812,"base":0.1262516325642142},"18-4":{"p":0.08281895886584742,"base":0.09229429690901175},"18-5":{"p":0.05094139148351056,"base":0.05790161079669134},"18-6":{"p":0.023155471837997908,"base":0.02677405311275577},"19-1":{"p":0.6060173004486004,"base":0.5550718328254245},"19-2":{"p":0.11234052923472962,"base":0.1417065737919025},"19-3":{"p":0.11752806117620337,"base":0.1262516325642142},"19-4":{"p":0.08005124832011509,"base":0.09229429690901175},"19-5":{"p":0.053207397172114854,"base":0.05790161079669134},"19-6":{"p":0.030855463648236832,"base":0.02677405311275577},"20-1":{"p":0.5673422273199157,"base":0.5550718328254245},"20-2":{"p":0.14745508355379927,"base":0.1417065737919025},"20-3":{"p":0.11358251565587221,"base":0.1262516325642142},"20-4":{"p":0.09244918120625566,"base":0.09229429690901175},"20-5":{"p":0.056683466729178525,"base":0.05790161079669134},"20-6":{"p":0.022487525534978736,"base":0.02677405311275577},"21-1":{"p":0.6032999091442525,"base":0.5550718328254245},"21-2":{"p":0.1340796596695122,"base":0.1417065737919025},"21-3":{"p":0.0903541481327251,"base":0.1262516325642142},"21-4":{"p":0.08548603092881074,"base":0.09229429690901175},"21-5":{"p":0.053207397172114854,"base":0.05790161079669134},"21-6":{"p":0.033572854952584656,"base":0.02677405311275577},"22-1":{"p":0.5841691503968387,"base":0.5550718328254245},"22-2":{"p":0.15707046816918388,"base":0.1417065737919025},"22-3":{"p":0.12079405411741068,"base":0.1262516325642142},"22-4":{"p":0.07081456582164027,"base":0.09229429690901175},"22-5":{"p":0.04466423595994776,"base":0.05790161079669134},"22-6":{"p":0.022487525534978736,"base":0.02677405311275577},"23-1":{"p":0.5515234064892828,"base":0.5550718328254245},"23-2":{"p":0.144637186611693,"base":0.1417065737919025},"23-3":{"p":0.1259203180619222,"base":0.1262516325642142},"23-4":{"p":0.08992227713897924,"base":0.09229429690901175},"23-5":{"p":0.06463353735050834,"base":0.05790161079669134},"23-6":{"p":0.023363274347614538,"base":0.02677405311275577},"24-1":{"p":0.5866692241710023,"base":0.5550718328254245},"24-2":{"p":0.13698345237222895,"base":0.1417065737919025},"24-3":{"p":0.13180773889317535,"base":0.1262516325642142},"24-4":{"p":0.07786846381634245,"base":0.09229429690901175},"24-5":{"p":0.04846614395875808,"base":0.05790161079669134},"24-6":{"p":0.018204976788492956,"base":0.02677405311275577}};
const V2_LOCAL_SD = { win:2.04915371, quinella:18.92311134, trio:23.80109755 };
const V2_LOCAL_BETA = { win:0.07771454, quinella:0.37743058, trio:-0.01690914 };
const v2Finite = v => Number.isFinite(Number(v)) ? Number(v) : null;
const v2Mean = a => { const x=a.filter(Number.isFinite); return x.length ? x.reduce((s,v)=>s+v,0)/x.length : null; };
const v2Logit = p => Math.log(Math.max(1e-9,p)/Math.max(1e-9,1-p));
const v2Softmax = scores => { const m=Math.max(...scores); const e=scores.map(x=>Math.exp(x-m)); const z=e.reduce((a,b)=>a+b,0); return e.map(x=>x/z); };

app.post('/api/v2-base-predict', (req, res) => {
  try {
    const race=req.body?.race;
    if(!race?.ok || !Array.isArray(race.racers) || race.racers.length!==6)
      return res.status(400).json({ok:false,error:'valid six-racer race data is required'});

    // STEP①: frozen existing implementation.
    const C={wrMean:5.29233035,wrSd:1.32939332,diffMean:0.00237223,diffSd:1.07958259,c3DiffSd:22.87066632};
    const boatAdj={1:0,2:-1.7,3:-1.9,4:-2.0,5:-2.6,6:-3.0};
    const wr=race.racers.map(r=>v2Finite(r.national?.winRate));
    const c3=race.racers.map(r=>v2Finite(r.courseStats?.[String(r.lane)]?.trioRate));
    const mw=v2Mean(wr), mc=v2Mean(c3);

    // STEP②-A: 2026-09 4,594Rで再推定し、2026-08 4,916Rへ固定適用して再現確認。
    const lw=race.racers.map(r=>v2Finite(r.local?.winRate));
    const lq=race.racers.map(r=>v2Finite(r.local?.quinellaRate));
    const lt=race.racers.map(r=>v2Finite(r.local?.trioRate));
    const mlw=v2Mean(lw), mlq=v2Mean(lq), mlt=v2Mean(lt);

    const rows=race.racers.map((r,i)=>{
      const w=wr[i], c=c3[i];
      const zAbs=w===null?0:(w-C.wrMean)/C.wrSd;
      const zWD=(w===null||mw===null)?0:((w-mw)-C.diffMean)/C.diffSd;
      const zC=(c===null||mc===null)?0:(c-mc)/C.c3DiffSd;
      const step1=(boatAdj[r.lane]??0)+0.16*zAbs+0.68*zWD+0.25*zC;

      const zLW=(lw[i]===null||mlw===null)?0:(lw[i]-mlw)/V2_LOCAL_SD.win;
      const zLQ=(lq[i]===null||mlq===null)?0:(lq[i]-mlq)/V2_LOCAL_SD.quinella;
      const zLT=(lt[i]===null||mlt===null)?0:(lt[i]-mlt)/V2_LOCAL_SD.trio;
      const step2ACorrection=V2_LOCAL_BETA.win*zLW+V2_LOCAL_BETA.quinella*zLQ+V2_LOCAL_BETA.trio*zLT;
      const step2AScore=step1+step2ACorrection;

      const bp=V2_B_PRIOR[`${String(race.jcd).padStart(2,'0')}-${r.lane}`]||null;
      const step2BPrior=bp?.p??null, nationalLanePrior=bp?.base??null;
      const step2BDifference=(step2BPrior!=null&&nationalLanePrior!=null)?step2BPrior-nationalLanePrior:null;
      // 試用ランキングへの接続は、確率差を尺度整合させるため log-odds差で加える。
      // ②-B正式保存値そのものは prior/difference として別途保持する。
      const step2BCorrection=(step2BPrior!=null&&nationalLanePrior!=null)?v2Logit(step2BPrior)-v2Logit(nationalLanePrior):0;
      const finalScore=step2AScore+step2BCorrection;
      return {lane:r.lane,registration:r.registration,name:r.name,rank:r.rank,
        // 旧①②画面との互換フィールド（既存UIを壊さない）
        nationalWinRate:w,currentCourseTrioRate:c,
        step1Score:step1,
        step2Correction:step2ACorrection+step2BCorrection,
        step2Score:finalScore,
        // v2詳細フィールド
        inputs:{nationalWinRate:w,currentCourseTrioRate:c,localWinRate:lw[i],localQuinellaRate:lq[i],localTrioRate:lt[i]},
        step1:{score:step1,components:{boatAdjustment:boatAdj[r.lane]??0,nationalWinZ:zAbs,nationalWinRaceDiffZ:zWD,currentCourseTrioRaceDiffZ:zC}},
        step2A:{correction:step2ACorrection,score:step2AScore,components:{localWinZ:zLW,localQuinellaZ:zLQ,localTrioZ:zLT}},
        step2B:{prior:step2BPrior,nationalLanePrior,difference:step2BDifference,correction:step2BCorrection,applied:bp!==null},
        finalScore};
    });
    const probs=v2Softmax(rows.map(x=>x.finalScore)); rows.forEach((x,i)=>x.trialWinProbability=probs[i]);
    rows.sort((a,b)=>b.finalScore-a.finalScore);
    res.json({ok:true,logicVersion:'v2-trial-①+②A+②B-20261005',trial:true,oddsUsed:false,stepsIncluded:['①全国共通','②-A当地成績','②-B場×枠'],stepsExcluded:['③節限定','④当日限定','⑤レース限定'],date:race.date,jcd:race.jcd,rno:race.rno,venue:race.venue,
      notes:['②-A係数は9月4,594Rで再推定し8月4,916Rへ固定適用して再現確認','②-Bは強度200縮小144セル','trialWinProbabilityは①②接続確認用で最終予想確率ではない'],ranking:rows});
  } catch(error){ res.status(500).json({ok:false,error:error.message}); }
});

app.get('/v2-test', (req,res)=>res.type('html').send(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>キョウ君 v2 試用版</title><style>body{font-family:sans-serif;max-width:980px;margin:auto;padding:18px;background:#f5f7fb;color:#172033}h1{font-size:22px}.box{background:white;border-radius:12px;padding:14px;margin:12px 0;box-shadow:0 2px 10px #0001}select,input,button{font-size:16px;padding:10px;margin:4px}button{font-weight:bold}table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:8px;border-bottom:1px solid #ddd;text-align:right}th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}.rank1{background:#fff7d6}.muted{color:#667085;font-size:13px}.pos{color:#087a3e}.neg{color:#b42318}</style><h1>キョウ君 BOATRACE AI v2 試用版</h1><div class=box><b>①全国共通 → ②-A当地成績 → ②-B場固有</b><div class=muted>③④⑤・展示・オッズはまだ使いません。</div><input id=d type=date><select id=j>${Object.entries(BOATRACE_VENUES).map(([c,n])=>`<option value="${c}">${c} ${n}</option>`).join('')}</select><select id=r>${Array.from({length:12},(_,i)=>`<option value="${i+1}">${i+1}R</option>`).join('')}</select><button onclick="go()">評価する</button><span id=s></span></div><div id=o></div><script>document.getElementById('d').value=new Date().toISOString().slice(0,10);const f=n=>Number(n).toFixed(3),pct=n=>n==null?'-':(n*100).toFixed(1)+'%';async function go(){s.textContent='取得中…';o.innerHTML='';try{let date=d.value.replaceAll('-',''),jcd=j.value,rno=r.value;let race=await fetch('/api/race?date='+date+'&jcd='+jcd+'&rno='+rno+'&includeCourseStats=1&includePreInspection=0').then(x=>x.json());if(!race.ok)throw Error(race.error||'race取得失敗');let z=await fetch('/api/v2-base-predict',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({race})}).then(x=>x.json());if(!z.ok)throw Error(z.error);s.textContent='完了';o.innerHTML='<div class=box><h2>'+z.venue+' '+z.rno+'R</h2><table><tr><th>順位</th><th>艇/選手</th><th>級</th><th>①</th><th>②-A補正</th><th>②-B補正</th><th>②-B事前率</th><th>試用確率</th></tr>'+z.ranking.map((x,i)=>'<tr class="'+(i===0?'rank1':'')+'"><td>'+(i+1)+'</td><td>'+x.lane+'号艇 '+x.name+'</td><td>'+x.rank+'</td><td>'+f(x.step1.score)+'</td><td class="'+(x.step2A.correction>=0?'pos':'neg')+'">'+f(x.step2A.correction)+'</td><td class="'+(x.step2B.correction>=0?'pos':'neg')+'">'+f(x.step2B.correction)+'</td><td>'+pct(x.step2B.prior)+'</td><td><b>'+pct(x.trialWinProbability)+'</b></td></tr>').join('')+'</table><p class=muted>※ 試用確率は①〜②の接続確認用。最終予想・買い目ではありません。</p></div>'}catch(e){s.textContent='エラー';o.innerHTML='<div class=box>'+e.message+'</div>'}}</script></html>`));

// ============================================================
// STEP3-C 開催場一覧API（日付 → その日に開催している場）
// ============================================================
app.get('/api/venues', async (req,res)=>{
  try {
    const date=String(req.query.date||'').replace(/\D/g,'');
    if(!/^\d{8}$/.test(date)) return res.status(400).json({ok:false,error:'date is required (YYYYMMDD)'});
    const source=`https://www.boatrace.jp/owpc/pc/race/index?hd=${date}`;
    const html=await officialFetch(source);
    const $=cheerio.load(html);
    const found=new Set();
    $('a[href]').each((_,a)=>{
      const href=String($(a).attr('href')||'');
      const m=href.match(/[?&]jcd=(\d{1,2})/);
      if(!m) return;
      const jcd=String(m[1]).padStart(2,'0');
      if(BOATRACE_VENUES[jcd]) found.add(jcd);
    });
    // indexページ内のリンクから開催場だけを抽出。重複はSetで除去。
    const venueCodes=[...found].sort((a,b)=>Number(a)-Number(b));
    const venues=venueCodes.map(jcd=>({jcd,name:BOATRACE_VENUES[jcd]}));
    res.json({ok:true,version:'2.7-step3c-bulk-backtest',date,source,count:venues.length,venues});
  } catch(error){
    console.error('venues error:',error);
    res.status(500).json({ok:false,version:'2.7-step3c-bulk-backtest',error:error.message});
  }
});

// ============================================================
// STEP3-B 結果取得API（予想とは完全分離）
// ============================================================
app.get('/api/result', async (req,res)=>{
  try {
    const date=String(req.query.date||'').replace(/\D/g,'');
    const jcd=String(req.query.jcd||'').padStart(2,'0');
    const rno=Number(req.query.rno);
    if(!/^\d{8}$/.test(date)||!/^\d{2}$/.test(jcd)||!Number.isInteger(rno)||rno<1||rno>12)
      return res.status(400).json({ok:false,error:'date/jcd/rno are required'});
    const source=`https://www.boatrace.jp/owpc/pc/race/raceresult?hd=${date}&jcd=${jcd}&rno=${rno}`;
    const html=await officialFetch(source); const $=cheerio.load(html);
    const body=clean($('body').text());

    const finish=[];
    $('table').each((_,table)=>{
      const txt=clean($(table).text());
      if(!txt.includes('ボートレーサー')||!txt.includes('レースタイム')) return;
      $(table).find('tr').each((__,tr)=>{
        const cells=$(tr).find('td').map((___,td)=>clean($(td).text())).get();
        if(cells.length<3) return;
        const finishText=clean(cells[0]||'');
        const normalizedFinish=finishText.replace(/[１-６]/g,ch=>String.fromCharCode(ch.charCodeAt(0)-0xFEE0));
        const pos=Number(normalizedFinish);
        const lane=Number(cells[1]);
        if(lane<1||lane>6) return;
        // Keep non-numeric official result codes (e.g. 不/転/落/妨/失) as labels.
        // They are valid settled outcomes, not missing data, but must never be coerced to a numeric placing.
        if(pos>=1&&pos<=6) finish.push({finish:pos,finishCode:null,lane,racer:cells[2]||null,time:cells[3]||null});
        else if(finishText) finish.push({finish:null,finishCode:finishText,lane,racer:cells[2]||null,time:cells[3]||null});
      });
    });
    const numericFinish=finish.filter(x=>Number.isFinite(x.finish)).sort((a,b)=>a.finish-b.finish);
    if(numericFinish.length<3) return res.status(409).json({ok:false,status:'result_not_ready',message:'結果がまだ確定していません。',source,date,jcd,rno});
    // Keep all six settled outcomes in `finish`; use only numeric placings for the trifecta.
    finish.sort((a,b)=>(Number.isFinite(a.finish)?a.finish:99)-(Number.isFinite(b.finish)?b.finish:99));
    const trifecta=`${numericFinish[0].lane}-${numericFinish[1].lane}-${numericFinish[2].lane}`;

    let payout=null,popularity=null;
    $('tr').each((_,tr)=>{
      const cells=$(tr).find('th,td').map((__,x)=>clean($(x).text())).get();
      if(cells.some(x=>x==='3連単')) {
        const joined=cells.join(' ');
        const m=joined.match(/3連単\s+([1-6]-[1-6]-[1-6])\s+[¥￥]?([\d,]+)\s+(\d+)/);
        if(m&&m[1]===trifecta){ payout=Number(m[2].replace(/,/g,'')); popularity=Number(m[3]); }
      }
    });

    const startInfo=[];
    const startPos=body.indexOf('スタート情報');
    const payoutPos=body.indexOf('勝式',startPos);
    if(startPos>=0){
      const chunk=body.slice(startPos,payoutPos>startPos?payoutPos:startPos+500);
      const re=/([1-6])\s+(F)?\.?([0-9]{1,2})(?:\s+(逃げ|差し|まくり差し|まくり|抜き|恵まれ))?/g;
      let m,course=1;
      while((m=re.exec(chunk))!==null&&course<=6){startInfo.push({course,lane:Number(m[1]),st:Number(`0.${m[3].padStart(2,'0')}`),flying:Boolean(m[2]),winningMethod:m[4]||null});course++;}
    }
    const method=(body.match(/決まり手\s*(逃げ|差し|まくり差し|まくり|抜き|恵まれ)/)||[])[1]
      || startInfo.find(x=>x.winningMethod)?.winningMethod || null;

    // Preserve all payout rows for later EV/funding research without using them as prediction inputs.
    const payouts=[];
    $('tr').each((_,tr)=>{
      const cells=$(tr).find('th,td').map((__,x)=>clean($(x).text())).get().filter(Boolean);
      if(!cells.length) return;
      const bet=cells.find(x=>/^(3連単|3連複|2連単|2連複|拡連複|単勝|複勝)$/.test(x));
      if(!bet) return;
      payouts.push({bet,cells});
    });

    // Extract refund/remarks from their own table rows only.
    // Never regex the flattened body because that can swallow footer/CSS text.
    let refundText=null, remarksText=null;
    $('tr').each((_,tr)=>{
      const cells=$(tr).find('th,td').map((__,x)=>clean($(x).text())).get().filter(Boolean);
      if(!cells.length) return;
      const joined=cells.join(' ');
      // A header-only row such as ["返還"] / ["備考"] is not data.
      // Store only when the row contains an actual value beyond the label.
      const refundIdx=cells.findIndex(x=>x==='返還');
      const remarksIdx=cells.findIndex(x=>x==='備考');
      if(refundIdx>=0){
        const vals=cells.filter((_,i)=>i!==refundIdx).filter(x=>x && x!=='-');
        if(vals.length) refundText=vals.join(' ');
      }
      if(remarksIdx>=0){
        const vals=cells.filter((_,i)=>i!==remarksIdx).filter(x=>x && x!=='-');
        if(vals.length) remarksText=vals.join(' ');
      }
    });
    const stableBoard=body.includes('安定板使用');

    // STEP6: race-level water/weather. BOATRACE encodes wind direction in
    // the official CSS class is-wind1..is-wind16 (clockwise from North).
    const airTemperature=Number((body.match(/気温\s*([0-9.]+)℃/)||[])[1]);
    const weatherText=(body.match(/気温\s*[0-9.]+℃\s*([^0-9]{1,12}?)\s*風速/)||[])[1]?.trim()||null;
    const windSpeed=Number((body.match(/風速\s*([0-9.]+)m/)||[])[1]);
    const waterTemperature=Number((body.match(/水温\s*([0-9.]+)℃/)||[])[1]);
    const waveHeight=Number((body.match(/波高\s*([0-9.]+)cm/)||[])[1]);
    const windMap={1:'北',2:'北北東',3:'北東',4:'東北東',5:'東',6:'東南東',7:'南東',8:'南南東',9:'南',10:'南南西',11:'南西',12:'西南西',13:'西',14:'西北西',15:'北西',16:'北北西'};
    let windDirection=null, windDirectionNumber=null, windDirectionRaw=null;
    const windUnit=$('.weather1_bodyUnit.is-windDirection').first();
    const windImage=windUnit.find('.weather1_bodyUnitImage').first();
    const windClass=String(windImage.attr('class')||'');
    const wm=windClass.match(/(?:^|\s)is-wind(1[0-6]|[1-9])(?:\s|$)/);
    if(wm){
      windDirectionNumber=Number(wm[1]);
      windDirection=windMap[windDirectionNumber]||null;
      windDirectionRaw='is-wind'+windDirectionNumber;
    }
    // Official zero-wind state has no direction class. Preserve it explicitly.
    if(Number.isFinite(windSpeed)&&windSpeed===0){
      windDirection='無風';
      windDirectionNumber=0;
      windDirectionRaw='calm';
    }
    const deadlineTimes=[];
    $('tr').each((_,tr)=>{ const cells=$(tr).find('th,td').map((__,x)=>clean($(x).text())).get(); if(cells[0]==='締切予定時刻') deadlineTimes.push(...cells.slice(1).filter(x=>/^\d{1,2}:\d{2}$/.test(x))); });
    const deadline=deadlineTimes[Number(rno)-1]||null;
    let tide={station:'',status:'未取得'};
    try{ tide=await fetchStep6Tide(date,jcd,rno,deadline); }catch(e){ tide={station:STEP6_TIDE_STATIONS[String(jcd).padStart(2,'0')]?.name||'',status:'取得失敗:'+e.message}; }
    const weather={
      airTemperature:Number.isFinite(airTemperature)?airTemperature:null,
      windSpeed:Number.isFinite(windSpeed)?windSpeed:null,
      waterTemperature:Number.isFinite(waterTemperature)?waterTemperature:null,
      waveHeight:Number.isFinite(waveHeight)?waveHeight:null,
      windDirection,windDirectionNumber,windDirectionRaw,weather:weatherText
    };

    res.json({
      ok:true,version:'data-system-v3.0-step6-wind16-final-test',source,date,jcd,rno,
      trifecta,payout,popularity,winningMethod:method,
      finish,startInfo,entryOrder:startInfo.map(x=>x.lane),deadline,tide,
      payouts,refundText,remarksText,stableBoard,weather
    });
  } catch(error){
    console.error('result error:',error);
    res.status(500).json({ok:false,version:'2.7-step3c-bulk-backtest',error:error.message});
  }
});




// ============================================================
// 住之江攻略：場特性データ一括取得UI（1〜6か月）
// ①/②-Aや選手能力は取得しない。既存 /api/result の公式結果・気象だけを使用。
// ============================================================
app.get('/suminoe-data', (req,res)=>res.type('html').send(`<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>住之江データ取得</title><style>
body{font-family:system-ui,sans-serif;max-width:980px;margin:auto;padding:18px;background:#f5f7fb;color:#172033}.box{background:#fff;border-radius:14px;padding:16px;margin:12px 0;box-shadow:0 2px 12px #0001}h1{font-size:24px}select,input,button{font-size:16px;padding:10px;margin:5px}button{font-weight:700;cursor:pointer}.bar{height:16px;background:#e5e7eb;border-radius:8px;overflow:hidden}.bar>div{height:100%;width:0;background:#2563eb;transition:.2s}.muted{color:#667085;font-size:13px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{border-bottom:1px solid #eee;padding:6px;text-align:center}.ok{color:#087a3e}.err{color:#b42318}</style></head><body>
<h1>🚤 住之江・場特性データ取得</h1><div class="box"><b>選手情報なし／①・②-A再取得なし</b><div class="muted">住之江(12)の結果・進入・本番ST・決まり手・風向/風速・波高・気温・水温等だけを取得します。</div><br>
<label>開始月 <input id="start" type="month"></label><label>期間 <select id="months">${[1,2,3,4,5,6].map(n=>`<option value="${n}">${n}か月</option>`).join('')}</select></label>
<button id="go" onclick="run()">取得開始</button><button id="dl" onclick="downloadCsv()" disabled>Excel用CSV保存</button></div>
<div class="box"><div id="status">待機中</div><div class="bar"><div id="prog"></div></div><div id="detail" class="muted"></div></div>
<div class="box"><b>取得結果</b><div id="summary" class="muted">まだありません</div><div style="overflow:auto;max-height:420px"><table><thead><tr><th>日付</th><th>R</th><th>1-2-3着</th><th>進入</th><th>決まり手</th><th>風向</th><th>風速</th><th>波高</th></tr></thead><tbody id="rows"></tbody></table></div></div>
<script>
const JCD='12'; let DATA=[]; const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(function(){const d=new Date();d.setMonth(d.getMonth()-1);start.value=d.toISOString().slice(0,7)})();
function ymd(d){return d.getFullYear()+String(d.getMonth()+1).padStart(2,'0')+String(d.getDate()).padStart(2,'0')}
function rangeMonths(v,n){const [y,m]=v.split('-').map(Number);const a=new Date(y,m-1,1),b=new Date(y,m-1+n,0);return [a,b]}
function esc(v){v=v??'';return /[",\n]/.test(String(v))?'"'+String(v).replaceAll('"','""')+'"':String(v)}
async function json(url){const r=await fetch(url);let z;try{z=await r.json()}catch{throw Error('JSON取得失敗 '+r.status)};return {status:r.status,z}}
async function run(){
 DATA=[];rows.innerHTML='';dl.disabled=true;go.disabled=true;status.textContent='取得準備中…';
 try{
  if(!start.value)throw Error('開始月を選んでください'); const n=Number(months.value); const [a,b]=rangeMonths(start.value,n);
  const days=[];for(let d=new Date(a);d<=b;d.setDate(d.getDate()+1))days.push(new Date(d)); let done=0,held=0,errors=0;
  for(const d of days){const date=ymd(d);detail.textContent=date+' 開催確認中…';
   try{const vr=await json('/api/venues?date='+date);const isHeld=vr.z.ok&&vr.z.venues?.some(v=>v.jcd===JCD);
    if(isHeld){held++;detail.textContent=date+' 住之江 1〜12R取得中…';
      const batch=await Promise.all(Array.from({length:12},async(_,i)=>{const rno=i+1;try{const rr=await json('/api/result?date='+date+'&jcd='+JCD+'&rno='+rno);return {rno,...rr}}catch(e){return {rno,error:e.message}}}));
      for(const x of batch){if(x.z?.ok){const z=x.z;const byFinish=[...z.finish].filter(q=>Number.isFinite(q.finish)).sort((u,v)=>u.finish-v.finish);const byCourse=[...z.startInfo].sort((u,v)=>u.course-v.course);const rec={
       date,rno:x.rno,dayNo:'',finish:[1,2,3,4,5,6].map(pos=>byFinish.find(q=>q.finish===pos)?.lane??''),
       course:[1,2,3,4,5,6].map(c=>byCourse.find(q=>q.course===c)?.lane??''),st:[1,2,3,4,5,6].map(c=>byCourse.find(q=>q.course===c)?.st??''),
       method:z.winningMethod??'',windDirection:z.weather?.windDirection??'',windSpeed:z.weather?.windSpeed??'',waveHeight:z.weather?.waveHeight??'',airTemperature:z.weather?.airTemperature??'',waterTemperature:z.weather?.waterTemperature??'',weather:z.weather?.weather??'',
       abnormal:[z.refundText,z.remarksText,z.stableBoard?'安定板使用':''].filter(Boolean).join(' / '),note:''};DATA.push(rec);
       const tr=document.createElement('tr');tr.innerHTML='<td>'+date+'</td><td>'+x.rno+'R</td><td>'+rec.finish.slice(0,3).join('-')+'</td><td>'+rec.course.join('-')+'</td><td>'+rec.method+'</td><td>'+rec.windDirection+'</td><td>'+rec.windSpeed+'</td><td>'+rec.waveHeight+'</td>';rows.appendChild(tr);
      } else if(x.status!==409){errors++;}}
    }
   }catch(e){errors++;}
   done++;prog.style.width=(done/days.length*100).toFixed(1)+'%';status.textContent='取得中 '+done+'/'+days.length+'日';summary.textContent='開催 '+held+'日 / '+DATA.length+'R取得 / エラー '+errors; await sleep(80);
  }
  DATA.sort((a,b)=>a.date.localeCompare(b.date)||a.rno-b.rno);status.textContent='完了 🔥';detail.textContent='住之江 '+start.value+'から'+n+'か月';summary.textContent='開催 '+held+'日 / '+DATA.length+'R取得 / エラー '+errors;dl.disabled=DATA.length===0;
 }catch(e){status.textContent='エラー：'+e.message;}finally{go.disabled=false;}
}
function downloadCsv(){
 const h=['日付','R','開催日目','1着艇','2着艇','3着艇','4着艇','5着艇','6着艇','1コース艇','2コース艇','3コース艇','4コース艇','5コース艇','6コース艇','1コースST','2コースST','3コースST','4コースST','5コースST','6コースST','決まり手','風向','風速(m/s)','波高(cm)','気温(℃)','水温(℃)','天候','異常・返還','備考'];
 const lines=[h.map(esc).join(',')];for(const x of DATA){lines.push([x.date,x.rno,x.dayNo,...x.finish,...x.course,...x.st,x.method,x.windDirection,x.windSpeed,x.waveHeight,x.airTemperature,x.waterTemperature,x.weather,x.abnormal,x.note].map(esc).join(','))}
 const blob=new Blob(['\ufeff'+lines.join('\r\n')],{type:'text/csv;charset=utf-8'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='住之江データ_'+start.value.replace('-','')+'_'+months.value+'か月.csv';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
</script></body></html>`));


// v3.0 cache diagnostics


// STEP6 tide test: only venue->JMA stations with an explicit, reviewed mapping are enabled.
// Unmapped/non-tidal venues stay blank rather than receiving guessed tide data.
const STEP6_TIDE_STATIONS={
  // ②-B潮汐の公式検証対象。近いだけの地点は入れず、対応根拠を確認した場だけ有効化。
  '03':{code:'TK',name:'東京'},     // 江戸川: 河川水面・上げ潮/下げ潮を公式明記
  '15':{code:'TX',name:'多度津'},   // 丸亀: 満潮/干潮の展開差を公式明記
  '16':{code:'UN',name:'宇野'},     // 児島: 瀬戸内・満潮/干潮の展開差を公式明記
  '17':{code:'Q8',name:'広島'},     // 宮島: 4m超の潮位差を公式明記
  '18':{code:'QA',name:'徳山'},     // 徳山: JMA同名地点、3m超の潮位差を公式明記
  '19':{code:'CF',name:'長府'},     // 下関: 競走場所在地=長府、3m超で海水流入を公式明記
  '20':{code:'MO',name:'門司'},     // 若松: 潮の出入り・満干潮の展開差を公式明記
  '22':{code:'QF',name:'博多'}      // 福岡: 博多湾側。②-B採否は9月検証で決定
  // 24大村は潮汐影響自体は公式明記だが、JMA掲載地点に大村湾の直接対応を確認できないため未確定のまま。
};
const step6TideCache=new Map();
async function fetchText(url, timeoutMs=15000){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 KyokunResearch/1.3',
        'accept-language': 'ja,en;q=0.8'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}
function hmToMin(v){const m=String(v||'').match(/^(\d{1,2}):(\d{2})$/);return m?Number(m[1])*60+Number(m[2]):null;}
async function fetchStep6TideDay(date,st){
  const y=date.slice(0,4), mo=date.slice(4,6), d=date.slice(6,8), key=`${date}:${st.code}`;
  let parsed=step6TideCache.get(key);
  if(parsed) return parsed;
  const url=`https://www.data.jma.go.jp/kaiyou/db/tide/suisan/suisan.php?LV=DL&S_HILO=on&S_HOUR=on&ds=${d}&ms=${mo}&ys=${y}&de=${d}&me=${mo}&ye=${y}&stn=${encodeURIComponent(st.code)}`;
  const html=await fetchText(url,15000);
  const $t=cheerio.load(html); const target=`${y}/${mo}/${d}`;
  let hilo=null,hourly=null;
  $t('tr').each((_,tr)=>{
    const cells=$t(tr).find('th,td').map((__,c)=>clean($t(c).text())).get();
    if(!cells.length||!String(cells[0]).includes(target)) return;
    const times=cells.filter(x=>/^\d{1,2}:\d{2}$/.test(x));
    const nums=cells.filter(x=>/^-?\d+$/.test(x)).map(Number);
    if(times.length>=2 && !hilo){
      const pairs=[];
      for(let i=1;i<cells.length-1;i++) if(/^\d{1,2}:\d{2}$/.test(cells[i]) && /^-?\d+$/.test(cells[i+1])) pairs.push({time:cells[i],level:Number(cells[i+1])});
      if(pairs.length>=2){
        // JMA HILO row is high-tide pairs first, then low-tide pairs. Assign type BEFORE chronological sorting.
        const half=Math.ceil(pairs.length/2);
        hilo=pairs.map((x,i)=>({...x,type:i<half?'満潮':'干潮'}));
      }
    }
    if(times.length===0 && nums.length>=24 && !hourly) hourly=nums.slice(-24);
  });
  parsed={hilo,hourly,url}; step6TideCache.set(key,parsed); return parsed;
}
function step6ShiftDate(date,delta){
  const dt=new Date(Date.UTC(Number(date.slice(0,4)),Number(date.slice(4,6))-1,Number(date.slice(6,8))));
  dt.setUTCDate(dt.getUTCDate()+delta);
  return `${dt.getUTCFullYear()}${String(dt.getUTCMonth()+1).padStart(2,'0')}${String(dt.getUTCDate()).padStart(2,'0')}`;
}
async function fetchStep6Tide(date,jcd,rno,deadline){
  const st=STEP6_TIDE_STATIONS[String(jcd).padStart(2,'0')];
  if(!st) return {station:'',status:'対象外または対応地点未確定'};
  const raceMin=hmToMin(deadline); if(raceMin==null) return {station:st.name,status:'レース時刻取得失敗'};
  const dates=[step6ShiftDate(date,-1),date,step6ShiftDate(date,1)];
  const days=await Promise.all(dates.map(x=>fetchStep6TideDay(x,st)));
  const center=days[1];
  if(!center.hilo||center.hilo.length<2) return {station:st.name,status:'気象庁解析失敗'};
  const events=[];
  days.forEach((day,di)=>{
    const offset=(di-1)*1440;
    for(const e of (day.hilo||[])){
      const m=hmToMin(e.time); if(m!=null) events.push({...e,min:m+offset,dayOffset:di-1});
    }
  });
  events.sort((a,b)=>a.min-b.min);
  let prev=null,next=null; for(const e of events){if(e.min<=raceMin)prev=e; if(e.min>raceMin&&!next)next=e;}
  let state='';
  if(prev&&next){state=prev.type==='干潮'&&next.type==='満潮'?'上げ潮':prev.type==='満潮'&&next.type==='干潮'?'下げ潮':'';}
  const nearest=events.slice().sort((a,b)=>Math.abs(a.min-raceMin)-Math.abs(b.min-raceMin))[0];
  if(nearest&&Math.abs(nearest.min-raceMin)<=30) state=nearest.type+'付近';
  const highs=events.filter(x=>x.type==='満潮'), lows=events.filter(x=>x.type==='干潮');
  const high=highs.slice().sort((a,b)=>Math.abs(a.min-raceMin)-Math.abs(b.min-raceMin))[0]||null;
  const low=lows.slice().sort((a,b)=>Math.abs(a.min-raceMin)-Math.abs(b.min-raceMin))[0]||null;
  const hour=Math.max(0,Math.min(23,Math.round(raceMin/60))); const level=center.hourly&&center.hourly.length===24?center.hourly[hour]:null;
  return {station:st.name,status:'OK',highTime:high?.time||'',highLevel:high?.level??'',lowTime:low?.time||'',lowLevel:low?.level??'',state,level:level??'',deadline,source:center.url};
}

app.get('/api/turbo-status', (req,res) => {
  res.json({
    ok:true,
    version:'3.1-turbo-cache-plus',
    cachedPages:officialHtmlCache.size,
    inflightPages:officialInflight.size,
    cacheMax:CACHE_MAX
  });
});


// ========================================
// v1.0.0.1 ①選手情報: 全国1日1CSV
// 取得項目: 選手名 / 登録番号 / 級別
// ========================================
app.get('/api/player-info', async (req,res)=>{
  try{
    const raw=String(req.query.date||'').replace(/-/g,'');
    if(!/^\d{8}$/.test(raw)) return res.status(400).json({ok:false,error:'dateはYYYYMMDD'});
    const y=raw.slice(0,4),m=raw.slice(4,6),d=raw.slice(6,8);
    const url=`https://boatracecsv.github.io/data/programs/race_cards/${y}/${m}/${d}.csv`;
    const r=await fetch(url,{headers:{'user-agent':'kyotei-data-logic/1.0.0.1'}});
    if(r.status===404) return res.type('text/csv; charset=utf-8').send('');
    if(!r.ok) throw new Error(`CSV HTTP ${r.status}`);
    res.type('text/csv; charset=utf-8').send(await r.text());
  }catch(e){res.status(502).json({ok:false,error:e.message||String(e)})}
});

app.listen(
  port,
  () =>
    console.log(
      `Kyokun API v3.1 TURBO CACHE+ running on ${port}`
    )
);

// ========================================
// v1.0.0.2 ①選手情報：現在の現役選手マスタ
// BOAT RACE公式レーサー検索を級別ごとに取得し、登録番号で一意化。
// 期間指定・レース出走実績には依存しない。
// ========================================
app.get('/api/current-racers', async (req, res) => {
  try {
    const classes = ['A1','A2','B1','B2'];
    const racers = new Map();
    const fetchPage = async (rankClass, beginRow) => {
      const q = new URLSearchParams({ kyu: rankClass, prevpgid: 'TDAT320' });
      if (beginRow > 1) q.set('orteusPageSelectBeginRow', String(beginRow));
      const url = `https://www.boatrace.jp/owpc/pc/data/racersearch/result?${q}`;
      const html = await officialFetch(url);
      const $ = cheerio.load(html);
      const body = $('body').text().replace(/\u3000/g, ' ').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ');
      const found = [];
      const re = /(\d{4})\s+([^0-9]{1,32}?)\s+級別[：:]\s*(A1|A2|B1|B2)/g;
      let m;
      while ((m = re.exec(body)) !== null) {
        const registration = m[1];
        const name = m[2].replace(/\s+/g, ' ').trim();
        const cls = m[3];
        if (!/^\d{4}$/.test(registration) || !name || cls !== rankClass) continue;
        found.push({ 選手名:name, 登録番号:registration, 級別:cls });
      }
      return found;
    };

    for (const cls of classes) {
      let noNewPages = 0;
      for (let begin = 1; begin <= 1201; begin += 40) {
        const page = await fetchPage(cls, begin);
        let added = 0;
        for (const r of page) {
          if (!racers.has(r.登録番号)) { racers.set(r.登録番号, r); added++; }
          else racers.set(r.登録番号, r); // current class wins
        }
        if (!page.length || added === 0) noNewPages++; else noNewPages = 0;
        if (noNewPages >= 2) break;
      }
    }
    const list = [...racers.values()].sort((a,b)=>Number(a.登録番号)-Number(b.登録番号));
    if (!list.length) return res.status(502).json({ error:'公式レーサー検索から選手を取得できませんでした' });
    res.json({ fetchedAt:new Date().toISOString(), count:list.length, racers:list });
  } catch (e) {
    res.status(500).json({ error:String(e?.message || e) });
  }
});
