const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const UPLOAD_DIR = '/data/uploads';
const PORT = Number(process.env.PORT || 4000);
const pool = new Pool({
  host: process.env.PGHOST || 'host.docker.internal',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
});

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

pool.on('error', (error) => {
  console.error('Erro inesperado na conexão com PostgreSQL:', error);
});

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase() || '.rom';
    callback(null, `${crypto.randomBytes(16).toString('hex')}${extension}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 },
});

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

const asyncHandler = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

const hashPassword = (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
};

const verifyPassword = (password, storedHash) => {
  if (!storedHash) return !password;
  const [salt, expectedHex] = storedHash.split(':');
  if (!salt || !expectedHex || !/^[0-9a-f]{128}$/i.test(expectedHex)) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
};

const hashHostToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const getRoomId = (value) => (/^\d+$/.test(value) ? value : null);

const publicBaseUrl = (req) => {
  if (process.env.PUBLIC_ROMSERVER_URL) {
    return process.env.PUBLIC_ROMSERVER_URL.replace(/\/$/, '');
  }
  return `${req.protocol}://${req.get('host')}`;
};

app.get('/api/rooms', asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT id, room_name, rom_name, host_ip,
           password_hash IS NOT NULL AS requires_password, status
    FROM rooms
    WHERE status <> 'finished'
    ORDER BY created_at DESC
  `);
  res.json({ rooms: result.rows });
}));

app.post('/api/rooms', upload.single('rom'), asyncHandler(async (req, res) => {
  const roomName = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const hostIp = typeof req.body.host_ip === 'string' ? req.body.host_ip.trim() : '';
  if (!roomName || !hostIp || !req.file) {
    if (req.file) await fs.promises.unlink(req.file.path);
    return res.status(400).json({ error: 'name, host_ip e arquivo rom são obrigatórios' });
  }

  const hostToken = crypto.randomBytes(32).toString('hex');
  try {
    const result = await pool.query(`
      INSERT INTO rooms
        (room_name, rom_name, rom_filename, host_ip, password_hash, host_token_hash)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `, [
      roomName,
      req.file.originalname,
      req.file.filename,
      hostIp,
      password ? hashPassword(password) : null,
      hashHostToken(hostToken),
    ]);
    res.status(201).json({ roomId: result.rows[0].id, hostToken });
  } catch (error) {
    try {
      await fs.promises.unlink(req.file.path);
    } catch (cleanupError) {
      console.error('Não foi possível remover a ROM após falha ao criar sala:', cleanupError);
    }
    throw error;
  }
}));

app.post('/api/rooms/:id/join', asyncHandler(async (req, res) => {
  const roomId = getRoomId(req.params.id);
  if (!roomId) return res.status(400).json({ error: 'ID de sala inválido' });
  const result = await pool.query(`
    SELECT rom_filename, rom_name, password_hash, status
    FROM rooms
    WHERE id = $1
  `, [roomId]);
  const room = result.rows[0];
  if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
  if (room.status === 'finished' || room.status === 'kicked') {
    return res.status(409).json({ error: 'Esta sala não está disponível' });
  }

  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (room.password_hash && !verifyPassword(password, room.password_hash)) {
    return res.status(401).json({ error: 'Senha incorreta' });
  }

  res.json({
    rom_url: `${publicBaseUrl(req)}/files/${encodeURIComponent(room.rom_filename)}`,
    rom_name: room.rom_name,
  });
}));

app.post('/api/rooms/:id/kick', asyncHandler(async (req, res) => {
  const roomId = getRoomId(req.params.id);
  if (!roomId) return res.status(400).json({ error: 'ID de sala inválido' });
  const tokenMatch = /^Bearer ([0-9a-f]{64})$/i.exec(req.get('authorization') || '');
  if (!tokenMatch) return res.status(403).json({ error: 'Apenas o host pode ejetar jogadores' });

  const result = await pool.query(`
    UPDATE rooms
    SET status = 'kicked'
    WHERE id = $1 AND host_token_hash = $2 AND status <> 'finished'
    RETURNING id
  `, [roomId, hashHostToken(tokenMatch[1])]);
  if (!result.rowCount) {
    return res.status(403).json({ error: 'Token do host inválido ou sala inexistente' });
  }
  res.json({ status: 'kicked' });
}));

app.get('/api/rooms/:id/status', asyncHandler(async (req, res) => {
  const roomId = getRoomId(req.params.id);
  if (!roomId) return res.status(400).json({ error: 'ID de sala inválido' });
  const result = await pool.query('SELECT status FROM rooms WHERE id = $1', [roomId]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Sala não encontrada' });
  res.json({ status: result.rows[0].status });
}));

app.use('/files', express.static(UPLOAD_DIR, { index: false }));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error('Erro no romserver:', error);
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: error.message });
  }
  res.status(500).json({ error: 'Erro interno do servidor' });
});

async function startServer() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id BIGSERIAL PRIMARY KEY,
      room_name TEXT NOT NULL,
      rom_name TEXT NOT NULL,
      rom_filename TEXT NOT NULL,
      host_ip TEXT NOT NULL,
      password_hash TEXT,
      host_token_hash CHAR(64) NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  app.listen(PORT, () => console.log(`ROMSERVER on :${PORT}`));
}

startServer().catch((error) => {
  console.error('Não foi possível iniciar o romserver ou conectar ao PostgreSQL:', error);
  pool.end().catch((closeError) => {
    console.error('Não foi possível encerrar o pool PostgreSQL:', closeError);
  });
  process.exitCode = 1;
});
