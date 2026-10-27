import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

import helmet from 'helmet';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Apply Helmet Security Headers (Defense-in-Depth against XSS, clickjacking, fingerprinting)
  const isProdEnv = process.env.NODE_ENV === 'production';
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: isProdEnv ? ["'self'"] : ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
          imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
          connectSrc: [
            "'self'",
            'https://skyrush.cc',
            'https://*.skyrush.cc',
            'https://engine.skyrush.cc',
            'wss://engine.skyrush.cc',
            ...(isProdEnv ? [] : ['http://localhost:*', 'ws://localhost:*', 'ws://127.0.0.1:*']),
          ],
          frameAncestors: ["'self'"],
          objectSrc: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  // Trust reverse proxy (Cloudflare, Nginx, Render) for client IP detection
  const expressApp = app.getHttpAdapter().getInstance();
  if (expressApp && typeof expressApp.set === 'function') {
    expressApp.set('trust proxy', 1);
  }

  // Global DTO Validation Pipe with strict Mass-Assignment protection
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true, // Strips unwhitelisted properties from requests
      forbidUnknownValues: false,
      stopAtFirstError: true,
    }),
  );

  // Environment-aware CORS protection
  const isProd = process.env.NODE_ENV === 'production';
  const customOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().toLowerCase())
    .filter(Boolean);

  const SKYRUSH_ORIGIN_REGEX = /^https:\/\/([a-z0-9-]+\.)?skyrush\.cc$/i;

  app.enableCors({
    origin: (origin, callback) => {
      // Allow non-browser requests (mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);

      if (!isProd) {
        return callback(null, true);
      }

      const lower = origin.toLowerCase();
      const isAllowedDomain =
        SKYRUSH_ORIGIN_REGEX.test(lower) ||
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
  
  // Enable graceful shutdown hooks for zero-downtime rolling updates & PM2 reload
  app.enableShutdownHooks();

  // Bind to '0.0.0.0' for Render.com support
  await app.listen(port, '0.0.0.0');
  console.log(`Application is running on: ${await app.getUrl()}`);
}
bootstrap();
