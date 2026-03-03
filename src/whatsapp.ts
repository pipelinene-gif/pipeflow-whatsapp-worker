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

    // ✅ 1) QR GERADO -> salva no Supabase
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

    // ✅ 2) CONECTOU -> marca connected e limpa qr
    if (connection === 'open') {
      console.log('WHATSAPP CONNECTED');
      try {
        await upsertSession(userId, 'connected', null);
      } catch (e: any) {
        console.error('FAILED TO MARK CONNECTED:', e?.message || e);
      }
      return;
    }

    // ✅ 3) DESCONECTOU -> tratar 401 / loggedOut / reconectar
    if (connection === 'close') {
      const err = lastDisconnect?.error as Boom | undefined;
      const statusCode = err?.output?.statusCode;

      console.log('DISCONNECT DETAIL:', {
        statusCode,
        message: err?.message,
        outputStatusCode: err?.output?.statusCode,
      });

      // 🚨 3.1) 401 Unauthorized -> limpa auth state e força novo QR
      if (statusCode === 401) {
        console.log('401 DETECTED -> CLEARING AUTH AND RESTARTING');

        try {
          // encerra socket atual
          try {
            socket.end(undefined);
          } catch {}

          activeSessions.delete(userId);

          // apaga credenciais locais
          await fs.rm(authFolder, { recursive: true, force: true });

          // marca sessão como pending (sem qr por enquanto)
          try {
            await upsertSession(userId, 'pending_qr', null);
          } catch {}

          // reinicia -> vai gerar novo QR no próximo connection.update
          await startSession(userId);
        } catch (e: any) {
          console.error('FAILED TO HANDLE 401:', e?.message || e);
        }

        return;
      }

      // 🔒 3.2) loggedOut -> não reconectar
      if (statusCode === DisconnectReason.loggedOut) {
        console.log('LOGGED OUT');
        try {
          await upsertSession(userId, 'disconnected', null);
        } catch {}
        activeSessions.delete(userId);
        return;
      }

      // 🔄 3.3) outros erros -> tenta reconectar
      console.log('RESTARTING SESSION...');
      activeSessions.delete(userId);
      await startSession(userId);
    }
  });

  // Inbound messages -> envia evento pro CRM
  socket.ev.on('messages.upsert', async ({ messages, type }: any) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid?.endsWith('@g.us')) continue;

      const rawJid = msg.key.remoteJid || '';
      const phone = '+' + rawJid.replace('@s.whatsapp.net', '');
      const name = msg.pushName || '';

      try {
        await sendInboundEvent(userId, phone, name);
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
