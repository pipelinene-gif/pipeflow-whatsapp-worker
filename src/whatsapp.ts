import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as QRCode from 'qrcode';
import pino from 'pino';
import path from 'path';
import fs from 'fs/promises';
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
      hasQr: !!qr,
      lastDisconnect: !!lastDisconnect,
    });

    if (qr) {
      try {
        const qrBase64 = await QRCode.toDataURL(qr);
        const base64Only = qrBase64.replace(/^data:image\/png;base64,/, '');

        await upsertSession(userId, 'pending_qr', base64Only);
        console.log('QR SALVO');
      } catch (e: any) {
        console.error('ERRO QR:', e?.message || e);
      }
    }

    if (connection === 'open') {
      console.log('WHATSAPP CONECTADO');
      await upsertSession(userId, 'connected', null);
      return;
    }

    if (connection === 'close') {
      const err = lastDisconnect?.error as Boom | undefined;
      const statusCode = err?.output?.statusCode;

      console.log('DESCONECTADO:', statusCode);

      if (statusCode === 401) {
        console.log('RESETANDO SESSÃO');

        try {
          socket.end(undefined);
        } catch {}

        activeSessions.delete(userId);
        await fs.rm(authFolder, { recursive: true, force: true });

        await upsertSession(userId, 'pending_qr', null);
        await startSession(userId);
        return;
      }

      if (statusCode === DisconnectReason.loggedOut) {
        await upsertSession(userId, 'disconnected', null);
        activeSessions.delete(userId);
        return;
      }

      activeSessions.delete(userId);
      await startSession(userId);
    }
  });

  // 🔥 BLOCO CORRIGIDO
  socket.ev.on('messages.upsert', async ({ messages, type }: any) => {
    console.log('messages.upsert:', type, messages?.length);

    for (const msg of messages) {
      try {
        const rawJid = msg.key.remoteJid || '';

        console.log('msg recebida:', {
          type,
          fromMe: msg.key.fromMe,
          remoteJid: rawJid,
          pushName: msg.pushName || '',
        });

        if (!rawJid) continue;
        if (rawJid.endsWith('@g.us')) continue;
        if (rawJid === 'status@broadcast') continue;
        if (!rawJid.endsWith('@s.whatsapp.net')) continue;

        const phone = '+' + rawJid.replace('@s.whatsapp.net', '');
        const name = msg.pushName || '';

        console.log('enviando para CRM:', { phone, name });

        await sendInboundEvent(userId, phone, name);

        console.log('ENVIADO COM SUCESSO');
      } catch (e: any) {
        console.error('ERRO sendInboundEvent:', e?.message || e);
      }
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
    try {
      await socket.logout();
    } catch {}
    activeSessions.delete(userId);

    await upsertSession(userId, 'disconnected', null);
  }
}
