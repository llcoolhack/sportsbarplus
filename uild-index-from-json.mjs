import fs from 'fs';

// Read the JSON your fetcher created
const jsonPath = 'sportsplus_serv_urls.json';
const templatePath = 'index.template.html';
const outputPath = 'index.html';

if (!fs.existsSync(jsonPath)) {
  throw new Error(`Missing ${jsonPath} – run your fetch script first.`);
}
if (!fs.existsSync(templatePath)) {
  throw new Error(`Missing ${templatePath} – make sure it’s in the repo root.`);
}

const results = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
let html = fs.readFileSync(templatePath, 'utf8');

const chan = results.channels || {};
const nba = results.nbaGames || [];

// Map channels to placeholders
const replaceMap = {
  '%%SNONTARIO_URL%%':  chan['Sportsnet Ontario'] || '',
  '%%SNWEST_URL%%':     chan['Sportsnet West'] || '',
  '%%NESN_URL%%':       chan['NESN'] || '',
  '%%NBC_BOSTON_URL%%': chan['NBC Sports Boston'] || '',
  '%%MSG_SN_URL%%':     chan['MSG Sportsnet'] || '',
  '%%ESPN_URL%%':       chan['ESPN'] || '',
  '%%ESPN2_URL%%':      chan['ESPN2'] || '',
};

// League Pass placeholders
const lpTokens = [
  '%%LEAGUE_PASS_1_URL%%',
  '%%LEAGUE_PASS_2_URL%%',
  '%%LEAGUE_PASS_3_URL%%',
  '%%LEAGUE_PASS_4_URL%%',
  '%%LEAGUE_PASS_5_URL%%',
  '%%LEAGUE_PASS_6_URL%%',
  '%%LEAGUE_PASS_7_URL%%',
  '%%LEAGUE_PASS_8_URL%%',
];

lpTokens.forEach((token, idx) => {
  const game = nba[idx];
  replaceMap[token] = game && game.url ? game.url : '';
});

// Do the replacements
for (const [token, value] of Object.entries(replaceMap)) {
  html = html.replace(new RegExp(token, 'g'), value || '');
}

fs.writeFileSync(outputPath, html);
console.log(`✅ Built ${outputPath} from ${templatePath} and ${jsonPath}`);
