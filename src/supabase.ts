import { createClient } from '@supabase/supabase-js';
import { CONFIG } from './config';

export const supabase = createClient(
  CONFIG.SUPABASE_URL,
  CONFIG.SUPABASE_SERVICE_ROLE_KEY
);

export async function upsertSession(
  userId: string,
  status: 'pending_qr' | 'connected' | 'disconnected',
  qr: string | null = null
) {
  const { error } = await supabase
    .from('whatsapp_sessions')
    .upsert(
      {
        user_id: userId,
        status,
        qr,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );

  if (error) {
    console.error('Erro ao gravar sessão:', error.message);
  } else {
    console.log(`Sessão atualizada: ${status}`);
  }
}

export async function sendInboundEvent(
  userId: string,
  phone: string,
  name: string,
  messageData?: {
    fromMe: boolean;
    pushName: string;
    messageId: string;
    remoteJid: string;
    timestamp: number | null;
  }
) {
  try {
    // (OPCIONAL) Salva a mensagem no histórico para análise futura
    if (messageData) {
      try {
        await supabase.from('whatsapp_messages').insert({
          user_id: userId,
          phone,
          contact_name: name,
          push_name: messageData.pushName,
          message_id: messageData.messageId,
          from_me: messageData.fromMe,
          remote_jid: messageData.remoteJid,
          timestamp: messageData.timestamp,
        });
        
        console.log('[MENSAGEM SALVA NO HISTORICO]', {
          phone,
          name,
          fromMe: messageData.fromMe,
        });
      } catch (historyError: any) {
        // Se a tabela não existir ainda, apenas loga mas não falha
        console.log('[AVISO] Erro ao salvar histórico (tabela pode não existir ainda):', historyError.message);
      }
    }

    // Envia para a edge function criar/atualizar o cliente
    const response = await fetch(
      `${CONFIG.SUPABASE_URL}/functions/v1/whatsapp-inbound-event`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Worker-Key': CONFIG.WORKER_KEY,
        },
        body: JSON.stringify({ 
          user_id: userId, 
          phone, 
          name,
          from_me: messageData?.fromMe || false,
          message_id: messageData?.messageId,
          timestamp: messageData?.timestamp,
        }),
      }
    );

    const result = await response.json();
    
    console.log('[RESPOSTA DA EDGE FUNCTION]', result);
    
    return result;
  } catch (err: any) {
    console.error('[ERRO AO ENVIAR EVENTO INBOUND]', err?.message || err);
    throw err;
  }
}
