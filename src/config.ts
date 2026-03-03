import dotenv from 'dotenv';
dotenv.config();

export const CONFIG = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  WORKER_TOKEN: process.env.WORKER_TOKEN || '',
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  WORKER_KEY: process.env.WORKER_KEY || '',
};

const required = ['WORKER_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'WORKER_KEY'] as const;

for (const key of required) {
  if (!CONFIG[key]) {
    console.error(`Variável ${key} não definida`);
    process.exit(1);
  }
}