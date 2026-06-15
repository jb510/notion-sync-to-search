#!/usr/bin/env node
/**
 * Print or install host scheduler entries for recurring Notion mirror refresh.
 *
 * This script does not store NOTION_API_KEY. It passes the install state .env
 * file to mirror-config.js, which parses it without shell-sourcing.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  stripTokenArg,
  hasJsonFlag,
  resolveSafePath,
} = require('./notion-utils.js');

const DEFAULT_CONFIG = 'config/notion-search-mirror.json';
const DEFAULT_NAME = 'notion-sync-to-search';
const DEFAULT_EVERY_MINUTES = 60;

function usage(exitCode = 0) {
  console.log('Usage: install-scheduler.js [--config <path>] [--state-dir <path>] [--every <minutes>] [--name <name>] [--env-file <path>] [--log-dir <path>] [--systemd-scope user|system] [--report] [--days <n>] [--mode print|install] [--json]');
  console.log('');
  console.log('Examples:');
  console.log('  install-scheduler.js --state-dir /root/.openclaw --systemd-scope system --mode install');
  console.log('  install-scheduler.js --state-dir /Users/walden/OpenClaw/anastasia/state --name notion-sync-to-search-anastasia --mode install');
  console.log('  install-scheduler.js --config config/notion-search-mirror.json --every 240');
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = stripTokenArg(argv);
  const options = {
    configPath: DEFAULT_CONFIG,
    configSetByCli: false,
    stateDir: null,
    everyMinutes: null,
    everySetByCli: false,
    name: DEFAULT_NAME,
    nameSetByCli: false,
    envFile: null,
    logDir: null,
    systemdScope: 'user',
    mode: 'print',
    report: false,
    reportDays: 7,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') usage(0);
    else if (arg === '--config' && args[i + 1]) { options.configPath = args[++i]; options.configSetByCli = true; }
    else if (arg === '--state-dir' && args[i + 1]) options.stateDir = args[++i];
    else if (arg === '--every' && args[i + 1]) { options.everyMinutes = parsePositiveInt(args[++i], DEFAULT_EVERY_MINUTES); options.everySetByCli = true; }
    else if (arg === '--name' && args[i + 1]) { options.name = sanitizeName(args[++i]); options.nameSetByCli = true; }
    else if (arg === '--env-file' && args[i + 1]) options.envFile = args[++i];
    else if (arg === '--log-dir' && args[i + 1]) options.logDir = args[++i];
    else if (arg === '--systemd-scope' && args[i + 1]) options.systemdScope = parseSystemdScope(args[++i]);
    else if (arg === '--report') options.report = true;
    else if (arg === '--days' && args[i + 1]) options.reportDays = parsePositiveInt(args[++i], 7);
    else if (arg === '--mode' && args[i + 1]) options.mode = parseMode(args[++i]);
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }

  return options;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseMode(value) {
  if (value === 'print' || value === 'install') return value;
  throw new Error('--mode must be "print" or "install"');
}

function parseSystemdScope(value) {
  if (value === 'user' || value === 'system') return value;
  throw new Error('--systemd-scope must be "user" or "system"');
}

function sanitizeName(value) {
  const cleaned = String(value || DEFAULT_NAME).replace(/[^a-zA-Z0-9_.-]/g, '-');
  return cleaned || DEFAULT_NAME;
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\''`)}'`;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function readConfigIfPresent(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (_) {
    return {};
  }
}

function schedulerNodePath() {
  const stableCandidates = process.platform === 'darwin'
    ? ['/opt/homebrew/bin/node', '/usr/local/bin/node']
    : ['/usr/bin/node', '/usr/local/bin/node'];
  for (const candidate of stableCandidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_) {
      // Keep looking for a stable executable before falling back.
    }
  }
  return process.execPath;
}

function buildContext(options) {
  const stateDir = options.stateDir ? path.resolve(expandHome(options.stateDir)) : null;
  const workdir = stateDir || process.cwd();
  const configCandidate = stateDir && !options.configSetByCli
    ? path.join(stateDir, 'config', 'notion-search-mirror.json')
    : options.configPath;
  const configPath = resolveSafePath(configCandidate, { mode: 'read' });
  const config = readConfigIfPresent(configPath);
  const configuredEvery = parsePositiveInt(config?.sync?.intervalMinutes, DEFAULT_EVERY_MINUTES);
  const scriptPath = path.resolve(__dirname, 'mirror-config.js');
  const nodePath = schedulerNodePath();
  const logDir = options.logDir ? path.resolve(expandHome(options.logDir)) : path.join(workdir, 'logs');
  const logPath = path.join(logDir, options.report ? 'notion-sync-to-search-report.log' : 'notion-sync-to-search.log');
  const envFile = options.envFile ? path.resolve(expandHome(options.envFile)) : (stateDir ? path.join(stateDir, '.env') : null);
  const baseCommandArgs = options.report
    ? [scriptPath, configPath, '--report', '--days', String(options.reportDays)]
    : [scriptPath, configPath];
  const commandArgs = envFile ? [...baseCommandArgs, '--env-file', envFile] : baseCommandArgs;

  return {
    ...options,
    stateDir,
    name: options.report && !options.nameSetByCli ? `${options.name}-report` : options.name,
    everyMinutes: options.everySetByCli ? options.everyMinutes : configuredEvery,
    workdir,
    configPath,
    scriptPath,
    nodePath,
    commandArgs,
    logDir,
    logPath,
    envFile,
  };
}

function commandString(ctx) {
  return `mkdir -p ${shellQuote(path.dirname(ctx.logPath))}; cd ${shellQuote(ctx.workdir)} && ${shellQuote(ctx.nodePath)} ${ctx.commandArgs.map(shellQuote).join(' ')} >> ${shellQuote(ctx.logPath)} 2>&1`;
}

function buildLaunchd(ctx) {
  const label = `com.openclaw.${ctx.name}`;
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(ctx.workdir)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>${xmlEscape(commandString(ctx))}</string>
  </array>
  <key>StartInterval</key>
  <integer>${ctx.everyMinutes * 60}</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(ctx.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(ctx.logPath)}</string>
</dict>
</plist>
`;

  return {
    kind: 'launchd',
    path: plistPath,
    content: plist,
    installNotes: [
      `mkdir -p ${shellQuote(path.dirname(plistPath))}`,
      `launchctl bootstrap gui/$(id -u) ${shellQuote(plistPath)}`,
      `launchctl enable gui/$(id -u)/${label}`,
      `launchctl kickstart -k gui/$(id -u)/${label}`,
    ],
  };
}

function buildSystemd(ctx) {
  const unitDir = ctx.systemdScope === 'system' ? '/etc/systemd/system' : path.join(os.homedir(), '.config', 'systemd', 'user');
  const servicePath = path.join(unitDir, `${ctx.name}.service`);
  const timerPath = path.join(unitDir, `${ctx.name}.timer`);
  const execArgs = ctx.commandArgs.map(arg => arg.includes(' ') ? shellQuote(arg) : arg).join(' ');

  return {
    kind: ctx.systemdScope === 'system' ? 'systemd-system' : 'systemd-user',
    files: [
      {
        path: servicePath,
        content: `[Unit]
Description=Refresh Notion search mirror

[Service]
Type=oneshot
WorkingDirectory=${ctx.workdir}
ExecStartPre=/bin/mkdir -p ${path.dirname(ctx.logPath)}
ExecStart=${ctx.nodePath} ${execArgs}
StandardOutput=append:${ctx.logPath}
StandardError=append:${ctx.logPath}
`,
      },
      {
        path: timerPath,
        content: `[Unit]
Description=Refresh Notion search mirror every ${ctx.everyMinutes} minutes

[Timer]
OnBootSec=5m
OnUnitActiveSec=${ctx.everyMinutes}m
Unit=${ctx.name}.service
Persistent=true

[Install]
WantedBy=timers.target
`,
      },
    ],
    installNotes: ctx.systemdScope === 'system'
      ? [
        'systemctl daemon-reload',
        `systemctl enable --now ${shellQuote(`${ctx.name}.timer`)}`,
        `systemctl start ${shellQuote(`${ctx.name}.service`)}`,
      ]
      : [
        `mkdir -p ${shellQuote(unitDir)}`,
        ctx.envFile ? `Ensure ${ctx.envFile} contains NOTION_API_KEY` : 'Set NOTION_API_KEY in the user systemd environment before enabling the timer.',
        'systemctl --user daemon-reload',
        `systemctl --user enable --now ${shellQuote(`${ctx.name}.timer`)}`,
      ],
  };
}

function buildCron(ctx) {
  const command = commandString(ctx);
  if (ctx.everyMinutes < 60) {
    return {
      kind: 'cron',
      content: `*/${ctx.everyMinutes} * * * * ${command}`,
      installNotes: ['Add this line to the user crontab.', 'crontab -e'],
    };
  }

  const intervalSeconds = ctx.everyMinutes * 60;
  const stampPath = path.join(ctx.workdir, `.${ctx.name}.last-run`);
  const gatedCommand = [
    `now=$(date +\%s)`,
    `last=$(cat ${shellQuote(stampPath)} 2>/dev/null || echo 0)`,
    `if [ $((now - last)) -ge ${intervalSeconds} ]; then`,
    `echo "$now" > ${shellQuote(stampPath)}`,
    command,
    'fi',
  ].join('; ');

  return {
    kind: 'cron',
    content: `* * * * ${gatedCommand}`,
    installNotes: ['Add this line to the user crontab.', 'crontab -e'],
  };
}

function buildPlan(ctx) {
  if (process.platform === 'darwin') return buildLaunchd(ctx);
  if (process.platform === 'linux') return buildSystemd(ctx);
  return buildCron(ctx);
}

function installPlan(plan) {
  if (plan.path) {
    fs.mkdirSync(path.dirname(plan.path), { recursive: true });
    writeRegularFile(plan.path, plan.content);
    return [plan.path];
  }

  if (plan.files) {
    for (const file of plan.files) {
      fs.mkdirSync(path.dirname(file.path), { recursive: true });
      writeRegularFile(file.path, file.content);
    }
    return plan.files.map(file => file.path);
  }

  return [];
}

function writeRegularFile(filePath, content) {
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
    throw new Error(`Refusing to write through symlink: ${filePath}`);
  }
  fs.writeFileSync(filePath, content, 'utf8');
}

function printPlan(plan) {
  if (hasJsonFlag()) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  console.log(`Scheduler type: ${plan.kind}`);
  if (plan.path) {
    console.log(`File: ${plan.path}`);
    console.log('');
    console.log(plan.content.trimEnd());
  } else if (plan.files) {
    for (const file of plan.files) {
      console.log(`File: ${file.path}`);
      console.log('');
      console.log(file.content.trimEnd());
      console.log('');
    }
  } else {
    console.log(plan.content);
  }

  console.log('');
  console.log('Activation notes:');
  for (const note of plan.installNotes) console.log(`  ${note}`);
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const ctx = buildContext(options);
    const plan = buildPlan(ctx);

    if (options.mode === 'install') {
      const written = installPlan(plan);
      if (hasJsonFlag()) console.log(JSON.stringify({ installed: written, plan }, null, 2));
      else {
        console.log(`Installed scheduler file(s): ${written.join(', ') || '(none)'}`);
        console.log('Next steps:');
        for (const note of plan.installNotes) console.log(`  ${note}`);
      }
      return;
    }

    printPlan(plan);
  } catch (error) {
    if (hasJsonFlag()) console.log(JSON.stringify({ error: error.message }, null, 2));
    else console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  _internal: {
    buildContext,
    buildPlan,
    parseArgs,
  },
};
