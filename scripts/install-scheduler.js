#!/usr/bin/env node
/**
 * Print or install host scheduler entries for recurring Notion mirror refresh.
 *
 * This script does not store NOTION_API_KEY. Configure that secret in the
 * runtime environment used by the scheduler.
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
  console.log('Usage: install-scheduler.js [--config <path>] [--every <minutes>] [--name <name>] [--report] [--days <n>] [--mode print|install] [--json]');
  console.log('');
  console.log('Examples:');
  console.log('  install-scheduler.js --config config/notion-search-mirror.json --every 60');
  console.log('  install-scheduler.js --mode install --every 240');
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = stripTokenArg(argv);
  const options = {
    configPath: DEFAULT_CONFIG,
    everyMinutes: null,
    name: DEFAULT_NAME,
    nameSetByCli: false,
    mode: 'print',
    everySetByCli: false,
    report: false,
    reportDays: 7,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') usage(0);
    else if (args[i] === '--config' && args[i + 1]) options.configPath = args[++i];
    else if (args[i] === '--every' && args[i + 1]) {
      options.everyMinutes = parsePositiveInt(args[++i], DEFAULT_EVERY_MINUTES);
      options.everySetByCli = true;
    }
    else if (args[i] === '--name' && args[i + 1]) {
      options.name = sanitizeName(args[++i]);
      options.nameSetByCli = true;
    }
    else if (args[i] === '--report') options.report = true;
    else if (args[i] === '--days' && args[i + 1]) options.reportDays = parsePositiveInt(args[++i], 7);
    else if (args[i] === '--mode' && args[i + 1]) options.mode = parseMode(args[++i]);
    else throw new Error(`Unknown argument: ${args[i]}`);
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

function sanitizeName(value) {
  const cleaned = String(value || DEFAULT_NAME).replace(/[^a-zA-Z0-9_.-]/g, '-');
  return cleaned || DEFAULT_NAME;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildContext(options) {
  const workdir = process.cwd();
  const configPath = resolveSafePath(options.configPath, { mode: 'read' });
  const config = readConfigIfPresent(configPath);
  const configuredEvery = parsePositiveInt(config?.sync?.intervalMinutes, DEFAULT_EVERY_MINUTES);
  const scriptPath = path.resolve(__dirname, 'mirror-config.js');
  const nodePath = process.execPath;
  const logPath = path.join(workdir, options.report ? '.notion-sync-to-search-report.log' : '.notion-sync-to-search.log');
  const commandArgs = options.report
    ? [scriptPath, configPath, '--report', '--days', String(options.reportDays)]
    : [scriptPath, configPath];

  return {
    ...options,
    name: options.report && !options.nameSetByCli ? `${options.name}-report` : options.name,
    everyMinutes: options.everySetByCli ? options.everyMinutes : configuredEvery,
    workdir,
    configPath,
    scriptPath,
    nodePath,
    commandArgs,
    logPath,
  };
}

function readConfigIfPresent(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (_) {
    return {};
  }
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
    <string>${xmlEscape(ctx.nodePath)}</string>
${ctx.commandArgs.map(arg => `    <string>${xmlEscape(arg)}</string>`).join('\n')}
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
      `launchctl setenv NOTION_API_KEY '<your-notion-token>'`,
      `launchctl bootstrap gui/$(id -u) ${shellQuote(plistPath)}`,
      `launchctl enable gui/$(id -u)/${label}`,
    ],
  };
}

function buildSystemd(ctx) {
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const servicePath = path.join(unitDir, `${ctx.name}.service`);
  const timerPath = path.join(unitDir, `${ctx.name}.timer`);
  const command = `mkdir -p ${shellQuote(path.dirname(ctx.logPath))} && ${shellQuote(ctx.nodePath)} ${ctx.commandArgs.map(shellQuote).join(' ')} >> ${shellQuote(ctx.logPath)} 2>&1`;

  return {
    kind: 'systemd',
    files: [
      {
        path: servicePath,
        content: `[Unit]
Description=Refresh Notion search mirror

[Service]
Type=oneshot
WorkingDirectory=${ctx.workdir}
ExecStart=/bin/sh -lc ${shellQuote(command)}
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

[Install]
WantedBy=timers.target
`,
      },
    ],
    installNotes: [
      `mkdir -p ${shellQuote(unitDir)}`,
      'Set NOTION_API_KEY in the user systemd environment before enabling the timer.',
      "systemctl --user import-environment NOTION_API_KEY",
      'systemctl --user daemon-reload',
      `systemctl --user enable --now ${shellQuote(`${ctx.name}.timer`)}`,
    ],
  };
}

function buildCron(ctx) {
  const command = `cd ${shellQuote(ctx.workdir)} && mkdir -p ${shellQuote(path.dirname(ctx.logPath))} && ${shellQuote(ctx.nodePath)} ${ctx.commandArgs.map(shellQuote).join(' ')} >> ${shellQuote(ctx.logPath)} 2>&1`;
  if (ctx.everyMinutes < 60) {
    return {
      kind: 'cron',
      content: `*/${ctx.everyMinutes} * * * * ${command}`,
      installNotes: [
        'Add this line to the user crontab after ensuring NOTION_API_KEY is available to cron.',
        'crontab -e',
      ],
    };
  }

  const intervalSeconds = ctx.everyMinutes * 60;
  const stampPath = path.join(ctx.workdir, `.${ctx.name}.last-run`);
  const gatedCommand = [
    `now=$(date +\\%s)`,
    `last=$(cat ${shellQuote(stampPath)} 2>/dev/null || echo 0)`,
    `if [ $((now - last)) -ge ${intervalSeconds} ]; then`,
    `echo "$now" > ${shellQuote(stampPath)}`,
    `${command}`,
    'fi',
  ].join('; ');

  return {
    kind: 'cron',
    content: `* * * * ${gatedCommand}`,
    installNotes: [
      'Add this line to the user crontab after ensuring NOTION_API_KEY is available to cron.',
      'crontab -e',
    ],
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
      if (hasJsonFlag()) {
        console.log(JSON.stringify({ installed: written, plan }, null, 2));
      } else {
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
