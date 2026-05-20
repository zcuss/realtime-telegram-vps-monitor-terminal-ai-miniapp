import dotenv from 'dotenv';

dotenv.config();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const URL = process.env.BOT_PUBLIC_URL || process.env.PUBLIC_URL || '';
const ALLOWED = String(process.env.ALLOWED_TG_USER_ID || '');
const API = `https://api.telegram.org/bot${TOKEN}`;

if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN kosong');
  process.exit(1);
}
if (!URL) {
  console.error('BOT_PUBLIC_URL/PUBLIC_URL kosong. Isi URL HTTPS panel.');
  process.exit(1);
}

async function tg(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${JSON.stringify(data)}`);
  return data.result;
}

async function setup() {
  await tg('setMyCommands', { commands: [{ command: 'start', description: 'Open VPS dashboard' }] });
  await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'VPS', web_app: { url: URL } } });
  console.log(`Bot ready. Menu VPS -> ${URL}`);
}

async function sendStart(chatId) {
  await tg('sendMessage', {
    chat_id: chatId,
    text: 'VPS Monitor siap. Klik tombol di bawah.',
    reply_markup: {
      inline_keyboard: [[{ text: 'Open VPS Dashboard', web_app: { url: URL } }]],
    },
  });
}

let offset = 0;
await setup();

while (true) {
  try {
    const updates = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
    for (const u of updates) {
      offset = u.update_id + 1;
      const msg = u.message;
      if (!msg) continue;
      const userId = String(msg.from?.id || '');
      if (ALLOWED && userId !== ALLOWED) continue;
      if ((msg.text || '').startsWith('/start')) await sendStart(msg.chat.id);
    }
  } catch (e) {
    console.error(e.message);
    await new Promise(r => setTimeout(r, 3000));
  }
}
