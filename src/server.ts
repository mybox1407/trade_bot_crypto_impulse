import { app } from './app';
import { startScheduler, stopScheduler } from './services/scheduler';

const port = Number(process.env.PORT) || 3002;

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`[${new Date().toISOString()}] Server started on port ${port}`);
  startScheduler();
});

function gracefulShutdown(signal: string) {
  console.log(`[${new Date().toISOString()}] Received ${signal}, shutting down gracefully...`);
  
  stopScheduler();
  
  server.close(() => {
    console.log(`[${new Date().toISOString()}] HTTP server closed`);
    process.exit(0);
  });

  setTimeout(() => {
    console.error(`[${new Date().toISOString()}] Forced shutdown after timeout`);
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
