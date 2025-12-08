import puppeteer from 'puppeteer';
import fs from 'fs';

const USERNAME = process.env.ZUZZ_USERNAME || 'lochiehackett@hotmail.com';
const PASSWORD = process.env.ZUZZ_PASSWORD || 'Villanova1!';

// Each channel has:
//  - slug:  for ?channel=slug
//  - name:  for labeling in output
//  - match: substring that MUST appear in the final playlist URL
const CHANNELS = [
  {
    slug:  'snontario',
    name:  'Sportsnet Ontario',
    match: 'snontario'
  },
  {
    slug:  'snwest',
    name:  'Sportsnet West',
    match: 'snwest'
  },
  {
    slug:  'nesn12',        // adjust if you use a different ?channel= slug
    name:  'NESN',
    match: 'nesn'           // URL usually has /nesn/ or /nesn12/
  },
  {
    slug:  'nbc-boston',
    name:  'NBC Sports Boston',
    match: 'nbc-boston'
  },
  {
    slug:  'msg-sn',        // fixed MSG Sportsnet slug
    name:  'MSG Sportsnet',
    match: 'msg-sn'
  },
  {
    slug:  'espn',
    name:  'ESPN',
    match: '/espn/'         // avoid accidentally matching espn2
  },
  {
    slug:  'espn2',
    name:  'ESPN2',
    match: '/espn2/'
  }
];

const NBA_LEAGUE_URL = 'https://zuzz.tv/?league=NBA';

// Basic filter: only HLS playlist URLs with tokens
function isInterestingPlaylist(url) {
  if (!url.includes('.m3u8')) return false;
  if (!url.includes('/playlist.m3u8')) return false;
  if (!url.includes('wmsAuthSign')) return false;
  return true;
}

function buildIndexHtml(results) {
  const templatePath = 'index.template.html';
  const outputPath   = 'index.html';

  let html = fs.readFileSync(templatePath, 'utf8');

  const chan = results.channels || {};
  const nba  = results.nbaGames || [];

  // Map placeholders -> channel URLs
  const replaceMap = {
    '%%SNONTARIO_URL%%':  chan['Sportsnet Ontario'] || '',
    '%%SNWEST_URL%%':     chan['Sportsnet West'] || '',
    '%%NESN_URL%%':       chan['NESN'] || '',
    '%%NBC_BOSTON_URL%%': chan['NBC Sports Boston'] || '',
    '%%MSG_SN_URL%%':     chan['MSG Sportsnet'] || '',
    '%%ESPN_URL%%':       chan['ESPN'] || '',
    '%%ESPN2_URL%%':      chan['ESPN2'] || ''
  };

  // League Pass 1–8 mapped from nbaGames[0..7]
  const lpTokens = [
    '%%LEAGUE_PASS_1_URL%%',
    '%%LEAGUE_PASS_2_URL%%',
    '%%LEAGUE_PASS_3_URL%%',
    '%%LEAGUE_PASS_4_URL%%',
    '%%LEAGUE_PASS_5_URL%%',
    '%%LEAGUE_PASS_6_URL%%',
    '%%LEAGUE_PASS_7_URL%%',
    '%%LEAGUE_PASS_8_URL%%'
  ];

  lpTokens.forEach((token, idx) => {
    const game = nba[idx];
    if (game && game.url) {
      replaceMap[token] = game.url;
    } else {
      // If there aren't that many games, leave the placeholder as empty string or keep previous
      replaceMap[token] = '';
    }
  });

  // Apply replacements
  for (const [token, value] of Object.entries(replaceMap)) {
    const safe = value || '';
    html = html.replace(new RegExp(token, 'g'), safe);
  }

  fs.writeFileSync(outputPath, html);
  console.log(`📝 Generated ${outputPath} from ${templatePath}`);
}

async function fetchSportsplusUrls() {
  if (!USERNAME || !PASSWORD) {
    throw new Error('ZUZZ_USERNAME or ZUZZ_PASSWORD env vars are not set');
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: null,
  });

  const page = await browser.newPage();

  const results = {
    channels: {},  // { "Sportsnet West": "https://..." }
    nbaGames: []   // [ { label: "Lakers @ Celtics", url: "https://..." }, ... ]
  };

  let currentContext = null;
  const seenUrls = new Set();

  // Listen for relevant HLS playlist responses
  page.on('response', async (response) => {
    try {
      const url = response.url();

      if (!isInterestingPlaylist(url)) return;
      if (seenUrls.has(url)) return;
      if (!currentContext) return;

      const lcUrl = url.toLowerCase();

      if (currentContext.type === 'channel') {
        const m = currentContext.matchSubstr;
        if (m && !lcUrl.includes(m.toLowerCase())) {
          return;
        }
      } else if (currentContext.type === 'nba') {
        if (!/nba/.test(lcUrl)) {
          return;
        }
      }

      seenUrls.add(url);

      if (currentContext.type === 'channel') {
        const chanName = currentContext.name;
        if (!results.channels[chanName]) {
          results.channels[chanName] = url;
          console.log(`📺 [CHANNEL] ${chanName}: ${url}`);
        }
      } else if (currentContext.type === 'nba') {
        const label = currentContext.label;
        if (!results.nbaGames.find(g => g.label === label)) {
          results.nbaGames.push({ label, url });
          console.log(`🏀 [NBA] ${label}: ${url}`);
        }
      }
    } catch {
      // ignore listener errors
    }
  });

  try {
    // 1️⃣ Login
    console.log('➡️ Opening login page...');
    await page.goto('https://billing.zuzz.tv/login', { waitUntil: 'networkidle2' });

    await page.waitForSelector('#amember-login', { visible: true });
    await page.type('#amember-login', USERNAME, { delay: 40 });

    await page.waitForSelector('#amember-pass', { visible: true });
    await page.type('#amember-pass', PASSWORD, { delay: 40 });

    await page.waitForSelector('input[type="submit"][value="Login"]', { visible: true });
    await page.click('input[type="submit"][value="Login"]');

    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    console.log('✅ Logged in successfully');

    // 2️⃣ Capture specific channels
    for (const chan of CHANNELS) {
      const chanUrl = `https://zuzz.tv/?channel=${chan.slug}`;
      console.log(`\n🎯 Fetching channel: ${chan.name} (${chanUrl})`);

      currentContext = {
        type: 'channel',
        name: chan.name,
        matchSubstr: chan.match
      };

      await page.goto(chanUrl, { waitUntil: 'networkidle2' });

      // Wait for player to initialise and fire its first HLS requests
      await new Promise(resolve => setTimeout(resolve, 20000)); // 20s

      if (!results.channels[chan.name]) {
        console.warn(
          `⚠️ No matching playlist.m3u8 captured for ${chan.name} – ` +
          `check slug (${chan.slug}) or that the channel is currently live.`
        );
      } else {
        console.log(`✅ Captured playlist for ${chan.name}`);
      }
    }

    currentContext = null;

    // 3️⃣ Capture today's NBA games from the NBA tab
    console.log('\n🏀 Navigating to NBA league page...');
    await page.goto(NBA_LEAGUE_URL, { waitUntil: 'networkidle2' });

    const games = await page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll('button, a')
      ).filter(el => /watch/i.test(el.textContent));

      return buttons.map((btn, index) => {
        let label = '';
        const card =
          btn.closest('[data-game], [data-event], .game, .game-card, .event, .matchup') ||
          btn.parentElement;

        if (card) {
          let text = card.innerText || '';
          text = text.replace(/\s+/g, ' ').trim();
          const watchIdx = text.toLowerCase().indexOf('watch');
          if (watchIdx > 0) {
            label = text.slice(0, watchIdx).trim();
          } else {
            label = text;
          }
        }

        if (!label) label = `NBA Game ${index + 1}`;
        btn.dataset.spIndex = String(index);
        return { index, label };
      });
    });

    console.log(`📋 Found ${games.length} NBA "Watch" buttons on the current view.`);

    for (const game of games) {
      console.log(`\n🏀 Capturing stream for: ${game.label} (index ${game.index})`);

      currentContext = {
        type: 'nba',
        label: game.label
      };

      await page.evaluate((buttonIndex) => {
        const btns = Array.from(
          document.querySelectorAll('button, a')
        ).filter(el => /watch/i.test(el.textContent));

        const btn = btns[buttonIndex];
        if (btn) {
          btn.click();
        }
      }, game.index);

      await new Promise(resolve => setTimeout(resolve, 20000)); // 20s

      const alreadyHave = results.nbaGames.find(g => g.label === game.label);
      if (!alreadyHave) {
        console.warn(`⚠️ No NBA playlist.m3u8 captured for: ${game.label}`);
      } else {
        console.log(`✅ Captured NBA playlist for: ${game.label}`);
      }
    }

    // 4️⃣ Save JSON + generate index.html
    fs.writeFileSync(
      'sportsplus_serv_urls.json',
      JSON.stringify(results, null, 2)
    );
    console.log('💾 Wrote sportsplus_serv_urls.json');

    buildIndexHtml(results);
  } finally {
    await browser.close();
  }
}

fetchSportsplusUrls().catch(err => {
  console.error('❌ Top-level error:', err);
  process.exit(1);
});
