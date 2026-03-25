import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { sendInboundEvent } from './supabase';

const processedMessages = new Map<string, number>();
const inFlightMessages: Set<string> = new Set();

const MESSAGE_TTL_MS = 5 * 60 * 1000;

function buildProcessedMessageKey(userId: string, msg: any) {
  return `${userId}_${msg?.key?.id}`;
}

function wasMessageProcessedRecently(key: string) {
  const ts = processedMessages.get(key);
  if (!ts) return false;
  return Date.now() - ts < MESSAGE_TTL_MS;
}

function markMessageProcessed(key: string) {
  processedMessages.set(key, Date.now());
}

function extractPhoneFromJid(jid: string) {
  const match = jid.match(/^(\d+)@/);
  return match ? `+${match[1]}` : null;
}

function hasMeaningfulContent(msg: any) {
  return !!msg?.message;
}

function isMessageTooOld(msg: any) {
  const timestamp = Number(msg?.messageTimestamp || 0) * 1000;
  if (!timestamp) return false;
  return Date.now() - timestamp > 60 * 1000;
}

export async function startWhatsAppSession(userId: string) {
  const { state, saveCreds } = await useMultiFileAuthState(`auth/${userId}`);
  const { version } = await fetchLatestBaileysVersion();

  const socket = makeWASocket({
    auth: state,
    version,
  });

  socket.ev.on('creds.update', saveCreds);

  socket.ev.on('messages.upsert', async ({ messages, type }: any) => {
    console.log('[MESSAGES UPSERT]', {
      userId,
      type,
      count: messages?.length || 0,
    });

    if (type !== 'notify') return;

    for (const msg of messages || []) {
      let processedKey: string | null = null;

      try {
        const rawJid = msg?.key?.remoteJid || '';
        const fromMe = !!msg?.key?.fromMe;
        const messageId = msg?.key?.id || '';
        const pushName = msg?.pushName || '';

        console.log('[DEBUG MESSAGE]', {
          userId,
          rawJid,
          fromMe,
          messageId,
          pushName,
        });

        if (!rawJid) continue;

        // IGNORA OUTBOUND
        if (fromMe) continue;

        // FILTROS
        if (
          rawJid === 'status@broadcast' ||
          rawJid.endsWith('@g.us') ||
          rawJid.endsWith('@broadcast') ||
          rawJid.endsWith('@lid') ||
          !rawJid.endsWith('@s.whatsapp.net')
        ) {
          continue;
        }

        if (!hasMeaningfulContent(msg)) continue;
        if (isMessageTooOld(msg)) continue;

        processedKey = buildProcessedMessageKey(userId, msg);

        if (
          processedKey &&
          (wasMessageProcessedRecently(processedKey) ||
            inFlightMessages.has(processedKey))
        ) {
          console.log('[IGNORADO DUPLICADA]', messageId);
          continue;
        }

        if (processedKey) inFlightMessages.add(processedKey);

        const phone = extractPhoneFromJid(rawJid);
        if (!phone) {
          if (processedKey) inFlightMessages.delete(processedKey);
          continue;
        }

        const name =
          typeof pushName === 'string' ? pushName.trim() : '';

        console.log('[ENVIANDO PARA CRM]', {
          userId,
          phone,
          name,
          messageId,
        });

        await sendInboundEvent(userId, phone, name);

        if (processedKey) {
          markMessageProcessed(processedKey);
          inFlightMessages.delete(processedKey);
        }

        console.log('[ENVIADO COM SUCESSO]', {
          userId,
          phone,
          name,
          messageId,
        });
      } catch (e: any) {
        if (processedKey) inFlightMessages.delete(processedKey);

        console.error('[ERRO ENVIO CRM]', {
          userId,
          error: e?.message || e,
        });
      }
    }
  });

  return socket;
}
