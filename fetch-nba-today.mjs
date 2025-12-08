import puppeteer from 'puppeteer';
import fs from 'fs';

// ---------- CONFIG: credentials from env (with optional local fallback) ----------
const USERNAME = process.env.ZUZZ_USERNAME || 'lochiehackett@hotmail.com';
const PASSWORD = process.env.ZUZZ_PASSWORD || 'Villanova1';

// Each channel has:
//  - slug:  for ?channel=slug on zuzz.tv
//  - name:  for labeling
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
    slug:  'nesn12',
    name:  'NESN',
    match: 'nesn'
  },
  {
    slug:  'nbc-boston',
    name:  'NBC Sports Boston',
    match: 'nbc-boston'
  },
  {
    slug:  'msg-sn',      // MSG Sportsnet
    name:  'MSG Sportsnet',
    match: 'msg-sn'
  },
  {
    slug:  'espn',
    name:  'ESPN',
    match: '/espn/'
  },
  {
    slug:  'espn2',
    name:  'ESPN2',
    match: '/espn2/'
  }
];

const NBA_LEAGUE_URL = 'https://zuzz.tv/?league=NBA';

// ---------- Helpers ----------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Only keep HLS playlist URLs with tokens, not chunk URLs.
function isInterestingPlaylist(url) {
  if (!url.includes('.m3u8')) return false;
  if (!url.includes('/playlist.m3u8')) return false;
  if (!url.includes('wmsAuthSign')) return false;
  return true;
}

function buildIndexHtml(results) {
  const templatePath = 'index.template.html';
  const outputPath   = 'index.html';

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template file not found: ${templatePath}`);
  }

  let html = fs.readFileSync(templatePath, 'utf8');

  const chan = results.channels || {};
  const nba  = results.nbaGames || [];

  const replaceMap = {
    '%%SNONTARIO_URL%%':  chan['Sportsnet Ontario'] || '',
    '%%SNWEST_URL%%':     chan['Sportsnet West'] || '',
    '%%NESN_URL%%':       chan['NESN'] || '',
    '%%NBC_BOSTON_URL%%': chan['NBC Sports Boston'] || '',
    '%%MSG_SN_URL%%':     chan['MSG Sportsnet'] || '',
    '%%ESPN_URL%%':       chan['ESPN'] || '',
    '%%ESPN2_URL%%':      chan['ESPN2'] || ''
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
    if (game && game.url) {
      replaceMap[token] = game.url;
    } else {
      replaceMap[token] = '';
    }
  });

  for (const [token, value] of Object.entries(replaceMap)) {
    const safe = value || '';
    html = html.replace(new RegExp(token, 'g'), safe);
  }

  fs.writeFileSync(outputPath, html);
  console.log(`📝 Generated ${outputPath} from ${templatePath}`);
}

// More robust login: doesn’t assume specific IDs.
async function loginToBilling(page) {
  console.log('➡️ Opening login page...');
  await page.goto('https://billing.zuzz.tv/login', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  // Let any JS / redirects settle
  await sleep(5000);

  const currentUrl = page.url();
  const title = await page.title();
  console.log(`🔍 After initial load: URL=${currentUrl}, title="${title}"`);

  // Try to find any form on the page
  let formHandle;
  try {
    formHandle = await page.waitForSelector('form', {
      visible: true,
      timeout: 60000
    });
  } catch (err) {
    // Dump the HTML we actually got so you can inspect (locally or in logs).
    const htmlDump = await page.content();
    fs.writeFileSync('login-page.html', htmlDump);
    console.error('❌ Could not find a <form> on billing.zuzz.tv/login. Saved login-page.html for inspection.');
    throw new Error('Login form not found (likely anti-bot / different page on GitHub runner).');
  }

  if (!formHandle) {
    const htmlDump = await page.content();
    fs.writeFileSync('login-page.html', htmlDump);
    throw new Error('Login form handle is null after waitForSelector.');
  }

  async function findFirstSelector(selectors) {
    for (const sel of selectors) {
      const handle = await page.$(sel);
      if (handle) return { sel, handle };
    }
    return null;
  }

  const usernameSelectors = [
    'input#amember-login',
    'input[name="amember_login"]',
    'input[name="login"]',
    'input[type="email"]',
    'input[type="text"]'
  ];

  const passwordSelectors = [
    'input#amember-pass',
    'input[name="amember_pass"]',
    'input[name="password"]',
    'input[type="password"]'
  ];

  const userField = await findFirstSelector(usernameSelectors);
  const passField = await findFirstSelector(passwordSelectors);

  if (!userField || !passField) {
    const htmlDump = await page.content();
    fs.writeFileSync('login-page.html', htmlDump);
    console.error('❌ Could not find username/password fields. Saved login-page.html.');
    throw new Error('Could not find username or password fields on login page.');
  }

  console.log(`✏️ Typing username into ${userField.sel}`);
  await userField.handle.click({ clickCount: 3 });
  await userField.handle.type(USERNAME, { delay: 40 });

  console.log(`✏️ Typing password into ${passField.sel}`);
  await passField.handle.click({ clickCount: 3 });
  await passField.handle.type(PASSWORD, { delay: 40 });

  const submitButton =
    (await page.$('input[type="submit"]')) ||
    (await page.$('button[type="submit"]')) ||
    null;

  if (submitButton) {
    console.log('➡️ Clicking submit button...');
    await submitButton.click();
  } else {
    console.log('➡️ No explicit submit button found, pressing Enter on password field...');
    await passField.handle.press('Enter');
  }

  await Promise.race([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {}),
    sleep(60000)
  ]);

  console.log(`✅ Login step finished. Current URL: ${page.url()}`);
}

// ---------- MAIN FETCHER ----------

async function fetchSportsplusUrls() {
  if (!USERNAME || !PASSWORD) {
    throw new Error('ZUZZ_USERNAME or ZUZZ_PASSWORD env vars are not set and no hard-coded fallbacks provided.');
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: null
  });

  const page = await browser.newPage();

  // Slightly more “realistic” UA to reduce bot suspicion
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/121.0.0.0 Safari/537.36'
  );

  const results = {
    channels: {},  // { "Sportsnet West": "https://..." }
    nbaGames: []   // [ { label, url }, ... ]
  };

  let currentContext = null;
  const seenUrls = new Set();

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
      // Ignore listener errors
    }
  });

  try {
    // 1️⃣ Login
    await loginToBilling(page);

    // 2️⃣ Capture specific channels
    for (const chan of CHANNELS) {
      const chanUrl = `https://zuzz.tv/?channel=${chan.slug}`;
      console.log(`\n🎯 Fetching channel: ${chan.name} (${chanUrl})`);

      currentContext = {
        type: 'channel',
        name: chan.name,
        matchSubstr: chan.match
      };

      await page.goto(chanUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

      // Let the player load & fire HLS requests
      await sleep(20000);

      if (!results.channels[chan.name]) {
        console.warn(
          `⚠️ No matching playlist.m3u8 captured for ${chan.name}. ` +
          `Check slug (${chan.slug}), or that the channel is live.`
        );
      } else {
        console.log(`✅ Captured playlist for ${chan.name}`);
      }
    }

    currentContext = null;

    // 3️⃣ Capture today's NBA games from NBA tab
    console.log('\n🏀 Navigating to NBA league page...');
    await page.goto(NBA_LEAGUE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);

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

      await page.evaluate((buttonIndex) => {
        const btns = Array.from(
          document.querySelectorAll('button, a')
        ).filter(el => /watch/i.test(el.textContent));

        const btn = btns[buttonIndex];
        if (btn) btn.click();
      }, game.index);

      await sleep(20000);

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

