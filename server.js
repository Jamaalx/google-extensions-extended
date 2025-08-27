const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware-uri de securitate
app.use(helmet());
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://zed-zen.com', 'chrome-extension://*'] 
    : ['http://localhost:*', 'chrome-extension://*'],
  credentials: true
}));

// Rate limiting global
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minute
  max: 100, // maxim 100 requests per IP per 15 minute
  message: {
    error: 'Prea multe cereri. Încearcă din nou în 15 minute.'
  }
});
app.use(globalLimiter);

// Parsare JSON
app.use(express.json({ limit: '10mb' }));

// Rute de bază
app.get('/', (req, res) => {
  res.json({
    message: 'ZedZen Review Assistant API',
    version: '1.0.0',
    status: 'active'
  });
});

// Ruta pentru verificarea stării serverului
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Importă rutele
const authRoutes = require('./routes/auth');
const reviewRoutes = require('./routes/reviews');
const subscriptionRoutes = require('./routes/subscriptions');
const businessRoutes = require('./routes/business');

// Folosește rutele
app.use('/api/auth', authRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/business', businessRoutes);

// Middleware pentru gestionarea erorilor
app.use((err, req, res, next) => {
  console.error('Error:', err);
  
  // Eroare de validare
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Date invalide',
      details: err.message
    });
  }
  
  // Eroare JWT
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      error: 'Token invalid'
    });
  }
  
  // Eroare generală
  res.status(500).json({
    error: 'Eroare internă de server',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Ceva nu a mers bine'
  });
});

// Gestionarea rutelor inexistente
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Ruta nu a fost găsită',
    message: `${req.method} ${req.originalUrl} nu există`
  });
});

// Pornirea serverului
app.listen(PORT, () => {
  console.log(`🚀 Serverul rulează pe portul ${PORT}`);
  console.log(`🌍 Accesează: http://localhost:${PORT}`);
  console.log(`📚 Health check: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Oprirea serverului...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Oprirea serverului...');
  process.exit(0);
});

module.exports = app;