import puppeteer from 'puppeteer';
import fs from 'fs';

// ---------- CONFIG ----------

// Credentials: use env vars if set, otherwise fall back to hard-coded.
const USERNAME = process.env.ZUZZ_USERNAME || 'YOUR_EMAIL_HERE';
const PASSWORD = process.env.ZUZZ_PASSWORD || 'YOUR_PASSWORD_HERE';

// Where to find NBA games
const NBA_LEAGUE_URL = 'https://zuzz.tv/?league=NBA';

// Channels we want, with the slug used in ?channel= and a substring to match
const CHANNELS = [
  {
    slug: 'snontario',
    name: 'Sportsnet Ontario',
    match: 'snontario'
  },
  {
    slug: 'snwest',
    name: 'Sportsnet West',
    match: 'snwest'
  },
  {
    slug: 'nesn12',
    name: 'NESN',
    match: 'nesn'
  },
  {
    slug: 'nbc-boston',
    name: 'NBC Sports Boston',
    match: 'nbc-boston'
  },
  {
    slug: 'msg-sn',
    name: 'MSG Sportsnet',
    match: 'msg-sn'
  },
  {
    slug: 'espn',
    name: 'ESPN',
    match: '/espn/'
  },
  {
    slug: 'espn2',
    name: 'ESPN2',
    match: '/espn2/'
  }
];

// ---------- HELPER FUNCTIONS ----------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Only keep proper HLS master playlists with a token
function isInterestingPlaylist(url) {
  if (!url.includes('.m3u8')) return false;
  if (!url.includes('/playlist.m3u8')) return false;
  if (!url.includes('wmsAuthSign')) return false;
  return true;
}

// Generate index.html from index.template.html if present
function buildIndexHtml(results) {
  const templatePath = 'index.template.html';
  const outputPath = 'index.html';

  if (!fs.existsSync(templatePath)) {
    console.log('ℹ️ index.template.html not found, skipping index.html generation.');
    return;
  }

  let html = fs.readFileSync(templatePath, 'utf8');

  const chan = results.channels || {};
  const nba = results.nbaGames || [];

  const replaceMap = {
    '%%SNONTARIO_URL%%': chan['Sportsnet Ontario'] || '',
    '%%SNWEST_URL%%': chan['Sportsnet West'] || '',
    '%%NESN_URL%%': chan['NESN'] || '',
    '%%NBC_BOSTON_URL%%': chan['NBC Sports Boston'] || '',
    '%%MSG_SN_URL%%': chan['MSG Sportsnet'] || '',
    '%%ESPN_URL%%': chan['ESPN'] || '',
    '%%ESPN2_URL%%': chan['ESPN2'] || ''
  };

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
    replaceMap[token] = game && game.url ? game.url : '';
  });

  for (const [token, value] of Object.entries(replaceMap)) {
    const safe = value || '';
    html = html.replace(new RegExp(token, 'g'), safe);
  }

  fs.writeFileSync(outputPath, html);
  console.log(`📝 Generated ${outputPath} from ${templatePath}`);
}

// ---------- LOGIN USING OLD WORKING SELECTORS ----------

async function loginToBilling(page) {
  console.log('➡️ Opening login page...');
  await page.goto('https://billing.zuzz.tv/login', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  // Old selectors that we know worked locally
  await page.waitForSelector('#amember-login', { timeout: 60000 });
  await page.type('#amember-login', USERNAME, { delay: 40 });

  await page.waitForSelector('#amember-pass', { timeout: 60000 });
  await page.type('#amember-pass', PASSWORD, { delay: 40 });

  // Try a submit input first, then fallback
  const submitSelector =
    'input[type="submit"][value="Login"], input[type="submit"], button[type="submit"]';

  const submit = await page.$(submitSelector);
  if (submit) {
    await submit.click();
  } else {
    // Fallback: press Enter on password field
    const pass = await page.$('#amember-pass');
    if (pass) await pass.press('Enter');
  }

  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });
  console.log('✅ Logged in successfully. Now on:', page.url());
}

// ---------- MAIN SCRAPER ----------

async function fetchSportsplusUrls() {
  if (!USERNAME || !PASSWORD) {
    throw new Error('ZUZZ_USERNAME or ZUZZ_PASSWORD not set and no hard-coded fallback provided.');
  }

  // Launch real Chrome, non-headless
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: null
  });

  const page = await browser.newPage();

  // Slightly realistic user agent
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/121.0.0.0 Safari/537.36'
  );

  const results = {
    channels: {},  // { "Sportsnet Ontario": "https://..." }
    nbaGames: []   // [ { label, url }, ... ]
  };

  let currentContext = null;
  const seenUrls = new Set();

  // Listen for HLS responses
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
          // This playlist doesn't match the channel we care about
          return;
        }
      } else if (currentContext.type === 'nba') {
        // For NBA games, require "nba" in URL so we don't pick up random stuff
        if (!lcUrl.includes('nba')) return;
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
      // Ignore listener issues
    }
  });

  try {
    // 1️⃣ Log in
    await loginToBilling(page);

    // 2️⃣ Capture specific channels one by one
    for (const chan of CHANNELS) {
      const chanUrl = `https://zuzz.tv/?channel=${chan.slug}`;
      console.log(`\n🎯 Fetching channel: ${chan.name} (${chanUrl})`);

      currentContext = {
        type: 'channel',
        name: chan.name,
        matchSubstr: chan.match
      };

      await page.goto(chanUrl, {
        waitUntil: 'networkidle2',
        timeout: 60000
      });

      // Let the player boot up and start HLS requests
      await sleep(20000);

      if (!results.channels[chan.name]) {
        console.warn(`⚠️ No playlist.m3u8 captured for ${chan.name}`);
      } else {
        console.log(`✅ Captured playlist for ${chan.name}`);
      }
    }

    currentContext = null;

    // 3️⃣ NBA league games from NBA tab
    console.log('\n🏀 Navigating to NBA league page...');
    await page.goto(NBA_LEAGUE_URL, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    // Give the page a bit of time
    await sleep(8000);

    // Find "Watch" buttons/links and give them labels
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

    console.log(`📋 Found ${games.length} NBA "Watch" buttons.`);

    for (const game of games) {
      console.log(`\n🏀 Capturing stream for: ${game.label} (index ${game.index})`);

      currentContext = {
        type: 'nba',
        label: game.label
      };

      // Click the button inside page context
      await page.evaluate((buttonIndex) => {
        const btns = Array.from(
          document.querySelectorAll('button, a')
        ).filter(el => /watch/i.test(el.textContent));
        const btn = btns[buttonIndex];
        if (btn) btn.click();
      }, game.index);

      // Let the player load and fire off HLS requests
      await sleep(20000);

      const alreadyHave = results.nbaGames.find(g => g.label === game.label);
      if (!alreadyHave) {
        console.warn(`⚠️ No NBA playlist.m3u8 captured for: ${game.label}`);
      } else {
        console.log(`✅ Captured NBA playlist for: ${game.label}`);
      }
    }

    // 4️⃣ Save JSON + index.html
    fs.writeFileSync(
      'sportsplus_serv_urls.json',
      JSON.stringify(results, null, 2)
    );
    console.log('💾 Wrote sportsplus_serv_urls.json');

    buildIndexHtml(results);
  } finally {
    // Don’t auto-close if you want to inspect; comment this out while debugging.
    await browser.close();
  }
}

fetchSportsplusUrls().catch(err => {
  console.error('❌ Top-level error:', err);
  process.exit(1);
});

