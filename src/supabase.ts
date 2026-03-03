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
  name: string
) {
  try {
    const response = await fetch(
      `${CONFIG.SUPABASE_URL}/functions/v1/whatsapp-inbound-event`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Worker-Key': CONFIG.WORKER_KEY,
        },
        body: JSON.stringify({ user_id: userId, phone, name }),
      }
    );

    return await response.json();
  } catch (err) {
    console.error('Erro ao enviar evento inbound:', err);
  }
}