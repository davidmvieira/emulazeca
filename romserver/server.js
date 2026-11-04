const express = require('express');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');

const app           = express();
const UPLOAD_DIR    = '/data/uploads';
const ROOMS_FILE    = '/data/rooms.json';
const ROOM_TTL_MS   = 6 * 60 * 60 * 1000; // 6h

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let rooms = {};
try {
  if (fs.existsSync(ROOMS_FILE)) rooms = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
} catch { rooms = {}; }

const saveRooms = () => fs.writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2));

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.rom';
    const id  = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    cb(null, id + ext);
  },
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// Upload de ROM
app.post('/upload', upload.single('rom'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Arquivo não enviado' });
  res.json({
    romId: req.file.filename,
    url:   `/files/${req.file.filename}`,
    name:  req.file.originalname,
  });
});

// Cria uma sala atrelada a uma ROM já enviada
app.post('/rooms', (req, res) => {
  const { romId, romName } = req.body;
  if (!romId) return res.status(400).json({ error: 'romId obrigatório' });
  if (!fs.existsSync(path.join(UPLOAD_DIR, romId))) {
    return res.status(404).json({ error: 'ROM não encontrada' });
  }

  let gameId;
  do { gameId = Math.floor(1000 + Math.random() * 9000); } while (rooms[gameId]);

  rooms[gameId] = { romId, romName: romName || romId, createdAt: Date.now() };
  saveRooms();
  res.json({ gameId, romId, romName: rooms[gameId].romName });
});

// Consulta de sala (usada pelo cliente para baixar a ROM)
app.get('/rooms/:gameId', (req, res) => {
  const room = rooms[req.params.gameId];
  if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
  res.json({
    gameId:  req.params.gameId,
    romId:   room.romId,
    romName: room.romName,
    url:     `/files/${room.romId}`,
  });
});

// Arquivos estáticos (ROMs)
app.use('/files', express.static(UPLOAD_DIR));

// Limpeza periódica de salas antigas
setInterval(() => {
  const cutoff = Date.now() - ROOM_TTL_MS;
  let dirty = false;
  for (const id in rooms) {
    if (rooms[id].createdAt < cutoff) { delete rooms[id]; dirty = true; }
  }
  if (dirty) saveRooms();
}, 60 * 60 * 1000);

app.listen(4000, () => console.log('ROMSERVER on :4000'));