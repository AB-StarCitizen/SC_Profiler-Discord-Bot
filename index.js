const http = require('http');
const fs = require('fs');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
require('dotenv').config({ override: true });

for (const key of ['BOT_TOKEN', 'CLIENT_ID', 'GUILD_ID', 'PORT', 'MOCK_MODE']) {
  if (process.env[key]) process.env[key] = process.env[key].trim();
}

const MOCK_MODE = process.env.MOCK_MODE === 'true';
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, MessageFlags } = require('discord.js');
const cheerio = require('cheerio');

const PORT = process.env.PORT || 3000;
const SIMULATOR_PATH = path.join(__dirname, 'public', 'simulator.html');
const MATRIX_GREEN = 0x00ff41;
const MATRIX_RED = 0xff1744;

const RSI_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept': 'text/html,application/xhtml+xml'
};

if (!MOCK_MODE) {
  const requiredEnv = ['BOT_TOKEN', 'CLIENT_ID', 'GUILD_ID'];
  const missingEnv = requiredEnv.filter((key) => !process.env[key]);
  if (missingEnv.length > 0) {
    console.error(`❌ Missing required environment variables: ${missingEnv.join(', ')}`);
    console.error('   Copy .env.example to .env and fill in your Discord credentials.');
    console.error('   Or set MOCK_MODE=true to run locally without Discord.');
    process.exit(1);
  }
}

function buildNotFoundResult(username, { httpStatus = null, errorType = 'not_in_registry' } = {}) {
  const profileUrl = `https://robertsspaceindustries.com/en/citizens/${encodeURIComponent(username)}`;
  return withTerminal({
    found: false,
    username,
    profileUrl,
    httpStatus,
    errorType
  });
}

const TERMINAL_WIDTH = 72;
const DISCORD_CONTENT_LIMIT = 2000;
const ANSI_BLOCK_OVERHEAD = '```ansi\n'.length + '\n```'.length;

const A = {
  reset: '\u001b[0m',
  defaultBg: '\u001b[49m',
  bright: '\u001b[1;32m',
  green: '\u001b[0;32m',
  dim: '\u001b[2;32m',
  cyan: '\u001b[0;36m',
  yellow: '\u001b[0;33m',
  red: '\u001b[0;31m',
  brightRed: '\u001b[1;31m'
};

function measureDiscordBlock(body) {
  return ANSI_BLOCK_OVERHEAD + A.defaultBg.length + A.reset.length + body.length;
}

function wrapAnsiBlock(body) {
  return `\`\`\`ansi\n${A.defaultBg}${A.reset}${body}\n\`\`\``;
}

function stripAnsi(text) {
  return String(text).replace(/\u001b\[[0-9;]*m/g, '');
}

function visibleLen(text) {
  return stripAnsi(text).length;
}

function borderLine(width, char = '═') {
  return `${A.defaultBg}${A.dim}${char.repeat(width)}${A.reset}`;
}

function termRowAnsi(label, value, valueStyle = A.bright, width = TERMINAL_WIDTH) {
  const tag = `[${label.padEnd(7)}]`;
  const plainValue = String(value);
  const contentLen = tag.length + 3 + plainValue.length;
  const dots = '.'.repeat(Math.max(4, width - contentLen));
  return `${A.dim}${tag}${A.reset}${A.dim}${dots}${A.reset} ${A.green}▸${A.reset} ${valueStyle}${plainValue}${A.reset}`;
}

function buildDiscordLines(result, width, options = {}) {
  const affiliations = options.affiliations !== undefined
    ? options.affiliations
    : (result.affiliations || []);
  const affiliationsOverflow = options.affiliationsOverflow || 0;

  if (!result.found) {
    const notInRegistry = result.errorType === 'not_in_registry' || result.httpStatus === 404;
    const lines = [
      borderLine(width),
      `${A.brightRed}▸ ${notInRegistry ? 'CITIZEN NOT FOUND // UEE NET' : 'QUERY FAILED // UEE NET'}${A.reset}`,
      borderLine(width),
      termRowAnsi('QUERY', result.username, A.yellow, width),
      termRowAnsi('STATUS', notInRegistry ? 'NOT IN REGISTRY' : 'RSI ERROR', A.brightRed, width)
    ];

    if (result.httpStatus) {
      lines.push(termRowAnsi('CODE', String(result.httpStatus), A.yellow, width));
    }

    lines.push(
      termRowAnsi('DETAIL', notInRegistry ? 'No public citizen dossier matches this handle' : 'RSI registry returned an unexpected response', A.red, width),
      termRowAnsi('HINT', 'Verify spelling and capitalization on RSI', A.dim, width)
    );

    if (result.profileUrl) {
      lines.push(termRowAnsi('CHECK', result.profileUrl, A.cyan, width));
    }

    lines.push(borderLine(width), `${A.dim}// TRANSMISSION TERMINATED${A.reset}`);
    return lines;
  }

  const lines = [
    borderLine(width),
    `${A.bright}▸ CITIZEN RECORD // ${result.username.toUpperCase()}${A.reset}`,
    borderLine(width),
    termRowAnsi('STATUS', 'LOCATED', A.bright, width),
    termRowAnsi('PROFILE', result.profileUrl, A.cyan, width),
    termRowAnsi('ORG LOG', result.orgsUrl, A.cyan, width),
    borderLine(width, '─'),
    `${A.bright}▸ MAIN ORG${A.reset}`
  ];

  if (result.mainOrg) {
    lines.push(
      termRowAnsi('SID', result.mainOrg.sid, A.yellow, width),
      termRowAnsi('NAME', result.mainOrg.name, A.bright, width),
      termRowAnsi('RANK', result.mainOrg.rank, A.green, width),
      termRowAnsi('LINK', result.mainOrg.url, A.cyan, width)
    );
  } else {
    lines.push(`${A.dim}[ NO PUBLIC MEMBERSHIP ON RECORD ]${A.reset}`);
  }

  lines.push(borderLine(width, '─'), `${A.bright}▸ AFFILIATIONS${A.reset}`);

  if (affiliations.length) {
    for (const a of affiliations) {
      lines.push(termRowAnsi('AFFIL', `${a.sid} | ${a.name} — ${a.rank}`, A.bright, width));
      lines.push(termRowAnsi('LINK', a.url, A.cyan, width));
    }
    if (affiliationsOverflow > 0) {
      lines.push(termRowAnsi('MORE', `+${affiliationsOverflow} affiliation(s) — see ORG LOG above`, A.dim, width));
    }
  } else if (affiliationsOverflow > 0) {
    lines.push(termRowAnsi('MORE', `+${affiliationsOverflow} affiliation(s) — see ORG LOG above`, A.dim, width));
  } else {
    lines.push(`${A.dim}[ NONE ON RECORD ]${A.reset}`);
  }

  lines.push(
    borderLine(width),
    `${A.dim}// SC_Profiler // UEE NET // TRANSMISSION COMPLETE${A.reset}`
  );

  return lines;
}

function resolveTerminalWidth(lines) {
  return Math.max(TERMINAL_WIDTH, ...lines.map(visibleLen));
}

function renderDiscordLines(result, width, options = {}, expand = true) {
  let lines = buildDiscordLines(result, width, options);
  if (expand) {
    const resolvedWidth = resolveTerminalWidth(lines);
    if (resolvedWidth > width) {
      lines = buildDiscordLines(result, resolvedWidth, options);
    }
  }
  return lines;
}

function formatDiscordTerminal(result) {
  if (!result.found) {
    const lines = renderDiscordLines(result, TERMINAL_WIDTH);
    return wrapAnsiBlock(lines.join('\n'));
  }

  const allAffils = result.affiliations || [];

  for (let affilCount = allAffils.length; affilCount >= 0; affilCount--) {
    const options = {
      affiliations: allAffils.slice(0, affilCount),
      affiliationsOverflow: allAffils.length - affilCount
    };

    for (const expand of [true, false]) {
      const lines = renderDiscordLines(result, TERMINAL_WIDTH, options, expand);
      const body = lines.join('\n');
      if (measureDiscordBlock(body) <= DISCORD_CONTENT_LIMIT) {
        return wrapAnsiBlock(body);
      }
    }
  }

  const fallback = renderDiscordLines(result, TERMINAL_WIDTH, {
    affiliations: [],
    affiliationsOverflow: allAffils.length
  });
  return wrapAnsiBlock(fallback.join('\n'));
}

// Keep alias for API / simulator message field
function formatDiscordEmbed(result) {
  return formatDiscordTerminal(result);
}

function escHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function borderLineHtml(width, char = '═', borderClass = 't-border') {
  return `<span class="${borderClass}">${escHtml(char.repeat(width))}</span>`;
}

function termRowHtml(label, value, width, valueClass = 't-bright', href = null) {
  const tag = `[${label.padEnd(7)}]`;
  const plainValue = String(value);
  const contentLen = tag.length + 3 + plainValue.length;
  const dots = '.'.repeat(Math.max(4, width - contentLen));
  const valueHtml = href
    ? `<a class="${valueClass}" href="${escHtml(href)}" target="_blank" rel="noopener">${escHtml(plainValue)}</a>`
    : `<span class="${valueClass}">${escHtml(plainValue)}</span>`;
  return `<span class="t-dim">${escHtml(tag)}</span><span class="t-dim">${escHtml(dots)}</span> <span class="t-accent">▸</span> ${valueHtml}`;
}

function buildSimulatorLines(result, width, options = {}) {
  const affiliations = options.affiliations !== undefined
    ? options.affiliations
    : (result.affiliations || []);
  const affiliationsOverflow = options.affiliationsOverflow || 0;

  if (!result.found) {
    const notInRegistry = result.errorType === 'not_in_registry' || result.httpStatus === 404;
    const lines = [
      borderLineHtml(width, '═', 't-border t-border-error'),
      `<span class="t-header-error">▸ ${notInRegistry ? 'CITIZEN NOT FOUND // UEE NET' : 'QUERY FAILED // UEE NET'}</span>`,
      borderLineHtml(width, '═', 't-border t-border-error'),
      termRowHtml('QUERY', result.username, width, 't-code-error'),
      termRowHtml('STATUS', notInRegistry ? 'NOT IN REGISTRY' : 'RSI ERROR', width, 't-error-bright')
    ];

    if (result.httpStatus) {
      lines.push(termRowHtml('CODE', String(result.httpStatus), width, 't-code-error'));
    }

    lines.push(
      termRowHtml('DETAIL', notInRegistry ? 'No public citizen dossier matches this handle' : 'RSI registry returned an unexpected response', width, 't-warn'),
      termRowHtml('HINT', 'Verify spelling and capitalization on RSI', width, 't-dim')
    );

    if (result.profileUrl) {
      lines.push(termRowHtml('CHECK', result.profileUrl, width, 't-link-error', result.profileUrl));
    }

    lines.push(borderLineHtml(width, '═', 't-border t-border-error'), '<span class="t-dim">// TRANSMISSION TERMINATED</span>');
    return lines;
  }

  const lines = [
    borderLineHtml(width),
    `<span class="t-header">▸ CITIZEN RECORD // ${escHtml(result.username.toUpperCase())}</span>`,
    borderLineHtml(width),
    termRowHtml('STATUS', 'LOCATED', width, 't-bright'),
    termRowHtml('PROFILE', result.profileUrl, width, 't-link', result.profileUrl),
    termRowHtml('ORG LOG', result.orgsUrl, width, 't-link', result.orgsUrl),
    borderLineHtml(width, '─'),
    '<span class="t-section">▸ MAIN ORG</span>'
  ];

  if (result.mainOrg) {
    lines.push(
      termRowHtml('SID', result.mainOrg.sid, width, 't-yellow'),
      termRowHtml('NAME', result.mainOrg.name, width, 't-bright'),
      termRowHtml('RANK', result.mainOrg.rank, width, 't-green'),
      termRowHtml('LINK', result.mainOrg.url, width, 't-link', result.mainOrg.url)
    );
  } else {
    lines.push('<span class="t-dim">[ NO PUBLIC MEMBERSHIP ON RECORD ]</span>');
  }

  lines.push(borderLineHtml(width, '─'), '<span class="t-section">▸ AFFILIATIONS</span>');

  if (affiliations.length) {
    for (const a of affiliations) {
      lines.push(termRowHtml('AFFIL', `${a.sid} | ${a.name} — ${a.rank}`, width, 't-bright'));
      lines.push(termRowHtml('LINK', a.url, width, 't-link', a.url));
    }
    if (affiliationsOverflow > 0) {
      lines.push(termRowHtml('MORE', `+${affiliationsOverflow} affiliation(s) — see ORG LOG above`, width, 't-dim'));
    }
  } else if (affiliationsOverflow > 0) {
    lines.push(termRowHtml('MORE', `+${affiliationsOverflow} affiliation(s) — see ORG LOG above`, width, 't-dim'));
  } else {
    lines.push('<span class="t-dim">[ NONE ON RECORD ]</span>');
  }

  lines.push(
    borderLineHtml(width),
    '<span class="t-dim">// SC_Profiler // UEE NET // TRANSMISSION COMPLETE</span>'
  );

  return lines;
}

function renderSimulatorLines(result, width, options = {}, expand = true) {
  let lines = buildSimulatorLines(result, width, options);
  if (expand) {
    const plainLines = buildDiscordLines(result, width, options);
    const resolvedWidth = resolveTerminalWidth(plainLines);
    if (resolvedWidth > width) {
      lines = buildSimulatorLines(result, resolvedWidth, options);
    }
  }
  return lines;
}

function formatSimulatorHtml(result) {
  const line = (content) => `<div class="t-line">${content}</div>`;
  const options = {
    affiliations: result.affiliations || [],
    affiliationsOverflow: 0
  };
  const htmlLines = renderSimulatorLines(result, TERMINAL_WIDTH, options);
  const wrapperClass = result.found ? 'terminal-output' : 'terminal-output terminal-error';
  return `<div class="${wrapperClass}">${htmlLines.map(line).join('')}</div>`;
}

function withTerminal(result) {
  result.message = formatDiscordEmbed(result);
  result.html = formatSimulatorHtml(result);
  return result;
}

function buildProfilerReply(result) {
  return {
    content: formatDiscordTerminal(result),
    flags: MessageFlags.SuppressEmbeds
  };
}

async function lookupProfile(username) {
  const profileUrl = `https://robertsspaceindustries.com/en/citizens/${encodeURIComponent(username)}`;
  const orgsUrl = `${profileUrl}/organizations`;

  const response = await fetch(profileUrl, { headers: RSI_HEADERS });
  if (!response.ok) {
    return buildNotFoundResult(username, {
      httpStatus: response.status,
      errorType: response.status === 404 ? 'not_in_registry' : 'rsi_error'
    });
  }

  const html = await response.text();
  const isValid = html.includes('CITIZEN DOSSIER') && html.includes('UEE Citizen Record');
  if (!isValid) {
    return buildNotFoundResult(username, { errorType: 'not_in_registry' });
  }

  const orgResponse = await fetch(orgsUrl, { headers: RSI_HEADERS });
  if (!orgResponse.ok) {
    return withTerminal({
      found: true,
      username,
      profileUrl,
      orgsUrl,
      mainOrg: null,
      affiliations: []
    });
  }

  const orgHtml = await orgResponse.text();
  if (orgHtml.includes('NO ORG MEMBERSHIP FOUND IN PUBLIC RECORDS')) {
    return withTerminal({
      found: true,
      username,
      profileUrl,
      orgsUrl,
      mainOrg: null,
      affiliations: []
    });
  }

  const $$ = cheerio.load(orgHtml);

  const mainBlock = $$('.box-content.org.main');
  const mainName = mainBlock.find('a.value').text().trim();
  const mainSID = mainBlock.find('strong.value').first().text().trim();
  const mainType = mainBlock.find('strong.value').eq(1).text().trim();
  const mainOrgUrl = mainSID ? `https://robertsspaceindustries.com/orgs/${mainSID}` : null;

  const affiliations = [];
  $$('.box-content.org.affiliation').each((i, el) => {
    const affName = $$(el).find('a.value').text().trim();
    const affSID = $$(el).find('strong.value').first().text().trim();
    const affRank = $$(el).find('strong.value').eq(1).text().trim();
    const affUrl = affSID ? `https://robertsspaceindustries.com/orgs/${affSID}` : null;

    if (affName && affSID) {
      affiliations.push({ name: affName, sid: affSID, rank: affRank, url: affUrl });
    }
  });

  return withTerminal({
    found: true,
    username,
    profileUrl,
    orgsUrl,
    mainOrg: mainName ? { name: mainName, sid: mainSID, rank: mainType, url: mainOrgUrl } : null,
    affiliations
  });
}

const client = MOCK_MODE ? null : new Client({ intents: [GatewayIntentBits.Guilds] });

function getBotStatus() {
  if (MOCK_MODE) return 'mock';
  if (client?.isReady()) return 'online';
  return 'starting';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      mode: MOCK_MODE ? 'mock' : 'discord',
      bot: getBotStatus(),
      uptime: Math.floor(process.uptime())
    }));
    return;
  }

  if (url.pathname === '/find') {
    const username = url.searchParams.get('username');
    if (!username) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing query param: username' }));
      return;
    }

    try {
      const result = await lookupProfile(username);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      console.error(`Error checking profile for "${username}":`, error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to check profile or affiliations.' }));
    }
    return;
  }

  if (url.pathname === '/simulator') {
    fs.readFile(SIMULATOR_PATH, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Simulator page not found.');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  const botStatus = getBotStatus();
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>SC Profiler Bot</title>
  <style>
    body { font-family: Consolas, monospace; background: #000; color: #00ff41; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; text-shadow: 0 0 6px rgba(0,255,65,.4); }
    a { color: #39ff14; }
    .status { display: inline-block; padding: 0.2rem 0.6rem; border: 1px solid #00ff41; border-radius: 2px; }
    code { border: 1px solid #003b00; padding: 0.1rem 0.3rem; background: #001100; }
  </style>
</head>
<body>
  <h1>▸ SC_Profiler</h1>
  <p>Status: <span class="status">${botStatus}</span></p>
  ${MOCK_MODE ? '<p>Mock mode — Discord disabled. RSI scraping active.</p>' : '<p>Discord bot online. Use <code>/find</code> in your server.</p>'}
  <p><a href="/simulator">/simulator</a> — Matrix UI preview</p>
  <p><a href="/health">/health</a></p>
</body>
</html>`);
});

server.listen(PORT, () => {
  console.log(`🌐 Local server listening on http://localhost:${PORT}`);
  if (MOCK_MODE) {
    console.log('🧪 Mock mode enabled — Discord login skipped');
    console.log(`   Simulator: http://localhost:${PORT}/simulator`);
  }
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use. Stop the other process or set PORT to a different value in .env`);
    process.exit(1);
  }
  throw err;
});

if (!MOCK_MODE) {
  const commands = [
    new SlashCommandBuilder()
      .setName('find')
      .setDescription('Look up an RSI citizen profile')
      .addStringOption(option =>
        option.setName('username')
          .setDescription('RSI username')
          .setRequired(true)
      )
  ].map(command => command.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  (async () => {
    try {
      console.log('🚀 Registering slash commands...');
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: commands }
      );
      console.log('✅ Slash commands registered!');
    } catch (error) {
      console.error('❌ Error registering commands:', error);
    }
  })();

  client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    console.log(`   In Discord, use /find with "${client.user.username}"`);
  });

  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    console.log(`📩 /${interaction.commandName} from ${interaction.user.tag}`);

    try {
      if (interaction.commandName === 'find') {
        await interaction.deferReply();

        const username = interaction.options.getString('username');
        const result = await lookupProfile(username);
        try {
          await interaction.editReply({
            ...buildProfilerReply(result),
            allowedMentions: { parse: [] }
          });
        } catch (replyError) {
          console.error(`Error sending /find reply for "${username}":`, replyError);
          const tooLong = replyError?.code === 50035;
          await interaction.editReply({
            content: wrapAnsiBlock([
              borderLine(TERMINAL_WIDTH),
              `${A.brightRed}▸ SYSTEM ERROR // UEE NET${A.reset}`,
              borderLine(TERMINAL_WIDTH),
              termRowAnsi('STATUS', 'TRANSMISSION FAULT', A.brightRed),
              termRowAnsi('DETAIL', tooLong ? 'Profile data exceeds Discord message limit' : 'Failed to deliver response to Discord', A.red),
              termRowAnsi('HINT', 'Try again or use the ORG LOG link on RSI', A.dim),
              borderLine(TERMINAL_WIDTH),
              `${A.dim}// TRANSMISSION TERMINATED${A.reset}`
            ].join('\n')),
            flags: MessageFlags.SuppressEmbeds
          }).catch(() => {});
        }
        return;
      }

      if (interaction.commandName === 'ping') {
        await interaction.reply('`▸ PONG // SIGNAL OK`');
        return;
      }

      if (interaction.commandName === 'shutdown') {
        await interaction.reply('`▸ SHUTDOWN INITIATED // SC_Profiler offline`');
        process.exit(0);
      }
    } catch (error) {
      console.error(`Error handling /${interaction.commandName}:`, error);
      const payload = {
        content: wrapAnsiBlock([
          borderLine(TERMINAL_WIDTH),
          `${A.brightRed}▸ SYSTEM ERROR // UEE NET${A.reset}`,
          borderLine(TERMINAL_WIDTH),
          termRowAnsi('STATUS', 'INTERNAL FAULT', A.brightRed),
          termRowAnsi('DETAIL', 'Failed to query RSI registry', A.red),
          borderLine(TERMINAL_WIDTH),
          `${A.dim}// TRANSMISSION TERMINATED${A.reset}`
        ].join('\n')),
        flags: MessageFlags.SuppressEmbeds
      };

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  });

  client.login(process.env.BOT_TOKEN);
}
