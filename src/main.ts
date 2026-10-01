import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Trust reverse proxy (Cloudflare, Nginx, Render) for client IP detection
  const expressApp = app.getHttpAdapter().getInstance();
  if (expressApp && typeof expressApp.set === 'function') {
    expressApp.set('trust proxy', 1);
  }

  // Environment-aware CORS protection
  const isProd = process.env.NODE_ENV === 'production';
  const customOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().toLowerCase())
    .filter(Boolean);

  app.enableCors({
    origin: (origin, callback) => {
      // Allow non-browser requests (mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);

      if (!isProd) {
        return callback(null, true);
      }

      const lower = origin.toLowerCase();
      const isAllowedDomain =
        lower.endsWith('.skyrush.cc') ||
        lower === 'https://skyrush.cc' ||
        customOrigins.includes(lower);

      if (isAllowedDomain) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not permitted by SkyRush CORS policy`));
      }
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
    allowedHeaders: 'Content-Type, Accept, Authorization',
  });

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT') || 3000;
  
  // Bind to '0.0.0.0' for Render.com support
  await app.listen(port, '0.0.0.0');
  console.log(`Application is running on: ${await app.getUrl()}`);
}
bootstrap();
