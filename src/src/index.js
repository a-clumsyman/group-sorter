// Starts Group Sorter: the WhatsApp bot plus its setup page.
// Exit code 2 tells the start file not to restart (nothing would change by trying again).

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  console.log('');
  console.log(`Group Sorter needs Node.js version 20 or newer. This computer has version ${process.versions.node}.`);
  console.log('Install the latest "LTS" version from https://nodejs.org and start again.');
  process.exit(2);
}

const { spawn } = await import('node:child_process');
const { createStore } = await import('./store.js');
const { createBot } = await import('./bot.js');
const { createServer } = await import('./server.js');

const PORT = Number(process.env.PORT) || 3210;
const address = `http://localhost:${PORT}`;

function openBrowser(url) {
  if (process.env.GROUP_SORTER_NO_BROWSER) return;
  try {
    const [cmd, args] =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* the address is printed below, so it can be opened by hand */
  }
}

// One bad message must never stop the bot.
process.on('unhandledRejection', (err) => console.log(`Something went wrong, carrying on: ${err?.message || err}`));
process.on('uncaughtException', (err) => console.log(`Something went wrong, carrying on: ${err?.message || err}`));

const store = createStore();
const bot = createBot({ store });
const web = createServer({ store, bot, port: PORT });

try {
  await web.listen();
} catch (err) {
  if (err?.code === 'EADDRINUSE') {
    console.log('');
    console.log('Group Sorter is already running in another window. Opening its page.');
    openBrowser(address);
    process.exit(2);
  }
  console.log(`The setup page could not start: ${err?.message || err}`);
  process.exit(1);
}

console.log('');
console.log('Group Sorter is running.');
console.log(`Setup page: ${address}`);
console.log('Keep this window open. Closing it stops the bot.');
console.log('');

openBrowser(address);
bot.start();

const shutdown = () => {
  bot.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
