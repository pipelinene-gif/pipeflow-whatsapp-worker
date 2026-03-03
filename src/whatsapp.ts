import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as QRCode from 'qrcode';
import pino from 'pino';
import path from 'path';
import { upsertSession, sendInboundEvent } from './supabase';

const activeSessions: Map<string, any> = new Map();

export async function startSession(userId: string) {
  if (activeSessions.has(userId)) {
    const oldSocket = activeSessions.get(userId);
    try {
      oldSocket.end(undefined);
    } catch {}
    activeSessions.delete(userId);
  }

  const authFolder = path.join(__dirname, '..', 'auth_info_baileys', userId);

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  // 🔥 PEGA VERSÃO MAIS RECENTE DO WA (CORRIGE ERRO 405)
  const { version } = await fetchLatestBaileysVersion();

  const socket = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'debug' }),
  });

  activeSessions.set(userId, socket);

  socket.ev.on('creds.update', saveCreds);

  socket.ev.on('connection.update', async (update: any) => {
    const { connection, lastDisconnect, qr } = update;

    console.log('connection.update:', {
      connection,
      hasQr: !!qr
    });

    if (qr) {
      console.log('QR RECEIVED');

      const qrBase64 = await QRCode.toDataURL(qr);
      const base64Only = qrBase64.replace(/^data:image\/png;base64,/, '');

      await upsertSession(userId, 'pending_qr', base64Only);
    }

    if (connection === 'open') {
      console.log('WHATSAPP CONNECTED');
      await upsertSession(userId, 'connected', null);
    }

    if (connection === 'close') {
      const err = lastDisconnect?.error as Boom;
      const statusCode = err?.output?.statusCode;

      console.log('DISCONNECT DETAIL:', {
        statusCode,
        message: err?.message,
        output: err?.output,
        stack: err?.stack,
      });

      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        console.log('RESTARTING SESSION...');
        activeSessions.delete(userId);
        await startSession(userId);
      } else {
        console.log('LOGGED OUT');
        await upsertSession(userId, 'disconnected', null);
        activeSessions.delete(userId);
      }
    }
  });

  socket.ev.on('messages.upsert', async ({ messages, type }: any) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid?.endsWith('@g.us')) continue;

      const rawJid = msg.key.remoteJid || '';
      const phone = '+' + rawJid.replace('@s.whatsapp.net', '');
      const name = msg.pushName || '';

      await sendInboundEvent(userId, phone, name);
    }
  });

  return { success: true };
}

export function getSessionStatus(userId: string) {
  return activeSessions.has(userId) ? 'active' : 'inactive';
}

export async function disconnectSession(userId: string) {
  const socket = activeSessions.get(userId);
  if (socket) {
    await socket.logout();
    activeSessions.delete(userId);
    await upsertSession(userId, 'disconnected', null);
  }
}