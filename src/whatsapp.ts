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
  // Encerra sessão anterior, se existir
  if (activeSessions.has(userId)) {
    const oldSocket = activeSessions.get(userId);
    try {
      oldSocket.end(undefined);
    } catch {}
    activeSessions.delete(userId);
  }

  // Pasta de auth por usuário (persistência local do worker)
  const authFolder = path.join(__dirname, '..', 'auth_info_baileys', userId);

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  // Pega versão mais recente do WA
  const { version } = await fetchLatestBaileysVersion();

  const socket = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'debug' }),
    // Não usar printQRInTerminal (deprecated). O QR vai pro Supabase.
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

    // QR gerado -> salva no Supabase
    if (qr) {
      try {
        console.log('QR RECEIVED');

        const qrBase64 = await QRCode.toDataURL(qr);
        const base64Only = qrBase64.replace(/^data:image\/png;base64,/, '');

        await upsertSession(userId, 'pending_qr', base64Only);
        console.log('QR SAVED TO SUPABASE');
      } catch (e: any) {
        console.error('FAILED TO SAVE QR:', e?.message || e);
      }
    }

    // Conectou -> marca connected e limpa qr
    if (connection === 'open') {
      console.log('WHATSAPP CONNECTED');
      try {
        await upsertSession(userId, 'connected', null);
      } catch (e: any) {
        console.error('FAILED TO MARK CONNECTED:', e?.message || e);
      }
      return;
    }

    // Desconectou
    if (connection === 'close') {
      const err = lastDisconnect?.error as Boom | undefined;
      const statusCode = err?.output?.statusCode;

      console.log('DISCONNECT DETAIL:', {
        statusCode,
        message: err?.message,
        outputStatusCode: err?.output?.statusCode,
      });

      // 401 -> limpa auth e força novo QR
      if (statusCode === 401) {
        console.log('401 DETECTED -> CLEARING AUTH AND RESTARTING');

        try {
          try {
            socket.end(undefined);
          } catch {}

          activeSessions.delete(userId);

          await fs.rm(authFolder, { recursive: true, force: true });

          try {
            await upsertSession(userId, 'pending_qr', null);
          } catch {}

          await startSession(userId);
        } catch (e: any) {
          console.error('FAILED TO HANDLE 401:', e?.message || e);
        }

        return;
      }

      // loggedOut -> não reconectar
      if (statusCode === DisconnectReason.loggedOut) {
        console.log('LOGGED OUT');
        try {
          await upsertSession(userId, 'disconnected', null);
        } catch {}
        activeSessions.delete(userId);
        return;
      }

      // outros erros -> tenta reconectar
      console.log('RESTARTING SESSION...');
      activeSessions.delete(userId);
      await startSession(userId);
    }
  });

  // Mensagens -> envia evento pro CRM
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

        if (
          !rawJid.endsWith('@s.whatsapp.net') &&
          !rawJid.endsWith('@lid')
        ) continue;

        let phone = '';

        if (rawJid.endsWith('@s.whatsapp.net')) {
          phone = '+' + rawJid.replace('@s.whatsapp.net', '');
        }

        if (rawJid.endsWith('@lid')) {
          phone = '+' + rawJid.replace('@lid', '');
        }

        if (!phone || phone === '+') continue;

        const name = msg.pushName || '';

        console.log('enviando para CRM:', { phone, name });

        await sendInboundEvent(userId, phone, name);

        console.log('ENVIADO COM SUCESSO');
      } catch (e: any) {
        console.error('FAILED sendInboundEvent:', e?.message || e);
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

    try {
      await upsertSession(userId, 'disconnected', null);
    } catch {}
  }
}
