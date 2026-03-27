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
  const url = `${CONFIG.SUPABASE_URL}/functions/v1/whatsapp-inbound-event`;

  console.log('[CHAMANDO EDGE FUNCTION]', { url, userId, phone, name: name || '(vazio)' });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Worker-Key': CONFIG.WORKER_KEY,
    },
    body: JSON.stringify({
      user_id: userId,
      phone,
      name,
    }),
  });

  const body = await response.text();

  if (!response.ok) {
    console.error('[EDGE FUNCTION ERRO]', {
      status: response.status,
      body,
    });
    throw new Error(`Edge function retornou ${response.status}: ${body}`);
  }

  let result: any;
  try {
    result = JSON.parse(body);
  } catch {
    result = { raw: body };
  }

  console.log('[EDGE FUNCTION OK]', result);
  return result;
}
