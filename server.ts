import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Serve o build do Vite
app.use(express.static(path.join(__dirname, 'dist')));

// Endpoint que entrega a API key ao frontend em runtime
// (nunca vai para o bundle, so existe no servidor)
app.get('/api/config', (_req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY nao configurada no servidor' });
  }
  res.json({ apiKey });
});

// SPA fallback — todas as rotas retornam o index.html
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Gemini Live Hub rodando na porta ${PORT}`);
});
