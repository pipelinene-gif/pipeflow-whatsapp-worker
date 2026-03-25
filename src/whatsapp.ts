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
const reconnectTimers: Map<string, NodeJS.Timeout> = new Map();
const processedMessages: Map<string, number> = new Map();
const qrPendingUsers: Set<string> = new Set();

const MESSAGE_CACHE_TTL_MS = 1000 * 60 * 30;
const MAX_MESSAGE_AGE_SECONDS = 60 * 15;

function normalizePhone(value: string): string | null {
  const digits = (value || '').replace(/\D/g, '');

  if (!digits || digits.length < 10 || digits.length > 15) {
    return null;
  }

  return `+${digits}`;
}

function extractPhoneFromJid(rawJid: string): string | null {
  if (!rawJid) return null;

  if (rawJid.endsWith('@s.whatsapp.net')) {
    const base = rawJid.replace('@s.whatsapp.net', '');
    return normalizePhone(base);
  }

  return null;
}

function getMessageTimestampSeconds(msg: any): number | null {
  const raw = msg?.messageTimestamp;

  if (!raw) return null;
  if (typeof raw === 'number') return raw;

  if (typeof raw === 'string') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (typeof raw?.low === 'number') return raw.low;

  if (typeof raw?.toNumber === 'function') {
    try {
      return raw.toNumber();
    } catch {
      return null;
    }
  }

  return null;
}

function isMessageTooOld(msg: any): boolean {
  const ts = getMessageTimestampSeconds(msg);
  if (!ts) return false;

  const now = Math.floor(Date.now() / 1000);
  return now - ts > MAX_MESSAGE_AGE_SECONDS;
}

function buildProcessedMessageKey(userId: string, msg: any): string | null {
  const id = msg?.key?.id;
  const remoteJid = msg?.key?.remoteJid;

  if (!id || !remoteJid) return null;
  return `${userId}:${remoteJid}:${id}`;
}

function markMessageProcessed(key: string) {
  processedMessages.set(key, Date.now());
}

function wasMessageProcessedRecently(key: string): boolean {
  const ts = processedMessages.get(key);
  if (!ts) return false;

  if (Date.now() - ts > MESSAGE_CACHE_TTL_MS) {
    processedMessages.delete(key);
    return false;
  }

  return true;
}

function cleanupProcessedMessages() {
  const now = Date.now();

  for (const [key, ts] of processedMessages.entries()) {
    if (now - ts > MESSAGE_CACHE_TTL_MS) {
      processedMessages.delete(key);
    }
  }
}

function clearReconnectTimer(userId: string) {
  const timer = reconnectTimers.get(userId);
  if (timer) {
    clearTimeout(timer);
    reconnectTimers.delete(userId);
  }
}

function scheduleReconnect(userId: string, delayMs = 3000) {
  if (qrPendingUsers.has(userId)) {
    console.log(`[RECONNECT IGNORADO] QR pendente para user=${userId}`);
    return;
  }

  clearReconnectTimer(userId);

  const timer = setTimeout(async () => {
    reconnectTimers.delete(userId);

    if (qrPendingUsers.has(userId)) {
      console.log(`[RECONNECT CANCELADO] QR pendente para user=${userId}`);
      return;
    }

    try {
      console.log(`[RECONNECT] Reiniciando sessão do usuário ${userId}`);
      await startSession(userId);
    } catch (err: any) {
      console.error(`[RECONNECT ERROR] user=${userId}`, err?.message || err);
    }
  }, delayMs);

  reconnectTimers.set(userId, timer);
}

function safeSocketEnd(socket: any) {
  try {
    socket?.end?.(undefined);
  } catch {}
}

function safeSocketLogout(socket: any) {
  try {
    return socket?.logout?.();
  } catch {
    return Promise.resolve();
  }
}

function getMessageKeys(msg: any): string[] {
  const content = msg?.message;
  if (!content || typeof content !== 'object') return [];
  return Object.keys(content);
}

function hasMeaningfulContent(msg: any): boolean {
  const keys = getMessageKeys(msg);
  if (keys.length === 0) return false;

  const usefulTypes = new Set([
    'conversation',
    'extendedTextMessage',
    'imageMessage',
    'videoMessage',
    'audioMessage',
    'documentMessage',
    'stickerMessage',
    'contactMessage',
    'contactsArrayMessage',
    'locationMessage',
    'liveLocationMessage',
    'buttonsResponseMessage',
    'listResponseMessage',
    'templateButtonReplyMessage',
    'interactiveResponseMessage',
    'reactionMessage',
  ]);

  return keys.some((key) => usefulTypes.has(key));
}

function safeExtractTextPreview(msg: any): string {
  const message = msg?.message || {};

  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    message?.documentMessage?.caption ||
    message?.buttonsResponseMessage?.selectedButtonId ||
    message?.listResponseMessage?.title ||
    message?.templateButtonReplyMessage?.selectedId ||
    message?.interactiveResponseMessage?.body?.text ||
    ''
  );
}

async function destroyExistingSession(userId: string) {
  const existing = activeSessions.get(userId);
  if (existing) {
    safeSocketEnd(existing);
    activeSessions.delete(userId);
  }

  clearReconnectTimer(userId);
}

export async function startSession(userId: string) {
  cleanupProcessedMessages();

  await destroyExistingSession(userId);
  qrPendingUsers.delete(userId);

  const authFolder = path.join(__dirname, '..', 'auth_info_baileys', userId);
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  console.log(`[SESSION START] user=${userId}`);

  const socket = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }),
    browser: ['PipeFlow Worker', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldIgnoreJid: (jid) => {
      if (!jid) return true;
      if (jid === 'status@broadcast') return true;
      if (jid.endsWith('@g.us')) return true;
      return false;
    },
  });

  activeSessions.set(userId, socket);

  socket.ev.on('creds.update', saveCreds);

  socket.ev.on('connection.update', async (update: any) => {
    const { connection, lastDisconnect, qr } = update;

    console.log('[CONNECTION UPDATE]', {
      userId,
      connection,
      hasQr: !!qr,
      hasLastDisconnect: !!lastDisconnect,
    });

    if (qr) {
      try {
        qrPendingUsers.add(userId);
        clearReconnectTimer(userId);

        console.log(`[QR] QR recebido para user=${userId}`);

        const qrBase64 = await QRCode.toDataURL(qr);
        const base64Only = qrBase64.replace(/^data:image\/png;base64,/, '');

        await upsertSession(userId, 'pending_qr', base64Only);
        console.log(`[QR] QR salvo no Supabase para user=${userId}`);
      } catch (e: any) {
        console.error('[QR ERROR]', e?.message || e);
      }

      return;
    }

    if (connection === 'open') {
      console.log(`[CONNECTED] WhatsApp conectado para user=${userId}`);

      qrPendingUsers.delete(userId);
      clearReconnectTimer(userId);

      try {
        await upsertSession(userId, 'connected', null);
      } catch (e: any) {
        console.error('[CONNECTED ERROR]', e?.message || e);
      }

      return;
    }

    if (connection === 'close') {
      const err = lastDisconnect?.error as Boom | undefined;
      const statusCode = err?.output?.statusCode;

      console.log('[DISCONNECTED]', {
        userId,
        statusCode,
        message: err?.message,
      });

      activeSessions.delete(userId);

      if (qrPendingUsers.has(userId) && !statusCode) {
        console.log(`[CLOSE IGNORADO] aguardando leitura do QR user=${userId}`);
        return;
      }

      if (statusCode === 401) {
        console.log(`[401] Sessão inválida. Limpando auth. user=${userId}`);

        qrPendingUsers.delete(userId);

        try {
          safeSocketEnd(socket);
          await fs.rm(authFolder, { recursive: true, force: true });
          await upsertSession(userId, 'pending_qr', null);
          scheduleReconnect(userId, 2000);
        } catch (e: any) {
          console.error('[401 HANDLE ERROR]', e?.message || e);
          try {
            await upsertSession(userId, 'disconnected', null);
          } catch {}
        }

        return;
      }

      if (statusCode === DisconnectReason.loggedOut) {
        console.log(`[LOGGED OUT] user=${userId}`);

        qrPendingUsers.delete(userId);

        try {
          await upsertSession(userId, 'disconnected', null);
        } catch {}

        clearReconnectTimer(userId);
        return;
      }

      try {
        await upsertSession(userId, 'disconnected', null);
      } catch {}

      qrPendingUsers.delete(userId);
      scheduleReconnect(userId, 3000);
    }
  });

  socket.ev.on('messages.upsert', async ({ messages, type }: any) => {
    console.log('[MESSAGES UPSERT]', {
      userId,
      type,
      count: messages?.length || 0,
    });

    if (type !== 'notify') {
      console.log(`[IGNORADO] type=${type} user=${userId}`);
      return;
    }

    for (const msg of messages || []) {
      try {
        if (!msg?.key) {
          console.log('[IGNORADO] mensagem sem key');
          continue;
        }

        const rawJid = msg.key.remoteJid || '';
        const fromMe = !!msg.key.fromMe;
        const pushName = msg.pushName || '';
        const participant = msg.key.participant || '';
        const messageId = msg.key.id || '';
        const messageKeys = getMessageKeys(msg);
        const preview = safeExtractTextPreview(msg);

        console.log('[DEBUG MESSAGE]', {
          userId,
          type,
          fromMe,
          remoteJid: rawJid,
          participant,
          pushName,
          messageId,
          messageKeys,
          preview,
        });

        if (!rawJid) {
          console.log('[IGNORADO] rawJid vazio');
          continue;
        }

        if (rawJid === 'status@broadcast') {
          console.log('[IGNORADO STATUS]', rawJid);
          continue;
        }

        if (rawJid.endsWith('@g.us')) {
          console.log('[IGNORADO GRUPO]', rawJid);
          continue;
        }

        if (rawJid.endsWith('@broadcast')) {
          console.log('[IGNORADO BROADCAST]', rawJid);
          continue;
        }

        if (rawJid.endsWith('@lid')) {
          console.log('[IGNORADO LID]', rawJid);
          continue;
        }

        if (!rawJid.endsWith('@s.whatsapp.net')) {
          console.log('[IGNORADO JID NAO SUPORTADO]', rawJid);
          continue;
        }

        if (!hasMeaningfulContent(msg)) {
          console.log('[IGNORADO SEM CONTEUDO UTIL]', {
            rawJid,
            messageId,
            messageKeys,
            preview,
          });
          continue;
        }

        if (isMessageTooOld(msg)) {
          console.log('[IGNORADO MENSAGEM ANTIGA]', {
            rawJid,
            messageId,
            timestamp: getMessageTimestampSeconds(msg),
          });
          continue;
        }

        const processedKey = buildProcessedMessageKey(userId, msg);
        if (processedKey && wasMessageProcessedRecently(processedKey)) {
          console.log('[IGNORADO DUPLICADA]', {
            rawJid,
            messageId,
          });
          continue;
        }

        const phone = extractPhoneFromJid(rawJid);

        if (!phone) {
          console.log('[PHONE INVALIDO - IGNORADO]', {
            rawJid,
            messageId,
          });
          continue;
        }

        const name =
          !fromMe && typeof pushName === 'string'
            ? pushName.trim()
            : '';

        console.log('[ENVIANDO PARA CRM]', {
          userId,
          direction: fromMe ? 'outbound' : 'inbound',
          rawJid,
          phone,
          name,
          messageId,
          messageKeys,
          preview,
        });

        await sendInboundEvent(userId, phone, name);

        if (processedKey) {
          markMessageProcessed(processedKey);
        }

        console.log('[ENVIADO COM SUCESSO]', {
          userId,
          direction: fromMe ? 'outbound' : 'inbound',
          phone,
          name,
          messageId,
        });
      } catch (e: any) {
        console.error('[FAILED sendInboundEvent]', e?.message || e);
      }
    }
  });

  return { success: true };
}

export function getSessionStatus(userId: string) {
  return activeSessions.has(userId) ? 'active' : 'inactive';
}

export async function disconnectSession(userId: string) {
  clearReconnectTimer(userId);
  qrPendingUsers.delete(userId);

  const socket = activeSessions.get(userId);
  if (socket) {
    try {
      await safeSocketLogout(socket);
    } catch {}

    safeSocketEnd(socket);
    activeSessions.delete(userId);
  }

  try {
    await upsertSession(userId, 'disconnected', null);
  } catch {}
}
