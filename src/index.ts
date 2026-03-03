import express from 'express';
import cors from 'cors';
import { CONFIG } from './config';
import { startSession, getSessionStatus, disconnectSession } from './whatsapp';

const app = express();

app.use(cors());
app.use(express.json());

function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${CONFIG.WORKER_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/session/start', authMiddleware, async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id é obrigatório' });

  try {
    const result = await startSession(user_id);
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/session/status/:userId', authMiddleware, (req, res) => {
  const userId = String(req.params.userId);
  const status = getSessionStatus(userId);
  res.json({ user_id: userId, status });
});

app.post('/session/disconnect', authMiddleware, async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id é obrigatório' });

  try {
    await disconnectSession(user_id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(CONFIG.PORT, () => {
  console.log(`Worker rodando na porta ${CONFIG.PORT}`);
});