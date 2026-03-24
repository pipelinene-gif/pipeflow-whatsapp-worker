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

function normalizePhone(value: string): string | null {
  const digits = (value || '').replace(/\D/g, '');

  // aceita algo entre 10 e 15 dígitos
  if (!digits || digits.length < 10 || digits.length > 15) {
    return null;
  }

  return `+${digits}`;
}

function extractPhoneFromJid(rawJid: string): string | null {
  if (!rawJid) return null;

  // caso normal: contato individual
  if (rawJid.endsWith('@s.whatsapp.net')) {
    const base = rawJid.replace('@s.whatsapp.net', '');
    return normalizePhone(base);
  }

  // fallback: alguns casos vêm como @lid
  // aqui extraímos apenas os dígitos e validamos tamanho
  if (rawJid.endsWith('@lid')) {
    const base = rawJid.replace('@lid', '');
    return normalizePhone(base);
  }

  return null;
}

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
        console.log('QR RECEIVED');

        const qrBase64 = await QRCode.toDataURL(qr);
        const base64Only = qrBase64.replace(/^data:image\/png;base64,/, '');

        await upsertSession(userId, 'pending_qr', base64Only);
        console.log('QR SAVED TO SUPABASE');
      } catch (e: any) {
        console.error('FAILED TO SAVE QR:', e?.message || e);
      }
    }

    if (connection === 'open') {
      console.log('WHATSAPP CONNECTED');
      try {
        await upsertSession(userId, 'connected', null);
      } catch (e: any) {
        console.error('FAILED TO MARK CONNECTED:', e?.message || e);
      }
      return;
    }

    if (connection === 'close') {
      const err = lastDisconnect?.error as Boom | undefined;
      const statusCode = err?.output?.statusCode;

      console.log('DISCONNECT DETAIL:', {
        statusCode,
        message: err?.message,
        outputStatusCode: err?.output?.statusCode,
      });

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

      if (statusCode === DisconnectReason.loggedOut) {
        console.log('LOGGED OUT');
        try {
          await upsertSession(userId, 'disconnected', null);
        } catch {}
        activeSessions.delete(userId);
        return;
      }

      console.log('RESTARTING SESSION...');
      activeSessions.delete(userId);
      await startSession(userId);
    }
  });

  socket.ev.on('messages.upsert', async ({ messages, type }: any) => {
    console.log('messages.upsert:', type, messages?.length);

    for (const msg of messages) {
      try {
        if (!msg?.key) continue;

        const rawJid = msg.key.remoteJid || '';
        const fromMe = !!msg.key.fromMe;
        const pushName = msg.pushName || '';
        const participant = msg.key.participant || '';

        console.log('[DEBUG MESSAGE]', {
          type,
          fromMe,
          remoteJid: rawJid,
          participant,
          pushName,
          messageId: msg.key.id,
        });

        if (!rawJid) continue;

        // ignora grupos
        if (rawJid.endsWith('@g.us')) {
          console.log('[IGNORADO GRUPO]', rawJid);
          continue;
        }

        // ignora status
        if (rawJid === 'status@broadcast') {
          console.log('[IGNORADO STATUS]', rawJid);
          continue;
        }

        // ignora broadcasts/outros tipos estranhos
        if (
          !rawJid.endsWith('@s.whatsapp.net') &&
          !rawJid.endsWith('@lid')
        ) {
          console.log('[IGNORADO JID NAO SUPORTADO]', rawJid);
          continue;
        }

        const phone = extractPhoneFromJid(rawJid);

        if (!phone) {
          console.log('[PHONE INVALIDO - IGNORADO]', { rawJid });
          continue;
        }

        const name = pushName || '';

        console.log('[ENVIANDO PARA CRM]', {
          direction: fromMe ? 'outbound' : 'inbound',
          rawJid,
          phone,
          name,
        });

        await sendInboundEvent(userId, phone, name);

        console.log('[ENVIADO COM SUCESSO]', {
          direction: fromMe ? 'outbound' : 'inbound',
          phone,
        });
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
